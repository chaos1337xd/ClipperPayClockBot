require('dotenv').config();
const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const db = require('./db');
const scheduler = require('./scheduler');
const schedule = require('./schedule');
const { formatDuration, escapeHtml, nameTag } = require('./format');

const HTML = { parse_mode: 'HTML' };

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : null;
const DAILY_REPORT_CRON = process.env.DAILY_REPORT_CRON || '0 0 * * *';
const WEEKLY_REPORT_CRON = process.env.WEEKLY_REPORT_CRON || '0 0 * * 1';
const TZ = process.env.TZ || 'Europe/Stockholm';
const MAX_SHIFT_HOURS = Number(process.env.MAX_SHIFT_HOURS || 12);
const LONG_SHIFT_CHECK_CRON = process.env.LONG_SHIFT_CHECK_CRON || '*/15 * * * *';
const SHIFT_START_REMINDER_MINUTES = Number(process.env.SHIFT_START_REMINDER_MINUTES || 30);
const SCHEDULE_REMINDER_CRON = process.env.SCHEDULE_REMINDER_CRON || '*/5 * * * *';

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN env var.');
  process.exit(1);
}
if (!ADMIN_ID) {
  console.warn('Warning: ADMIN_ID not set — reports and admin commands will have no recipient/authorized user.');
}

const bot = new Telegraf(BOT_TOKEN);

// Fetched once in main() via getMe() — used to point clippers at the right
// chat when they run /clockin in the group instead of DMing the bot.
let botUsername = null;

function displayNameOf(from) {
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(from.id);
}

function fromTag(from) {
  return nameTag({ username: from.username, display_name: displayNameOf(from) });
}

function fmtLocal(date) {
  return new Date(date).toLocaleString('en-US', { timeZone: TZ });
}

function fmtTime(date) {
  return new Date(date).toLocaleTimeString('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}

function getArgs(ctx) {
  return (ctx.message.text || '').trim().split(/\s+/).slice(1);
}

function getRepliedUser(ctx) {
  return ctx.message.reply_to_message ? ctx.message.reply_to_message.from : null;
}

// Resolves a command's target clipper from a reply-to-message or a
// @username argument. Returns { userId, username } or null if neither
// was given (caller should fall back to the command sender).
function resolveTargetFromArgsOrReply(ctx) {
  const replied = getRepliedUser(ctx);
  if (replied) {
    return { userId: replied.id, username: replied.username || null };
  }
  const args = getArgs(ctx);
  if (args.length > 0) {
    return { userId: null, username: args[0].replace(/^@/, '') };
  }
  return null;
}

async function findOpenShiftForTarget(target) {
  if (target.userId) return db.getOpenShift(target.userId);
  if (target.username) return db.getOpenShiftByUsername(target.username);
  return null;
}

// Like findOpenShiftForTarget, but falls back to the most recent completed
// shift if there's no open one — used by /checkins so it still works right
// after someone clocks out.
async function findAnyShiftForTarget(target) {
  if (target.userId) {
    return (await db.getOpenShift(target.userId)) || (await db.getUserShiftHistory(target.userId, 1))[0] || null;
  }
  if (target.username) {
    return await db.getMostRecentShiftByUsername(target.username);
  }
  return null;
}

// Everyone on the main rota (vacant slots have no id). While an event is
// live, only these people may use the regular /clockin.
const rosterUserIds = new Set(
  Object.values(schedule.ROSTER)
    .map((p) => p.userId)
    .filter(Boolean)
);

function isAdmin(ctx) {
  return Boolean(ADMIN_ID) && ctx.from.id === ADMIN_ID;
}

async function notifyAdmin(text) {
  if (!ADMIN_ID) return;
  try {
    await bot.telegram.sendMessage(ADMIN_ID, text, HTML);
  } catch (e) {
    console.error('Failed to DM admin', e);
  }
}

bot.command('clockin', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    const link = botUsername ? ` (@${botUsername})` : '';
    return ctx.reply(`Clock in over DM, not here — message me${link} privately and run /clockin there.`);
  }
  const userId = ctx.from.id;
  const existing = await db.getOpenShift(userId);
  if (existing) {
    return ctx.reply(`You're already clocked in (since <b>${fmtLocal(existing.clock_in)}</b>).`, HTML);
  }
  // While an event is live the regular clock-in is roster-only; anyone else
  // is an extra and has their own flow (and their hours go in their own table).
  if (!rosterUserIds.has(userId) && (await db.getActiveEvent())) {
    return ctx.reply("An event is live and /clockin is for the main roster only — if you're an extra, use /extraclockin.");
  }
  let shift;
  try {
    shift = await db.createShift(userId, ctx.from.username || null, displayNameOf(ctx.from), ctx.chat.id);
  } catch (e) {
    if (e.code === '23505') {
      // Lost a race with a near-simultaneous /clockin (double-tap, a
      // retried update) — the DB's unique index caught it, so just report
      // whichever shift won.
      const raceShift = await db.getOpenShift(userId);
      if (raceShift) {
        return ctx.reply(`You're already clocked in (since <b>${fmtLocal(raceShift.clock_in)}</b>).`, HTML);
      }
    }
    throw e;
  }
  await scheduler.startShiftChecks(bot, shift);
  await ctx.reply(
    `✅ ${fromTag(ctx.from)} clocked in. Status checks every <b>${scheduler.CHECKIN_INTERVAL_MS / 60000}</b> min — tap the button when prompted.`,
    HTML
  );
  if (userId !== ADMIN_ID) {
    await notifyAdmin(`✅ ${fromTag(ctx.from)} clocked in (<b>${fmtLocal(shift.clock_in)}</b>).`);
  }
});

