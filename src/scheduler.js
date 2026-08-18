const db = require('./db');

const CHECKIN_INTERVAL_MS = Number(process.env.CHECKIN_INTERVAL_MINUTES || 30) * 60 * 1000;
const CHECKIN_GRACE_MS = Number(process.env.CHECKIN_GRACE_MINUTES || 5) * 60 * 1000;

// shiftId -> { intervalTimer, expireTimer }
const timers = new Map();

function buildDeps(bot) {
  async function sendCheckin(shift) {
    const mention = shift.username ? `@${shift.username}` : (shift.display_name || 'clipper');
    const text = `⏰ Status check for ${mention} — tap the button to confirm you're still on shift.`;
    const opts = {
      reply_markup: {
        inline_keyboard: [[{ text: "✅ I'm here", callback_data: 'checkin:pending' }]],
      },
    };

    let msg;
    try {
      msg = await bot.telegram.sendMessage(shift.chat_id, text, opts);
    } catch (e) {
      // Telegram migrates a group to a supergroup with a new chat_id at any
      // time; when it does, it tells us the new id in this error instead of
      // just failing outright — update our records and retry once.
      const migrateTo = e?.response?.parameters?.migrate_to_chat_id;
      if (!migrateTo) throw e;
      console.log(`Chat ${shift.chat_id} migrated to supergroup ${migrateTo}, updating.`);
      await db.updateOpenShiftsChatId(shift.chat_id, migrateTo);
      shift.chat_id = migrateTo;
      msg = await bot.telegram.sendMessage(shift.chat_id, text, opts);
    }

    const checkin = await db.createCheckin(shift.id, shift.chat_id, msg.message_id);

    // patch callback_data now that we have the checkin id
    await bot.telegram.editMessageReplyMarkup(shift.chat_id, msg.message_id, undefined, {
      inline_keyboard: [[{ text: "✅ I'm here", callback_data: `checkin:${checkin.id}` }]],
    });

    scheduleExpiry(shift, checkin, bot);
  }

  function scheduleExpiry(shift, checkin, bot) {
    const expireTimer = setTimeout(async () => {
      const expired = await db.expireCheckin(checkin.id);
      if (expired) {
        try {
          const name = shift.username ? `@${shift.username}` : shift.display_name;
          await bot.telegram.editMessageText(
            checkin.chat_id,
            checkin.message_id,
            undefined,
            `❌ ${name} didn't confirm presence.`
          );
        } catch (e) {
          console.error('Failed to edit expired check-in message', checkin.id, e);
        }
      }
    }, CHECKIN_GRACE_MS);

    const entry = timers.get(shift.id) || {};
    entry.expireTimer = expireTimer;
    timers.set(shift.id, entry);
  }

  return { sendCheckin, scheduleExpiry };
}

function startShiftChecks(bot, shift) {
  const { sendCheckin } = buildDeps(bot);

  const intervalTimer = setInterval(() => {
    sendCheckin(shift).catch((e) => console.error('checkin send failed', e));
  }, CHECKIN_INTERVAL_MS);

  const entry = timers.get(shift.id) || {};
  entry.intervalTimer = intervalTimer;
  timers.set(shift.id, entry);
}

function stopShiftChecks(shiftId) {
  const entry = timers.get(shiftId);
  if (!entry) return;
  if (entry.intervalTimer) clearInterval(entry.intervalTimer);
  if (entry.expireTimer) clearTimeout(entry.expireTimer);
  timers.delete(shiftId);
}

module.exports = { startShiftChecks, stopShiftChecks, CHECKIN_INTERVAL_MS, CHECKIN_GRACE_MS };
