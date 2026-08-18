require('dotenv').config();
const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const db = require('./db');
const scheduler = require('./scheduler');
const { formatDuration } = require('./format');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : null;
const DAILY_REPORT_CRON = process.env.DAILY_REPORT_CRON || '0 0 * * *';
const TZ = process.env.TZ || 'UTC';

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN env var.');
  process.exit(1);
}
if (!ADMIN_ID) {
  console.warn('Warning: ADMIN_ID not set — daily reports and /report will have no recipient/authorized user.');
}

const bot = new Telegraf(BOT_TOKEN);

function displayNameOf(from) {
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(from.id);
}

bot.command('clockin', async (ctx) => {
  const userId = ctx.from.id;
  const existing = await db.getOpenShift(userId);
  if (existing) {
    return ctx.reply(`You're already clocked in (since ${existing.clock_in.toLocaleString('en-US', { timeZone: TZ })}).`);
  }
  const shift = await db.createShift(userId, ctx.from.username || null, displayNameOf(ctx.from), ctx.chat.id);
  scheduler.startShiftChecks(bot, shift);
  await ctx.reply(
    `✅ ${displayNameOf(ctx.from)} clocked in. Status checks every ${scheduler.CHECKIN_INTERVAL_MS / 60000} min — tap the button when prompted.`
  );
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
  await ctx.reply(`🛑 ${displayNameOf(ctx.from)} clocked out. Shift length: ${formatDuration(seconds)}.`);
});

bot.command('status', async (ctx) => {
  const userId = ctx.from.id;
  const shift = await db.getOpenShift(userId);
  if (!shift) {
    return ctx.reply("You're not currently clocked in.");
  }
  const seconds = (Date.now() - new Date(shift.clock_in).getTime()) / 1000;
  await ctx.reply(`You've been clocked in for ${formatDuration(seconds)} (since ${new Date(shift.clock_in).toLocaleString('en-US', { timeZone: TZ })}).`);
});

bot.command('whosonshift', async (ctx) => {
  const open = await db.getAllOpenShifts();
  if (open.length === 0) {
    return ctx.reply('Nobody is currently clocked in.');
  }
  const lines = open.map((s) => {
    const seconds = (Date.now() - new Date(s.clock_in).getTime()) / 1000;
    const name = s.username ? `@${s.username}` : s.display_name;
    return `• ${name} — ${formatDuration(seconds)}`;
  });
  await ctx.reply(`Currently on shift:\n${lines.join('\n')}`);
});

bot.command('report', async (ctx) => {
  if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) {
    return ctx.reply("This command is admin-only.");
  }
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const report = await buildReportText(since.toISOString());
  await ctx.reply(report);
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    [
      'Payclock commands:',
      '/clockin — start your shift',
      '/clockout — end your shift',
      '/status — see your current shift length',
      '/whosonshift — see who is currently clocked in',
      ADMIN_ID ? '/report — (admin) get an on-demand daily report' : null,
    ]
      .filter(Boolean)
      .join('\n')
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

  const name = shift.username ? `@${shift.username}` : shift.display_name;
  await ctx.editMessageText(`✅ ${name} confirmed presence.`);
  await ctx.answerCbQuery("Confirmed, thanks!");
});

async function buildReportText(sinceIso) {
  const rows = await db.getDailyReportData(sinceIso);
  if (rows.length === 0) {
    return `📊 Daily payclock report\nNo shifts recorded today.`;
  }
  const lines = rows.map((r) => {
    const hours = formatDuration(Number(r.seconds_worked));
    return `• ${r.name}: ${hours} worked, ${r.shifts_count} shift(s), ${r.confirmed_checkins} confirmed / ${r.missed_checkins} missed check-ins`;
  });
  return `📊 Daily payclock report\n${lines.join('\n')}`;
}

async function resumeActiveShifts() {
  const open = await db.getAllOpenShifts();
  for (const shift of open) {
    scheduler.startShiftChecks(bot, shift);
  }
  console.log(`Resumed check-in scheduling for ${open.length} active shift(s).`);

  // any check-ins left pending from before a restart are stale — expire them
  const pending = await db.getPendingCheckins();
  for (const c of pending) {
    await db.expireCheckin(c.id);
  }
}

async function main() {
  await db.init();
  await resumeActiveShifts();

  if (ADMIN_ID) {
    cron.schedule(
      DAILY_REPORT_CRON,
      async () => {
        try {
          const since = new Date();
          since.setHours(0, 0, 0, 0);
          const text = await buildReportText(since.toISOString());
          await bot.telegram.sendMessage(ADMIN_ID, text);
        } catch (e) {
          console.error('Failed to send daily report', e);
        }
      },
      { timezone: TZ }
    );
    console.log(`Daily report scheduled: "${DAILY_REPORT_CRON}" (${TZ})`);
  }

  await bot.launch();
  console.log('Bot started.');
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

main().catch((e) => {
  console.error('Fatal startup error', e);
  process.exit(1);
});