bot.command('clockout', async (ctx) => {
  const userId = ctx.from.id;
  const shift = await db.getOpenShift(userId);
  if (!shift) {
    return ctx.reply("You're not currently clocked in.");
  }
  scheduler.stopShiftChecks(shift.id);
  await db.expirePendingCheckinsForShift(shift.id);
  const closed = await db.closeShift(shift.id);
  const seconds = (new Date(closed.clock_out) - new Date(closed.clock_in)) / 1000;
  await ctx.reply(`🛑 ${fromTag(ctx.from)} clocked out. Shift length: <b>${formatDuration(seconds)}</b>.`, HTML);
  if (userId !== ADMIN_ID) {
    await notifyAdmin(`🛑 ${fromTag(ctx.from)} clocked out. Shift length: <b>${formatDuration(seconds)}</b>.`);
  }
});

bot.command('checknow', async (ctx) => {
  if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) {
    return ctx.reply('This command is admin-only.');
  }
  const target = resolveTargetFromArgsOrReply(ctx);
  if (!target) {
    return ctx.reply('Usage: reply to the clipper\'s message with /checknow, or /checknow @username');
  }
  // A person is on a main shift or an extra one, never both (clock-in blocks it).
  let shift = await findOpenShiftForTarget(target);
  let kind = 'main';
  if (!shift) {
    shift = await findOpenExtraShiftForTarget(target);
    kind = 'extra';
  }
  if (!shift) {
    return ctx.reply("Couldn't find an active shift for that clipper.");
  }
  try {
    await scheduler.sendCheckin(bot, shift, kind);
  } catch (e) {
    console.error('Manual check-in trigger failed', e);
    await ctx.reply('Failed to send the status check — check the logs.');
  }
});

bot.command('forceclockout', async (ctx) => {
  if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) {
    return ctx.reply('This command is admin-only.');
  }
  const target = resolveTargetFromArgsOrReply(ctx);
  if (!target) {
    return ctx.reply('Usage: reply to the clipper\'s message with /forceclockout, or /forceclockout @username');
  }
  const shift = await findOpenShiftForTarget(target);
  if (!shift) {
    return ctx.reply("Couldn't find an active shift for that clipper.");
  }
  scheduler.stopShiftChecks(shift.id);
  await db.expirePendingCheckinsForShift(shift.id);
  const closed = await db.closeShift(shift.id);
  const seconds = (new Date(closed.clock_out) - new Date(closed.clock_in)) / 1000;
  await ctx.reply(`🛑 ${nameTag(shift)} force-clocked out by admin. Shift length: <b>${formatDuration(seconds)}</b>.`, HTML);
});

bot.command('status', async (ctx) => {
  const target = resolveTargetFromArgsOrReply(ctx);

  if (!target) {
    const shift = await db.getOpenShift(ctx.from.id);
    if (!shift) return ctx.reply("You're not currently clocked in.");
    const seconds = (Date.now() - new Date(shift.clock_in).getTime()) / 1000;
    return ctx.reply(`You've been clocked in for <b>${formatDuration(seconds)}</b> (since ${fmtLocal(shift.clock_in)}).`, HTML);
  }

  const shift = await findOpenShiftForTarget(target);
  if (!shift) {
    return ctx.reply("That clipper isn't currently clocked in.");
  }
  const seconds = (Date.now() - new Date(shift.clock_in).getTime()) / 1000;
  await ctx.reply(`${nameTag(shift)} has been clocked in for <b>${formatDuration(seconds)}</b> (since ${fmtLocal(shift.clock_in)}).`, HTML);
});

