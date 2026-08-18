const { Pool, types } = require('pg');

// Telegram user/chat/message IDs fit within JS's safe integer range, so parse
// BIGINT (OID 20) as a number instead of pg's default string — otherwise
// comparisons like `ctx.from.id !== shift.user_id` (number vs string) always
// fail even when the IDs match.
types.setTypeParser(20, (val) => parseInt(val, 10));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : undefined,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shifts (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      username TEXT,
      display_name TEXT,
      chat_id BIGINT NOT NULL,
      clock_in TIMESTAMPTZ NOT NULL DEFAULT now(),
      clock_out TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS checkins (
      id SERIAL PRIMARY KEY,
      shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
      chat_id BIGINT NOT NULL,
      message_id BIGINT,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      responded_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'pending' -- pending | confirmed | missed
    );

    CREATE INDEX IF NOT EXISTS idx_shifts_open ON shifts (user_id) WHERE clock_out IS NULL;
    CREATE INDEX IF NOT EXISTS idx_checkins_pending ON checkins (status) WHERE status = 'pending';
  `);
}

async function getOpenShift(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM shifts WHERE user_id = $1 AND clock_out IS NULL LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function getAllOpenShifts() {
  const { rows } = await pool.query(`SELECT * FROM shifts WHERE clock_out IS NULL`);
  return rows;
}

async function createShift(userId, username, displayName, chatId) {
  const { rows } = await pool.query(
    `INSERT INTO shifts (user_id, username, display_name, chat_id) VALUES ($1, $2, $3, $4) RETURNING *`,
    [userId, username, displayName, chatId]
  );
  return rows[0];
}

async function closeShift(shiftId) {
  const { rows } = await pool.query(
    `UPDATE shifts SET clock_out = now() WHERE id = $1 RETURNING *`,
    [shiftId]
  );
  return rows[0];
}

async function createCheckin(shiftId, chatId, messageId) {
  const { rows } = await pool.query(
    `INSERT INTO checkins (shift_id, chat_id, message_id) VALUES ($1, $2, $3) RETURNING *`,
    [shiftId, chatId, messageId]
  );
  return rows[0];
}

async function getCheckin(checkinId) {
  const { rows } = await pool.query(`SELECT * FROM checkins WHERE id = $1`, [checkinId]);
  return rows[0] || null;
}

async function confirmCheckin(checkinId) {
  const { rows } = await pool.query(
    `UPDATE checkins SET status = 'confirmed', responded_at = now() WHERE id = $1 AND status = 'pending' RETURNING *`,
    [checkinId]
  );
  return rows[0] || null;
}

async function expireCheckin(checkinId) {
  const { rows } = await pool.query(
    `UPDATE checkins SET status = 'missed' WHERE id = $1 AND status = 'pending' RETURNING *`,
    [checkinId]
  );
  return rows[0] || null;
}

async function expirePendingCheckinsForShift(shiftId) {
  await pool.query(
    `UPDATE checkins SET status = 'missed' WHERE shift_id = $1 AND status = 'pending'`,
    [shiftId]
  );
}

async function getPendingCheckins() {
  const { rows } = await pool.query(`SELECT * FROM checkins WHERE status = 'pending'`);
  return rows;
}

async function getDailyReportData(sinceIso) {
  const { rows } = await pool.query(
    `
    SELECT
      s.user_id,
      COALESCE(s.display_name, s.username, s.user_id::text) AS name,
      SUM(EXTRACT(EPOCH FROM (COALESCE(s.clock_out, now()) - s.clock_in))) AS seconds_worked,
      COUNT(DISTINCT s.id) AS shifts_count,
      COALESCE(SUM(CASE WHEN c.status = 'missed' THEN 1 ELSE 0 END), 0) AS missed_checkins,
      COALESCE(SUM(CASE WHEN c.status = 'confirmed' THEN 1 ELSE 0 END), 0) AS confirmed_checkins
    FROM shifts s
    LEFT JOIN checkins c ON c.shift_id = s.id
    WHERE s.clock_in >= $1
    GROUP BY s.user_id, name
    ORDER BY seconds_worked DESC
    `,
    [sinceIso]
  );
  return rows;
}

module.exports = {
  pool,
  init,
  getOpenShift,
  getAllOpenShifts,
  createShift,
  closeShift,
  createCheckin,
  getCheckin,
  confirmCheckin,
  expireCheckin,
  expirePendingCheckinsForShift,
  getPendingCheckins,
  getDailyReportData,
};
