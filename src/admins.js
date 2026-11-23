const { ROSTER } = require('./schedule');

const adminIds = new Set([
  Number(process.env.ADMIN_ID),
  ROSTER.Bla.userId,
].filter((id) => Number.isSafeInteger(id) && id > 0));

function isAdmin(userId) {
  return adminIds.has(userId);
}

async function notifyAdmins(bot, text, excludeUserId) {
  for (const userId of adminIds) {
    if (userId === excludeUserId) continue;
    try {
      await bot.telegram.sendMessage(userId, text, { parse_mode: 'HTML' });
    } catch (error) {
      console.error('Failed to notify admin', userId, error);
    }
  }
}

module.exports = { isAdmin, notifyAdmins };