bot.command('whosonshift', async (ctx) => {
  const open = await db.getAllOpenShifts();
  const openByUserId = new Map(open.map((s) => [s.user_id, s]));

  const lines = [];
  if (open.length === 0) {
    lines.push('Nobody is currently clocked in.');
  } else {
    lines.push('<b>Currently on shift</b>');
    for (const s of open) {
      const seconds = (Date.now() - new Date(s.clock_in).getTime()) / 1000;
      lines.push(`• ${nameTag(s)} — <b>${formatDuration(seconds)}</b>`);
    }
  }

  const scheduled = schedule.getScheduledNow();
  if (scheduled.length > 0) {
    lines.push('');
    lines.push('<b>Scheduled now</b>');
    for (const entry of scheduled) {
      if (!entry.username) {
        lines.push('🕳 Vacant');
        continue;
      }
      const isOn = openByUserId.has(entry.userId);
      lines.push(`${isOn ? '✅' : '⚠️'} @${escapeHtml(entry.username)}${isOn ? '' : ' — not clocked in'}`);
    }
  }

  await ctx.reply(lines.join('\n'), HTML);
});

// Shared by /schedule and /tomorrow. DM-only because the roster is
// rendered as @mentions, which would ping everyone listed if run in a group.
async function replyWithSchedule(ctx, date, titlePrefix) {
  if (ctx.chat.type !== 'private') {
    const link = botUsername ? ` (@${botUsername})` : '';
    return ctx.reply(`Run this one in DM, not here — it @mentions the whole roster. Message me${link} privately.`);
  }
  const { dayName, weekParity, entries } = schedule.getScheduleForCetDate(date);
  if (entries.length === 0) {
    return ctx.reply(`No one scheduled for <b>${dayName}</b> (week ${weekParity}). Times are CET.`, HTML);
  }
  const lines = entries.map((e) => {
    const nextDay = e.endHour > 24 ? ' (+1d)' : '';
    return `${padHour(e.startHour)}–${padHour(e.endHour)}${nextDay} · ${e.username ? '@' + escapeHtml(e.username) : 'Vacant'}`;
  });
  await ctx.reply(`<b>${titlePrefix} — ${dayName} (week ${weekParity}) · CET</b>\n${lines.join('\n')}`, HTML);
}

bot.command('schedule', (ctx) => replyWithSchedule(ctx, new Date(), 'Schedule'));

// Fixed CET has no DST, so now + 24h is always the same wall-clock time
// tomorrow in CET.
bot.command('tomorrow', (ctx) =>
  replyWithSchedule(ctx, new Date(Date.now() + 24 * 60 * 60 * 1000), "Tomorrow's schedule")
);

bot.command('whensmynextshift', async (ctx) => {
  const result = schedule.getNextShiftForUser(ctx.from.id);

  if (result.status === 'none') {
    return ctx.reply("You're not on the roster, so there's no schedule for you.");
  }
  if (result.status === 'now') {
    return ctx.reply(
      `You're scheduled right now — until <b>${padHour(result.entry.endHour)} CET</b>. Clock in if you haven't!`,
      HTML
    );
  }

  const secondsUntil = (result.start.getTime() - Date.now()) / 1000;
  const nextDay = result.endHour > 24 ? ' (+1d)' : '';
  await ctx.reply(
    `Your next shift starts in <b>${formatDuration(secondsUntil)}</b> — <b>${padHour(result.startHour)}–${padHour(result.endHour)}${nextDay} CET</b>.`,
    HTML
  );
});

bot.command('myhistory', async (ctx) => {
  const shifts = await db.getUserShiftHistory(ctx.from.id, 10);
  if (shifts.length === 0) {
    return ctx.reply("No completed shifts on record yet.");
  }
  const lines = shifts.map((s) => {
    const seconds = (new Date(s.clock_out) - new Date(s.clock_in)) / 1000;
    return `• ${fmtLocal(s.clock_in)} — <b>${formatDuration(seconds)}</b>`;
  });
  await ctx.reply(`Your last ${shifts.length} shift(s):\n${lines.join('\n')}`, HTML);
});

bot.command('checkins', async (ctx) => {
  if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) {
    return ctx.reply('This command is admin-only.');
  }
  const target = resolveTargetFromArgsOrReply(ctx);
  const shift = target ? await findAnyShiftForTarget(target) : await findAnyShiftForTarget({ userId: ctx.from.id });
  if (!shift) {
    return ctx.reply("No shifts on record for that clipper.");
  }
  const checkins = await db.getCheckinsForShift(shift.id);
  const shiftLabel = shift.clock_out
    ? `shift ${fmtLocal(shift.clock_in)} – ${fmtLocal(shift.clock_out)}`
    : `current shift (started ${fmtLocal(shift.clock_in)})`;

  if (checkins.length === 0) {
    return ctx.reply(`No status checks recorded yet for ${nameTag(shift)}'s ${shiftLabel}.`, HTML);
  }

  const icon = { confirmed: '✅', missed: '❌', pending: '⏳' };
  const lines = checkins.map((c) => `${icon[c.status] || '•'} ${fmtTime(c.sent_at)}${c.status === 'confirmed' ? ` (confirmed ${fmtTime(c.responded_at)})` : ''}`);
  await ctx.reply(`${nameTag(shift)} — ${shiftLabel}:\n${lines.join('\n')}`, HTML);
});

