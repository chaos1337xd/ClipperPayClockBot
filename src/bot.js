require('dotenv').config();
const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const db = require('./db');
const scheduler = require('./scheduler');
const { formatDuration, escapeHtml, nameTag } = require('./format');

const HTML = { parse_mode: 'HTML' };

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : null;
const DAILY_REPORT_CRON = process.env.DAILY_REPORT_CRON || '0 0 * * *';
const WEEKLY_REPORT_CRON = process.env.WEEKLY_REPORT_CRON || '0 0 * * 1';
const TZ = process.env.TZ || 'Europe/Stockholm';
const MAX_SHIFT_HOURS = Number(process.env.MAX_SHIFT_HOURS || 12);
const LONG_SHIFT_CHECK_CRON = process.env.LONG_SHIFT_CHECK_CRON || '*/15 * * * *';

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN env var.');
  process.exit(1);
}
if (!ADMIN_ID) {
  console.warn('Warning: ADMIN_ID not set — reports and admin commands will have no recipient/authorized user.');
}

const bot = new Telegraf(BOT_TOKEN);

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
  const userId = ctx.from.id;
  const existing = await db.getOpenShift(userId);
  if (existing) {
    return ctx.reply(`You're already clocked in (since <b>${fmtLocal(existing.clock_in)}</b>).`, HTML);
  }
  const shift = await db.createShift(userId, ctx.from.username || null, displayNameOf(ctx.from), ctx.chat.id);
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
  if (open.length === 0) {
    return ctx.reply('Nobody is currently clocked in.');
  }
  const lines = open.map((s) => {
    const seconds = (Date.now() - new Date(s.clock_in).getTime()) / 1000;
    return `• ${nameTag(s)} — <b>${formatDuration(seconds)}</b>`;
  });
  await ctx.reply(`Currently on shift:\n${lines.join('\n')}`, HTML);
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

bot.command('help', async (ctx) => {
  await ctx.reply(
    [
      '<b>Payclock commands:</b>',
      '<code>/clockin</code> — start your shift',
      '<code>/clockout</code> — end your shift',
      '<code>/status [@user]</code> — see your (or their) current shift length',
      '<code>/whosonshift</code> — see who is currently clocked in',
      '<code>/myhistory</code> — see your last 10 completed shifts',
      ADMIN_ID ? '<code>/checkins [@user]</code> — (admin) see status-check timestamps for a shift' : null,
      ADMIN_ID ? '<code>/report</code> — (admin) get an on-demand daily report' : null,
      ADMIN_ID ? '<code>/weeklyreport</code> — (admin) get an on-demand weekly report' : null,
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

  await ctx.editMessageText(`✅ ${nameTag(shift)} confirmed presence.`, HTML);
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

async function main() {
  await db.init();
  const resumedCount = await resumeActiveShifts();

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

  await bot.telegram.setMyCommands([
    { command: 'clockin', description: 'Start your shift' },
    { command: 'clockout', description: 'End your shift' },
    { command: 'status', description: 'See shift length (yours or @user)' },
    { command: 'whosonshift', description: 'See who is currently clocked in' },
    { command: 'myhistory', description: 'See your last 10 shifts' },
    { command: 'checkins', description: 'Admin: see status-check timestamps for a shift' },
    { command: 'report', description: "Admin: get today's report on demand" },
    { command: 'weeklyreport', description: 'Admin: get this week\'s report on demand' },
    { command: 'forceclockout', description: 'Admin: clock a clipper out' },
    { command: 'checknow', description: 'Admin: send an immediate status check' },
    { command: 'help', description: 'List commands' },
  ]);

  await bot.launch();
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
