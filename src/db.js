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
      clock_out TIMESTAMPTZ,
      long_shift_warned BOOLEAN NOT NULL DEFAULT FALSE
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

    ALTER TABLE shifts ADD COLUMN IF NOT EXISTS long_shift_warned BOOLEAN NOT NULL DEFAULT FALSE;
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

async function getOpenShiftByUsername(username) {
  const { rows } = await pool.query(
    `SELECT * FROM shifts WHERE clock_out IS NULL AND lower(username) = lower($1) LIMIT 1`,
    [username]
  );
  return rows[0] || null;
}

async function getUserShiftHistory(userId, limit) {
  const { rows } = await pool.query(
    `SELECT * FROM shifts WHERE user_id = $1 AND clock_out IS NOT NULL ORDER BY clock_in DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

async function getLongRunningUnwarnedShifts(thresholdSeconds) {
  const { rows } = await pool.query(
    `SELECT * FROM shifts
     WHERE clock_out IS NULL
       AND long_shift_warned = FALSE
       AND EXTRACT(EPOCH FROM (now() - clock_in)) >= $1`,
    [thresholdSeconds]
  );
  return rows;
}

async function markShiftWarned(shiftId) {
  await pool.query(`UPDATE shifts SET long_shift_warned = TRUE WHERE id = $1`, [shiftId]);
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
  // Aggregate shifts and checkins separately before joining — joining them
  // directly fans shift rows out once per checkin, causing SUM(seconds_worked)
  // to multiply each shift's duration by its checkin count.
  const { rows } = await pool.query(
    `
    WITH shift_agg AS (
      SELECT
        user_id,
        COALESCE(display_name, username, user_id::text) AS name,
        SUM(EXTRACT(EPOCH FROM (COALESCE(clock_out, now()) - clock_in))) AS seconds_worked,
        COUNT(*) AS shifts_count
      FROM shifts
      WHERE clock_in >= $1
      GROUP BY user_id, name
    ),
    checkin_agg AS (
      SELECT
        s.user_id,
        SUM(CASE WHEN c.status = 'missed' THEN 1 ELSE 0 END) AS missed_checkins,
        SUM(CASE WHEN c.status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed_checkins
      FROM shifts s
      JOIN checkins c ON c.shift_id = s.id
      WHERE s.clock_in >= $1
      GROUP BY s.user_id
    )
    SELECT
      sa.user_id,
      sa.name,
      sa.seconds_worked,
      sa.shifts_count,
      COALESCE(ca.missed_checkins, 0) AS missed_checkins,
      COALESCE(ca.confirmed_checkins, 0) AS confirmed_checkins
    FROM shift_agg sa
    LEFT JOIN checkin_agg ca ON ca.user_id = sa.user_id
    ORDER BY sa.seconds_worked DESC
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
  getOpenShiftByUsername,
  getUserShiftHistory,
  getLongRunningUnwarnedShifts,
  markShiftWarned,
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