bot.command('report', async (ctx) => {
  if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) {
    return ctx.reply("This command is admin-only.");
  }
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const report = await buildReportText(since.toISOString(), 'Daily');
  await ctx.reply(report, HTML);
});

bot.command('weeklyreport', async (ctx) => {
  if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) {
    return ctx.reply("This command is admin-only.");
  }
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const report = await buildReportText(since.toISOString(), 'Weekly');
  await ctx.reply(report, HTML);
});

bot.command('monthlyreport', async (ctx) => {
  if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) {
    return ctx.reply("This command is admin-only.");
  }
  // Rolling 30 days, same approach as the weekly report.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const report = await buildReportText(since.toISOString(), 'Monthly (30d)');
  await ctx.reply(report, HTML);
});

// ---- Events / extras ----------------------------------------------------
// People who aren't on the main roster clock in against a live event. Kept
// separate from the main shift flow (own tables, own commands), so they
// never show in /whosonshift or the daily/weekly reports — but they get
// the same status-check pings, via the shared scheduler (kind 'extra').

// Plain bold name (no @) so event lists never ping anyone, even when the
// admin runs them in a group.
function plainName(row) {
  return `<b>${escapeHtml(row.display_name || row.username || row.user_id)}</b>`;
}

function secondsSince(date) {
  return (Date.now() - new Date(date).getTime()) / 1000;
}

// Stops an extra's status checks and marks any check-in still waiting on an
// answer as missed — same as what /clockout does for a main shift.
async function wrapUpExtraChecks(shiftId) {
  scheduler.stopShiftChecks(shiftId, 'extra');
  await db.expirePendingExtraCheckinsForShift(shiftId);
}

async function findOpenExtraShiftForTarget(target) {
  if (target.userId) return db.getOpenExtraShift(target.userId);
  if (target.username) return db.getOpenExtraShiftByUsername(target.username);
  return null;
}

async function buildEventReportText(event) {
  const rows = await db.getEventReportData(event.id);
  const status = event.ended_at ? `ended ${fmtLocal(event.ended_at)}` : 'live';
  const header = `<b>🎪 ${escapeHtml(event.name)}</b> — ${status}\nStarted ${fmtLocal(event.started_at)}`;
  if (rows.length === 0) return `${header}\nNo extras have clocked in.`;

  const total = rows.reduce((sum, r) => sum + Number(r.seconds_worked), 0);
  const lines = rows.map(
    (r) =>
      `• ${plainName(r)}: <b>${formatDuration(Number(r.seconds_worked))}</b> (${r.shifts_count} shift${Number(r.shifts_count) === 1 ? '' : 's'}) · ${r.confirmed_checkins} confirmed / ${r.missed_checkins} missed`
  );
  return `${header}\n${lines.join('\n')}\n\nTotal: <b>${formatDuration(total)}</b> across ${rows.length} extra${rows.length === 1 ? '' : 's'}`;
}

bot.command('eventstart', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('This command is admin-only.');
  const name = getArgs(ctx).join(' ').trim();
  if (!name) return ctx.reply('Usage: /eventstart <event name>');

  let event;
  try {
    event = await db.createEvent(name, ctx.from.id);
  } catch (e) {
    if (e.code === '23505') {
      const live = await db.getActiveEvent();
      return ctx.reply(
        `An event is already running: <b>${escapeHtml(live?.name ?? '?')}</b>. Run /eventend first.`,
        HTML
      );
    }
    throw e;
  }
  const link = botUsername ? ` @${botUsername}` : ' me';
  await ctx.reply(
    `🎪 Event <b>${escapeHtml(event.name)}</b> started. Extras can DM${link} <code>/extraclockin</code>.`,
    HTML
  );
});

bot.command('eventend', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('This command is admin-only.');
  const live = await db.getActiveEvent();
  if (!live) return ctx.reply('No event is running.');

  // End the event first: createExtraShift only inserts while an event is
  // live, so nobody can slip in a shift after this point.
  const ended = await db.endEvent(live.id);
  if (!ended) return ctx.reply('That event was already ended.');
  const closed = await db.closeAllOpenExtraShifts(ended.id);

  for (const s of closed) {
    await wrapUpExtraChecks(s.id);
    const seconds = (new Date(s.clock_out) - new Date(s.clock_in)) / 1000;
    try {
      await bot.telegram.sendMessage(
        s.user_id,
        `🛑 <b>${escapeHtml(ended.name)}</b> has ended — you've been clocked out. Shift length: <b>${formatDuration(seconds)}</b>.`,
        HTML
      );
    } catch (e) {
      console.error(`Failed to DM extra ${s.user_id} about event end`, e);
    }
  }

  const stillIn = closed.length ? `Clocked out ${closed.length} still on shift.\n\n` : '';
  await ctx.reply(`🏁 Event ended. ${stillIn}${await buildEventReportText(ended)}`, HTML);
});

