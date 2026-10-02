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
  const shift = await findOpenShiftForTarget(target);
  if (!shift) {
    return ctx.reply("Couldn't find an active shift for that clipper.");
  }
  try {
    await scheduler.sendCheckin(bot, shift);
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
      const isOn = openByUserId.has(entry.userId);
      lines.push(`${isOn ? '✅' : '⚠️'} @${escapeHtml(entry.username)}${isOn ? '' : ' — not clocked in'}`);
    }
  }

  await ctx.reply(lines.join('\n'), HTML);
});

bot.command('schedule', async (ctx) => {
  if (ctx.chat.type !== 'private') {
    const link = botUsername ? ` (@${botUsername})` : '';
    return ctx.reply(`Run this one in DM, not here — it @mentions the whole roster. Message me${link} privately.`);
  }
  const { dayName, weekParity, entries } = schedule.getScheduleForCetDate();
  if (entries.length === 0) {
    return ctx.reply(`No one scheduled for <b>${dayName}</b> (week ${weekParity}). Times are CET.`, HTML);
  }
  const lines = entries.map((e) => {
    const nextDay = e.endHour > 24 ? ' (+1d)' : '';
    return `${padHour(e.startHour)}–${padHour(e.endHour)}${nextDay} · @${escapeHtml(e.username)}`;
  });
  await ctx.reply(`<b>Schedule — ${dayName} (week ${weekParity}) · CET</b>\n${lines.join('\n')}`, HTML);
});

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
  // Calendar month to date (1st at 00:00 in the process TZ), same
  // setHours approach the daily report uses.
  const since = new Date();
  since.setDate(1);
  since.setHours(0, 0, 0, 0);
  const report = await buildReportText(since.toISOString(), 'Monthly');
  await ctx.reply(report, HTML);
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
      '<code>/whensmynextshift</code> — see how long until your next scheduled shift',
      '<code>/myhistory</code> — see your last 10 completed shifts',
      ADMIN_ID ? '<code>/checkins [@user]</code> — (admin) see status-check timestamps for a shift' : null,
      ADMIN_ID ? '<code>/report</code> — (admin) get an on-demand daily report' : null,
      ADMIN_ID ? '<code>/weeklyreport</code> — (admin) get an on-demand weekly report' : null,
      ADMIN_ID ? '<code>/monthlyreport</code> — (admin) get the month-to-date report' : null,
      ADMIN_ID ? '<code>/forceclockout @user</code> — (admin) clock someone out, reply to their message also works' : null,
      ADMIN_ID ? '<code>/checknow @user</code> — (admin) send an immediate status check, reply to their message also works' : null,
    ]
      .filter(Boolean)
      .join('\n'),
    HTML
  );
});

bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data || '';
  if (!data.startsWith('checkin:')) return ctx.answerCbQuery();

  const idPart = data.split(':')[1];
  if (idPart === 'pending') {
    return ctx.answerCbQuery('Give it a second and try again.');
  }

  const checkinId = Number(idPart);
  const checkin = await db.getCheckin(checkinId);
  if (!checkin) return ctx.answerCbQuery('Check-in not found.');

  const shiftRes = await db.pool.query('SELECT * FROM shifts WHERE id = $1', [checkin.shift_id]);
  const shift = shiftRes.rows[0];

  if (shift && ctx.from.id !== shift.user_id) {
    return ctx.answerCbQuery('This check-in is not for you.');
  }

  if (checkin.status !== 'pending') {
    return ctx.answerCbQuery(`Already ${checkin.status}.`);
  }

  const confirmed = await db.confirmCheckin(checkinId);
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

  return open.length;
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
    { command: 'whensmynextshift', description: 'See how long until your next shift' },
    { command: 'myhistory', description: 'See your last 10 shifts' },
    { command: 'checkins', description: 'Admin: see status-check timestamps for a shift' },
    { command: 'report', description: "Admin: get today's report on demand" },
    { command: 'weeklyreport', description: 'Admin: get this week\'s report on demand' },
    { command: 'monthlyreport', description: 'Admin: get the month-to-date report' },
    { command: 'forceclockout', description: 'Admin: clock a clipper out' },
    { command: 'checknow', description: 'Admin: send an immediate status check' },
    { command: 'help', description: 'List commands' },
  ]);

  await launchWithRetry();
  console.log('Bot started.');
  await notifyAdmin(`🟢 Bot online — resumed <b>${resumedCount}</b> active shift(s).`);
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

async function crashAndExit(reason, err) {
  console.error(reason, err);
  await notifyAdmin(`🔴 Bot crashed (${escapeHtml(reason)})\n<code>${escapeHtml(String(err?.message || err))}</code>`);
  process.exit(1);
}

process.on('uncaughtException', (err) => crashAndExit('uncaughtException', err));
process.on('unhandledRejection', (err) => crashAndExit('unhandledRejection', err));

main().catch((e) => crashAndExit('Fatal startup error', e));
