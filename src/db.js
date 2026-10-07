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

    CREATE TABLE IF NOT EXISTS schedule_reminders (
      username TEXT NOT NULL,
      occurrence_at TIMESTAMPTZ NOT NULL,
      type TEXT NOT NULL, -- 'start' | 'end'
      sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (username, occurrence_at, type)
    );

    CREATE INDEX IF NOT EXISTS idx_checkins_pending ON checkins (status) WHERE status = 'pending';

    ALTER TABLE shifts ADD COLUMN IF NOT EXISTS long_shift_warned BOOLEAN NOT NULL DEFAULT FALSE;

    -- Enforces at most one open shift per user at the DB level, closing a
    -- race where two near-simultaneous /clockin calls (double-tap, a
    -- retried Telegram update) both pass the JS-side "already clocked in?"
    -- check before either INSERT commits, creating two open shifts for the
    -- same person. Replaces the old non-unique idx_shifts_open.
    DROP INDEX IF EXISTS idx_shifts_open;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_one_open_per_user ON shifts (user_id) WHERE clock_out IS NULL;

    -- One-off events (e.g. a stream day) with "extras" who aren't on the
    -- main roster. Deliberately separate tables so extras never leak into
    -- the main shift reports, /whosonshift or check-in scheduling.
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at TIMESTAMPTZ,
      created_by BIGINT
    );

    CREATE TABLE IF NOT EXISTS extra_shifts (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL,
      username TEXT,
      display_name TEXT,
      clock_in TIMESTAMPTZ NOT NULL DEFAULT now(),
      clock_out TIMESTAMPTZ
    );

    -- At most one live event, and at most one open extra shift per person,
    -- enforced by the DB so a double-tap or two admins can't create dupes.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_one_active ON events ((true)) WHERE ended_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_extra_shifts_one_open_per_user ON extra_shifts (user_id) WHERE clock_out IS NULL;
    CREATE INDEX IF NOT EXISTS idx_extra_shifts_event ON extra_shifts (event_id);
  `);
}

// ---- Events / extras ----

async function getActiveEvent() {
  const { rows } = await pool.query(`SELECT * FROM events WHERE ended_at IS NULL LIMIT 1`);
  return rows[0] || null;
}

async function getLatestEvent() {
  const { rows } = await pool.query(`SELECT * FROM events ORDER BY started_at DESC LIMIT 1`);
  return rows[0] || null;
}

async function getEventById(eventId) {
  const { rows } = await pool.query(`SELECT * FROM events WHERE id = $1`, [eventId]);
  return rows[0] || null;
}

// Throws a 23505 unique violation if an event is already live.
async function createEvent(name, createdBy) {
  const { rows } = await pool.query(
    `INSERT INTO events (name, created_by) VALUES ($1, $2) RETURNING *`,
    [name, createdBy]
  );
  return rows[0];
}

async function endEvent(eventId) {
  const { rows } = await pool.query(
    `UPDATE events SET ended_at = now() WHERE id = $1 AND ended_at IS NULL RETURNING *`,
    [eventId]
  );
  return rows[0] || null;
}

async function getOpenExtraShift(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM extra_shifts WHERE user_id = $1 AND clock_out IS NULL LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function getOpenExtraShiftByUsername(username) {
  const { rows } = await pool.query(
    `SELECT * FROM extra_shifts WHERE clock_out IS NULL AND lower(username) = lower($1) LIMIT 1`,
    [username]
  );
  return rows[0] || null;
}

async function getOpenExtraShiftsForEvent(eventId) {
  const { rows } = await pool.query(
    `SELECT * FROM extra_shifts WHERE event_id = $1 AND clock_out IS NULL ORDER BY clock_in ASC`,
    [eventId]
  );
  return rows;
}

// Inserts only if an event is live *at the moment of the insert* — so a
// clock-in racing /eventend can't create a shift on an already-ended event
// that nobody would ever close. Returns null when there's no live event.
async function createExtraShift(userId, username, displayName) {
  const { rows } = await pool.query(
    `INSERT INTO extra_shifts (event_id, user_id, username, display_name)
     SELECT e.id, $1, $2, $3 FROM events e WHERE e.ended_at IS NULL
     RETURNING *`,
    [userId, username, displayName]
  );
  return rows[0] || null;
}

async function closeExtraShift(shiftId) {
  const { rows } = await pool.query(
    `UPDATE extra_shifts SET clock_out = now() WHERE id = $1 AND clock_out IS NULL RETURNING *`,
    [shiftId]
  );
  return rows[0] || null;
}

async function closeAllOpenExtraShifts(eventId) {
  const { rows } = await pool.query(
    `UPDATE extra_shifts SET clock_out = now() WHERE event_id = $1 AND clock_out IS NULL RETURNING *`,
    [eventId]
  );
  return rows;
}

// One table, so no join fan-out to worry about (unlike the main report).
async function getEventReportData(eventId) {
  const { rows } = await pool.query(
    `SELECT
       user_id,
       (array_agg(display_name ORDER BY clock_in DESC))[1] AS display_name,
       (array_agg(username ORDER BY clock_in DESC))[1] AS username,
       SUM(EXTRACT(EPOCH FROM (COALESCE(clock_out, now()) - clock_in))) AS seconds_worked,
       COUNT(*) AS shifts_count
     FROM extra_shifts
     WHERE event_id = $1
     GROUP BY user_id
     ORDER BY seconds_worked DESC`,
    [eventId]
  );
  return rows;
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

// Atomically claims a (username, occurrence, type) reminder slot — returns
// true if this call is the one that gets to send it, false if it was
// already sent (by an earlier tick or a prior process, including across a
// restart, since this is persisted rather than kept in memory).
async function claimScheduleReminder(username, occurrenceAt, type) {
  const { rowCount } = await pool.query(
    `INSERT INTO schedule_reminders (username, occurrence_at, type) VALUES (lower($1), $2, $3) ON CONFLICT DO NOTHING`,
    [username, occurrenceAt, type]
  );
  return rowCount > 0;
}

async function updateOpenShiftsChatId(oldChatId, newChatId) {
  await pool.query(`UPDATE shifts SET chat_id = $1 WHERE chat_id = $2 AND clock_out IS NULL`, [
    newChatId,
    oldChatId,
  ]);
}

async function getUserShiftHistory(userId, limit) {
  const { rows } = await pool.query(
    `SELECT * FROM shifts WHERE user_id = $1 AND clock_out IS NOT NULL ORDER BY clock_in DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