bot.command('extras', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('This command is admin-only.');
  const event = (await db.getActiveEvent()) || (await db.getLatestEvent());
  if (!event) return ctx.reply('No events yet. Start one with /eventstart <name>.');

  const open = await db.getOpenExtraShiftsForEvent(event.id);
  const head = `<b>🎪 ${escapeHtml(event.name)}</b> — ${event.ended_at ? 'ended' : 'live'}`;
  if (open.length === 0) {
    return ctx.reply(`${head}\nNobody's clocked in right now. /eventreport for totals.`, HTML);
  }
  const lines = open.map((s) => `🟢 ${plainName(s)} — <b>${formatDuration(secondsSince(s.clock_in))}</b>`);
  await ctx.reply(`${head}\n${lines.join('\n')}\n\n${open.length} clocked in. /eventreport for totals.`, HTML);
});

bot.command('eventreport', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('This command is admin-only.');
  const event = (await db.getActiveEvent()) || (await db.getLatestEvent());
  if (!event) return ctx.reply('No events yet. Start one with /eventstart <name>.');
  await ctx.reply(await buildEventReportText(event), HTML);
});

bot.command('extraforceclockout', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('This command is admin-only.');
  const target = resolveTargetFromArgsOrReply(ctx);
  if (!target) {
    return ctx.reply("Usage: reply to the extra's message with /extraforceclockout, or /extraforceclockout @username");
  }
  const shift = await findOpenExtraShiftForTarget(target);
  if (!shift) return ctx.reply("Couldn't find an extra clocked in for that person.");

  await wrapUpExtraChecks(shift.id);
  const closed = await db.closeExtraShift(shift.id);
  if (!closed) return ctx.reply('They were already clocked out.');
  const seconds = (new Date(closed.clock_out) - new Date(closed.clock_in)) / 1000;
  await ctx.reply(`🛑 ${plainName(shift)} force-clocked out. Shift length: <b>${formatDuration(seconds)}</b>.`, HTML);
});

bot.command('extraclockin', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    const link = botUsername ? ` (@${botUsername})` : '';
    return ctx.reply(`Clock in over DM, not here — message me${link} privately and run /extraclockin there.`);
  }
  const userId = ctx.from.id;

  if (rosterUserIds.has(userId)) {
    return ctx.reply("You're on the main roster — use /clockin for your normal shift.");
  }
  if (await db.getOpenShift(userId)) {
    return ctx.reply("You're clocked in on a main shift — /clockout first.");
  }
  const already = await db.getOpenExtraShift(userId);
  if (already) {
    return ctx.reply(`You're already clocked in (since <b>${fmtLocal(already.clock_in)}</b>).`, HTML);
  }

  let shift;
  try {
    shift = await db.createExtraShift(userId, ctx.from.username || null, displayNameOf(ctx.from), ctx.chat.id);
  } catch (e) {
    if (e.code === '23505') {
      // Double-tap / retried update: the unique index caught it.
      const raced = await db.getOpenExtraShift(userId);
      if (raced) {
        return ctx.reply(`You're already clocked in (since <b>${fmtLocal(raced.clock_in)}</b>).`, HTML);
      }
    }
    throw e;
  }
  if (!shift) return ctx.reply('No event is running right now.');

  await scheduler.startShiftChecks(bot, shift, 'extra');

  const event = await db.getEventById(shift.event_id);
  await ctx.reply(
    `✅ ${fromTag(ctx.from)} clocked in for <b>${escapeHtml(event?.name ?? 'the event')}</b>. Status checks every <b>${scheduler.CHECKIN_INTERVAL_MS / 60000}</b> min — tap the button when prompted.`,
    HTML
  );
  if (userId !== ADMIN_ID) {
    await notifyAdmin(`🎪 ${fromTag(ctx.from)} clocked in as an extra (<b>${escapeHtml(event?.name ?? 'event')}</b>).`);
  }
});

