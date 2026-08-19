const db = require('./db');

const CHECKIN_INTERVAL_MS = Number(process.env.CHECKIN_INTERVAL_MINUTES || 30) * 60 * 1000;
const CHECKIN_GRACE_MS = Number(process.env.CHECKIN_GRACE_MINUTES || 5) * 60 * 1000;

// shiftId -> { intervalTimer, expireTimer }
const timers = new Map();

// Sends a status-check prompt for a shift immediately. Used both by the
// recurring interval and by the admin's manual /checknow trigger.
async function sendCheckin(bot, shift) {
  const mention = shift.username ? `@${shift.username}` : (shift.display_name || 'clipper');
  const text = `⏰ Status check for ${mention} — tap the button to confirm you're still on shift.`;

  // Create the checkin row first so the button's callback_data can carry
  // the real id from the start — no placeholder + patch-afterward race
  // where a tap between the two calls (or a failed patch) leaves the
  // button permanently stuck.
  const checkin = await db.createCheckin(shift.id, shift.chat_id, null);

  const sendTo = (chatId) =>
    bot.telegram.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [[{ text: "✅ I'm here", callback_data: `checkin:${checkin.id}` }]],
      },
    });

  let msg;
  try {
    msg = await sendTo(shift.chat_id);
  } catch (e) {
    // Telegram migrates a group to a supergroup with a new chat_id at any
    // time; when it does, it tells us the new id in this error instead of
    // just failing outright — update our records and retry once.
    const migrateTo = e?.response?.parameters?.migrate_to_chat_id;
    if (!migrateTo) throw e;
    console.log(`Chat ${shift.chat_id} migrated to supergroup ${migrateTo}, updating.`);
    await db.updateOpenShiftsChatId(shift.chat_id, migrateTo);
    await db.updateCheckinChatId(checkin.id, migrateTo);
    shift.chat_id = migrateTo;
    checkin.chat_id = migrateTo;
    msg = await sendTo(shift.chat_id);
  }

  await db.setCheckinMessageId(checkin.id, msg.message_id);
  checkin.message_id = msg.message_id;

  scheduleExpiry(bot, shift, checkin);
  return checkin;
}

function scheduleExpiry(bot, shift, checkin) {
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

// Schedules check-ins on a fixed cadence anchored to the shift's actual
// timeline (last checkin sent, or clock-in if there hasn't been one yet)
// rather than to "now" — otherwise every bot restart resets the 30-min
// clock from the moment it comes back up, drifting the real schedule later
// and later with each restart.
async function startShiftChecks(bot, shift) {
  const lastSentAt = await db.getLastCheckinSentAt(shift.id);
  const baseline = new Date(lastSentAt || shift.clock_in).getTime();
  const nextAt = baseline + CHECKIN_INTERVAL_MS;
  const delay = Math.max(0, nextAt - Date.now());

  const startTimeout = setTimeout(() => {
    sendCheckin(bot, shift).catch((e) => console.error('checkin send failed', e));

    const intervalTimer = setInterval(() => {
      sendCheckin(bot, shift).catch((e) => console.error('checkin send failed', e));
    }, CHECKIN_INTERVAL_MS);

    const entry = timers.get(shift.id) || {};
    entry.intervalTimer = intervalTimer;
    timers.set(shift.id, entry);
  }, delay);

  const entry = timers.get(shift.id) || {};
  entry.startTimeout = startTimeout;
  timers.set(shift.id, entry);
}

function stopShiftChecks(shiftId) {
  const entry = timers.get(shiftId);
  if (!entry) return;
  if (entry.startTimeout) clearTimeout(entry.startTimeout);
  if (entry.intervalTimer) clearInterval(entry.intervalTimer);
  if (entry.expireTimer) clearTimeout(entry.expireTimer);
  timers.delete(shiftId);
}

module.exports = {
  startShiftChecks,
  stopShiftChecks,
  sendCheckin,
  CHECKIN_INTERVAL_MS,
  CHECKIN_GRACE_MS,
};