async function getMostRecentShiftByUsername(username) {
  const { rows } = await pool.query(
    `SELECT * FROM shifts WHERE lower(username) = lower($1) ORDER BY clock_in DESC LIMIT 1`,
    [username]
  );
  return rows[0] || null;
}

async function getLastCheckinSentAt(shiftId) {
  const { rows } = await pool.query(
    `SELECT sent_at FROM checkins WHERE shift_id = $1 ORDER BY sent_at DESC LIMIT 1`,
    [shiftId]
  );
  return rows[0]?.sent_at || null;
}

async function getCheckinsForShift(shiftId) {
  const { rows } = await pool.query(
    `SELECT * FROM checkins WHERE shift_id = $1 ORDER BY sent_at ASC`,
    [shiftId]
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

async function createCheckin(shiftId, chatId, messageId = null) {
  const { rows } = await pool.query(
    `INSERT INTO checkins (shift_id, chat_id, message_id) VALUES ($1, $2, $3) RETURNING *`,
    [shiftId, chatId, messageId]
  );
  return rows[0];
}

async function setCheckinMessageId(checkinId, messageId) {
  await pool.query(`UPDATE checkins SET message_id = $1 WHERE id = $2`, [messageId, checkinId]);
}

async function updateCheckinChatId(checkinId, chatId) {
  await pool.query(`UPDATE checkins SET chat_id = $1 WHERE id = $2`, [chatId, checkinId]);
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
  getActiveEvent,
  getLatestEvent,
  getEventById,
  createEvent,
  endEvent,
  getOpenExtraShift,
  getOpenExtraShiftByUsername,
  getOpenExtraShiftsForEvent,
  createExtraShift,
  closeExtraShift,
  closeAllOpenExtraShifts,
  getEventReportData,
  getOpenShift,
  getAllOpenShifts,
  getOpenShiftByUsername,
  getMostRecentShiftByUsername,
  claimScheduleReminder,
  updateOpenShiftsChatId,
  getUserShiftHistory,
  getLastCheckinSentAt,
  getCheckinsForShift,
  getLongRunningUnwarnedShifts,
  markShiftWarned,
  createShift,
  closeShift,
  createCheckin,
  setCheckinMessageId,
  updateCheckinChatId,
  getCheckin,
  confirmCheckin,
  expireCheckin,
  expirePendingCheckinsForShift,
  getPendingCheckins,
  getDailyReportData,
};