bot.command('extraclockout', async (ctx) => {
  const userId = ctx.from.id;
  const shift = await db.getOpenExtraShift(userId);
  if (!shift) return ctx.reply("You're not clocked in as an extra.");

  await wrapUpExtraChecks(shift.id);
  const closed = await db.closeExtraShift(shift.id);
  if (!closed) return ctx.reply("You're not clocked in as an extra.");
  const seconds = (new Date(closed.clock_out) - new Date(closed.clock_in)) / 1000;
  await ctx.reply(`🛑 ${fromTag(ctx.from)} clocked out. Shift length: <b>${formatDuration(seconds)}</b>.`, HTML);
  if (userId !== ADMIN_ID) {
    await notifyAdmin(`🛑 ${fromTag(ctx.from)} clocked out as an extra. Shift length: <b>${formatDuration(seconds)}</b>.`);
  }
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    [
      '<b>Payclock commands:</b>',
      '<code>/clockin</code> — start your shift',
      '<code>/clockout</code> — end your shift',
      '<code>/status [@user]</code> — see your (or their) current shift length',
      '<code>/whosonshift</code> — see who is currently clocked in',
      '<code>/schedule</code> — see today\'s roster',
      '<code>/tomorrow</code> — see tomorrow\'s roster',
      '<code>/whensmynextshift</code> — see how long until your next scheduled shift',
      '<code>/myhistory</code> — see your last 10 completed shifts',
      ADMIN_ID ? '<code>/checkins [@user]</code> — (admin) see status-check timestamps for a shift' : null,
      ADMIN_ID ? '<code>/report</code> — (admin) get an on-demand daily report' : null,
      ADMIN_ID ? '<code>/weeklyreport</code> — (admin) get an on-demand weekly report' : null,
      ADMIN_ID ? '<code>/monthlyreport</code> — (admin) get the trailing-30-days report' : null,
      ADMIN_ID ? '<code>/forceclockout @user</code> — (admin) clock someone out, reply to their message also works' : null,
      ADMIN_ID ? '<code>/checknow @user</code> — (admin) send an immediate status check, reply to their message also works' : null,
      '<code>/extraclockin</code> / <code>/extraclockout</code> — clock in/out as an extra during an event (DM)',
      ADMIN_ID ? '<code>/eventstart &lt;name&gt;</code> — (admin) open an event so extras can clock in' : null,
      ADMIN_ID ? '<code>/eventend</code> — (admin) end the event, clock out anyone left, show totals' : null,
      ADMIN_ID ? '<code>/extras</code> — (admin) who\'s clocked in right now' : null,
      ADMIN_ID ? '<code>/eventreport</code> — (admin) per-extra hours for the live/latest event' : null,
      ADMIN_ID ? '<code>/extraforceclockout @user</code> — (admin) clock an extra out' : null,
    ]
      .filter(Boolean)
      .join('\n'),
    HTML
  );
});

// Button callbacks are `<prefix>:<checkinId>`; the prefix says which table
// the check-in lives in (main roster vs event extras).
const CHECKIN_CALLBACKS = {
  checkin: {
    getCheckin: db.getCheckin,
    getShift: (checkin) => db.getShiftById(checkin.shift_id),
    confirm: db.confirmCheckin,
  },
  xcheckin: {
    getCheckin: db.getExtraCheckin,
    getShift: (checkin) => db.getExtraShiftById(checkin.extra_shift_id),
    confirm: db.confirmExtraCheckin,
  },
};

bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data || '';
  const [prefix, idPart] = data.split(':');
  const handler = CHECKIN_CALLBACKS[prefix];
  if (!handler) return ctx.answerCbQuery();

  if (idPart === 'pending') {
    return ctx.answerCbQuery('Give it a second and try again.');
  }

  const checkinId = Number(idPart);
  const checkin = await handler.getCheckin(checkinId);
  if (!checkin) return ctx.answerCbQuery('Check-in not found.');

  const shift = await handler.getShift(checkin);
  if (!shift) return ctx.answerCbQuery('Check-in not found.');

  if (ctx.from.id !== shift.user_id) {
    return ctx.answerCbQuery('This check-in is not for you.');
  }

  if (checkin.status !== 'pending') {
    return ctx.answerCbQuery(`Already ${checkin.status}.`);
  }

  const confirmed = await handler.confirm(checkinId);
  if (!confirmed) {
    return ctx.answerCbQuery('Too late — this check-in already expired.');
  }

  try {
    await ctx.editMessageText(`✅ ${nameTag(shift)} confirmed presence.`, HTML);
  } catch (e) {
    console.error('Failed to edit confirmed check-in message', checkinId, e);
  }
  await ctx.answerCbQuery("Confirmed, thanks!");
});

async function buildReportText(sinceIso, label) {
  const rows = await db.getDailyReportData(sinceIso);
  if (rows.length === 0) {
    return `<b>📊 ${label} payclock report</b>\nNo shifts recorded in this period.`;
  }
  const lines = rows.map((r) => {
    const hours = formatDuration(Number(r.seconds_worked));
    return `• <b>${escapeHtml(r.name)}</b>: <b>${hours}</b> worked, ${r.shifts_count} shift(s), ${r.confirmed_checkins} confirmed / ${r.missed_checkins} missed check-ins`;
  });
  return `<b>📊 ${label} payclock report</b>\n${lines.join('\n')}`;
}

