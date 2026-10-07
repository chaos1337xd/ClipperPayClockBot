const db = require('./db');
const { nameTag } = require('./format');

const CHECKIN_INTERVAL_MS = Number(process.env.CHECKIN_INTERVAL_MINUTES || 30) * 60 * 1000;
const CHECKIN_GRACE_MS = Number(process.env.CHECKIN_GRACE_MINUTES || 5) * 60 * 1000;
const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : null;

const HTML = { parse_mode: 'HTML' };

// Status checks run for two kinds of shift: the main roster ('main') and
// event extras ('extra'). They live in separate tables, so only the DB
// operations, the button's callback prefix and the timer key differ —
// everything else (cadence, grace period, supergroup migration handling,
// admin ping on a miss) is shared.
const KINDS = {
  main: {
    callbackPrefix: 'checkin',
    createCheckin: (shift, chatId) => db.createCheckin(shift.id, chatId, null),
    setMessageId: db.setCheckinMessageId,
    updateCheckinChatId: db.updateCheckinChatId,
    expireCheckin: db.expireCheckin,
    lastSentAt: db.getLastCheckinSentAt,
    updateOpenShiftsChatId: db.updateOpenShiftsChatId,
    adminLabel: '',
  },
  extra: {
    callbackPrefix: 'xcheckin',
    createCheckin: (shift, chatId) => db.createExtraCheckin(shift.id, chatId, null),
    setMessageId: db.setExtraCheckinMessageId,
    updateCheckinChatId: db.updateExtraCheckinChatId,
    expireCheckin: db.expireExtraCheckin,
    lastSentAt: db.getLastExtraCheckinSentAt,
    updateOpenShiftsChatId: db.updateOpenExtraShiftsChatId,
    adminLabel: ' (extra)',
  },
};

// main and extra shift ids come from different sequences and can collide,
// so timers are keyed by kind + id.
const timerKey = (kind, shiftId) => `${kind}:${shiftId}`;

// `${kind}:${shiftId}` -> { startTimeout, intervalTimer, expireTimer }
const timers = new Map();

// Sends a status-check prompt for a shift immediately. Used both by the
// recurring interval and by the admin's manual /checknow trigger.
async function sendCheckin(bot, shift, kind = 'main') {
  const k = KINDS[kind];
  const text = `⏰ Status check for ${nameTag(shift)} — tap the button to confirm you're still on shift.`;

  // Create the checkin row first so the button's callback_data can carry
  // the real id from the start — no placeholder + patch-afterward race
  // where a tap between the two calls (or a failed patch) leaves the
  // button permanently stuck.
  const checkin = await k.createCheckin(shift, shift.chat_id);

  const sendTo = (chatId) =>
    bot.telegram.sendMessage(chatId, text, {
      ...HTML,
      reply_markup: {
        inline_keyboard: [[{ text: "✅ I'm here", callback_data: `${k.callbackPrefix}:${checkin.id}` }]],
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
    await k.updateOpenShiftsChatId(shift.chat_id, migrateTo);
    await k.updateCheckinChatId(checkin.id, migrateTo);
    shift.chat_id = migrateTo;
    checkin.chat_id = migrateTo;
    msg = await sendTo(shift.chat_id);
  }

  await k.setMessageId(checkin.id, msg.message_id);
  checkin.message_id = msg.message_id;

  scheduleExpiry(bot, shift, checkin, kind);
  return checkin;
}

function scheduleExpiry(bot, shift, checkin, kind) {
  const k = KINDS[kind];
  const expireTimer = setTimeout(async () => {
    const expired = await k.expireCheckin(checkin.id);
    if (expired) {
      try {
        await bot.telegram.editMessageText(
          checkin.chat_id,
          checkin.message_id,
          undefined,
          `❌ ${nameTag(shift)} didn't confirm presence.`,
          HTML
        );
      } catch (e) {
        console.error('Failed to edit expired check-in message', checkin.id, e);
      }

      // Check-ins mostly happen over DM rather than in the shared group,
      // so a missed one is otherwise invisible to the admin until they go
      // looking (a report, /checkins). Ping them in real time instead —
      // skip if the admin is the one who missed their own.
      if (ADMIN_ID && shift.user_id !== ADMIN_ID) {
        try {
          await bot.telegram.sendMessage(
            ADMIN_ID,
            `⚠️ ${nameTag(shift)} missed a status check${k.adminLabel}.`,
            HTML
          );
        } catch (e) {
          console.error('Failed to notify admin of missed check-in', checkin.id, e);
        }
      }
    }
  }, CHECKIN_GRACE_MS);

  const key = timerKey(kind, shift.id);
  const entry = timers.get(key) || {};
  entry.expireTimer = expireTimer;
  timers.set(key, entry);
}

// Schedules check-ins on a fixed cadence anchored to the shift's actual
// timeline (last checkin sent, or clock-in if there hasn't been one yet)
// rather than to "now" — otherwise every bot restart resets the 30-min
// clock from the moment it comes back up, drifting the real schedule later
// and later with each restart.
async function startShiftChecks(bot, shift, kind = 'main') {
  const k = KINDS[kind];
  const lastSentAt = await k.lastSentAt(shift.id);
  const baseline = new Date(lastSentAt || shift.clock_in).getTime();
  const nextAt = baseline + CHECKIN_INTERVAL_MS;
  const delay = Math.max(0, nextAt - Date.now());
  const key = timerKey(kind, shift.id);

  const startTimeout = setTimeout(() => {
    sendCheckin(bot, shift, kind).catch((e) => console.error('checkin send failed', e));

    const intervalTimer = setInterval(() => {
      sendCheckin(bot, shift, kind).catch((e) => console.error('checkin send failed', e));
    }, CHECKIN_INTERVAL_MS);

    const entry = timers.get(key) || {};
    entry.intervalTimer = intervalTimer;
    timers.set(key, entry);
  }, delay);

  const entry = timers.get(key) || {};
  entry.startTimeout = startTimeout;
  timers.set(key, entry);
}

function stopShiftChecks(shiftId, kind = 'main') {
  const key = timerKey(kind, shiftId);
  const entry = timers.get(key);
  if (!entry) return;
  if (entry.startTimeout) clearTimeout(entry.startTimeout);
  if (entry.intervalTimer) clearInterval(entry.intervalTimer);
  if (entry.expireTimer) clearTimeout(entry.expireTimer);
  timers.delete(key);
}

module.exports = {
  startShiftChecks,
  stopShiftChecks,
  sendCheckin,
  CHECKIN_INTERVAL_MS,
  CHECKIN_GRACE_MS,
};