async function checkLongRunningShifts() {
  if (!ADMIN_ID) return;
  const thresholdSeconds = MAX_SHIFT_HOURS * 60 * 60;
  const longShifts = await db.getLongRunningUnwarnedShifts(thresholdSeconds);
  for (const shift of longShifts) {
    const seconds = (Date.now() - new Date(shift.clock_in).getTime()) / 1000;
    try {
      await bot.telegram.sendMessage(
        ADMIN_ID,
        `⚠️ ${nameTag(shift)} has been clocked in for <b>${formatDuration(seconds)}</b> (since ${fmtLocal(shift.clock_in)}) — might have forgotten to clock out.`,
        HTML
      );
    } catch (e) {
      console.error('Failed to send long-shift warning', e);
    }
    await db.markShiftWarned(shift.id);
  }
}

function padHour(h) {
  return `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`;
}

// Dedup is claimed in the database (db.claimScheduleReminder) rather than
// kept in memory — an in-memory Set resets on every restart, so a restart
// landing inside the same check window as an already-sent reminder would
// resend it. A DB claim survives restarts: whichever process (this one, or
// the one before a crash) claims an occurrence first is the only one that
// ever sends it.
async function checkScheduleReminders() {
  const now = new Date();
  const occurrences = schedule.getBlockOccurrencesAround(now);

  for (const occ of occurrences) {
    if (!occ.userId) continue; // vacant slot — nobody to remind
    const startDeltaMin = (occ.start.getTime() - now.getTime()) / 60000;
    if (startDeltaMin <= SHIFT_START_REMINDER_MINUTES && startDeltaMin > SHIFT_START_REMINDER_MINUTES - 6) {
      const claimed = await db.claimScheduleReminder(occ.username, occ.start, 'start');
      if (claimed) {
        try {
          await bot.telegram.sendMessage(
            occ.userId,
            `⏰ You're scheduled on shift in ~${SHIFT_START_REMINDER_MINUTES} min — <b>${padHour(occ.startHour)}–${padHour(occ.endHour)} CET</b>. Don't forget to <code>/clockin</code> when you start!`,
            HTML
          );
        } catch (e) {
          console.error(`Failed to send start reminder to @${occ.username}`, e);
        }
      }
    }

    const endDeltaMin = (occ.end.getTime() - now.getTime()) / 60000;
    if (endDeltaMin <= 0 && endDeltaMin > -6) {
      const claimed = await db.claimScheduleReminder(occ.username, occ.end, 'end');
      if (claimed) {
        const stillClockedIn = await db.getOpenShift(occ.userId);
        if (stillClockedIn) {
          try {
            await bot.telegram.sendMessage(
              occ.userId,
              `🛑 Your scheduled shift (<b>${padHour(occ.startHour)}–${padHour(occ.endHour)} CET</b>) just wrapped up. Don't forget to <code>/clockout</code>!`,
              HTML
            );
          } catch (e) {
            console.error(`Failed to send end reminder to @${occ.username}`, e);
          }
        }
      }
    }
  }
}

async function resumeActiveShifts() {
  const open = await db.getAllOpenShifts();
  for (const shift of open) {
    await scheduler.startShiftChecks(bot, shift);
  }
  console.log(`Resumed check-in scheduling for ${open.length} active shift(s).`);

  // any check-ins left pending from before a restart are stale — expire them
  const pending = await db.getPendingCheckins();
  for (const c of pending) {
    await db.expireCheckin(c.id);
  }

  // Same for event extras still clocked in across a restart.
  const openExtras = await db.getAllOpenExtraShifts();
  for (const shift of openExtras) {
    await scheduler.startShiftChecks(bot, shift, 'extra');
  }
  if (openExtras.length) {
    console.log(`Resumed check-in scheduling for ${openExtras.length} active extra shift(s).`);
  }
  const pendingExtras = await db.getPendingExtraCheckins();
  for (const c of pendingExtras) {
    await db.expireExtraCheckin(c.id);
  }

  return open.length + openExtras.length;
}

// On redeploy, Telegram can take a few seconds after the old container
// stops polling before it actually releases the getUpdates lock — if
// Railway spins up the new container faster than that, launch() gets a
// 409 Conflict. Retrying with a delay rides out that window instead of
// treating it as fatal, which previously caused a crash-restart-crash
// loop tight enough to burn through Railway's restart budget during what
// should've been an ordinary deploy.
async function launchWithRetry(maxAttempts = 6, delayMs = 10000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await bot.launch();
      return;
    } catch (e) {
      const isConflict = e?.response?.error_code === 409;
      if (isConflict && attempt < maxAttempts) {
        console.warn(`getUpdates conflict on launch (attempt ${attempt}/${maxAttempts}) — retrying in ${delayMs / 1000}s`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw e;
    }
  }
}

async function main() {
  await db.init();
  const resumedCount = await resumeActiveShifts();

  try {
    const me = await bot.telegram.getMe();
    botUsername = me.username;
  } catch (e) {
    console.warn('Could not fetch bot username via getMe()', e);
  }

  if (ADMIN_ID) {
    cron.schedule(
      DAILY_REPORT_CRON,
      async () => {
        try {
          const since = new Date();
          since.setHours(0, 0, 0, 0);
          const text = await buildReportText(since.toISOString(), 'Daily');
          await bot.telegram.sendMessage(ADMIN_ID, text, HTML);
        } catch (e) {
          console.error('Failed to send daily report', e);
        }
      },
      { timezone: TZ }
    );
    console.log(`Daily report scheduled: "${DAILY_REPORT_CRON}" (${TZ})`);

    cron.schedule(
      WEEKLY_REPORT_CRON,
      async () => {
        try {
          const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          const text = await buildReportText(since.toISOString(), 'Weekly');
          await bot.telegram.sendMessage(ADMIN_ID, text, HTML);
        } catch (e) {
          console.error('Failed to send weekly report', e);
        }
      },
      { timezone: TZ }
    );
    console.log(`Weekly report scheduled: "${WEEKLY_REPORT_CRON}" (${TZ})`);

    cron.schedule(LONG_SHIFT_CHECK_CRON, () => {
      checkLongRunningShifts().catch((e) => console.error('Long-shift check failed', e));
    });
    console.log(`Long-shift safety check scheduled: "${LONG_SHIFT_CHECK_CRON}" (threshold ${MAX_SHIFT_HOURS}h)`);
  }

  cron.schedule(SCHEDULE_REMINDER_CRON, () => {
    checkScheduleReminders().catch((e) => console.error('Schedule reminder check failed', e));
  });
  console.log(
    `Schedule reminders scheduled: "${SCHEDULE_REMINDER_CRON}" (${SHIFT_START_REMINDER_MINUTES}min heads-up + clock-out nudge)`
  );

  await bot.telegram.setMyCommands([
    { command: 'clockin', description: 'Start your shift' },
    { command: 'clockout', description: 'End your shift' },
    { command: 'status', description: 'See shift length (yours or @user)' },
    { command: 'whosonshift', description: 'See who is currently clocked in' },
    { command: 'schedule', description: "See today's roster" },
    { command: 'tomorrow', description: "See tomorrow's roster" },
    { command: 'whensmynextshift', description: 'See how long until your next shift' },
    { command: 'myhistory', description: 'See your last 10 shifts' },
    { command: 'checkins', description: 'Admin: see status-check timestamps for a shift' },
    { command: 'report', description: "Admin: get today's report on demand" },
    { command: 'weeklyreport', description: 'Admin: get this week\'s report on demand' },
    { command: 'monthlyreport', description: 'Admin: get the trailing 30 days report' },
    { command: 'forceclockout', description: 'Admin: clock a clipper out' },
    { command: 'checknow', description: 'Admin: send an immediate status check' },
    { command: 'extraclockin', description: 'Clock in as an extra for the live event (DM)' },
    { command: 'extraclockout', description: 'Clock out as an extra' },
    { command: 'eventstart', description: 'Admin: start an event for extras' },
    { command: 'eventend', description: 'Admin: end the event + show totals' },
    { command: 'extras', description: "Admin: who's clocked in at the event" },
    { command: 'eventreport', description: 'Admin: per-extra hours for the event' },
    { command: 'extraforceclockout', description: 'Admin: clock an extra out' },
    { command: 'help', description: 'List commands' },
  ]);

  await launchWithRetry();
  console.log('Bot started.');
  await notifyAdmin(`🟢 Bot online — resumed <b>${resumedCount}</b> active shift(s).`);
}

async function crashAndExit(reason, err) {
  console.error(reason, err);
  await notifyAdmin(`🔴 Bot crashed (${escapeHtml(reason)})\n<code>${escapeHtml(String(err?.message || err))}</code>`);
  process.exit(1);
}

// Only boot when run directly (`npm start`); when required by a test the
// bot object is just exported so handlers can be driven without Telegram.
if (require.main === module) {
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
  process.on('uncaughtException', (err) => crashAndExit('uncaughtException', err));
  process.on('unhandledRejection', (err) => crashAndExit('unhandledRejection', err));

  main().catch((e) => crashAndExit('Fatal startup error', e));
}

module.exports = { bot };
