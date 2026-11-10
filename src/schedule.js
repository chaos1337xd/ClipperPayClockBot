// Weekly roster from "Clipping new_temp.xlsx". Times are fixed CET (UTC+1,
// no daylight saving). Each row lists the hours when a clipper is scheduled.
//
// Set a numeric Telegram ID when known. For reminder delivery, the bot can
// look up a missing ID by username in shift history.
const ROSTER = {
  Adko: { username: 'Adko04', userId: 1632388627 },
  Draco: { username: 'Draco212', userId: 7064498111 },
  Manger: { username: 'Mangerhom', userId: 1642743726 },
  Bla: { username: 'bla2k', userId: 5996362594 },
  Karhu: { username: 'karhu38', userId: null },
  Nkjk: { username: 'nkjk1', userId: null },
};

const WEEKLY_SCHEDULE = {
  Monday: {
    Adko: [16, 17, 18, 19, 20, 21],
    Draco: [22, 23],
    Manger: [10, 11, 12, 13, 14, 15],
    Bla: [0, 1, 2, 3],
    Karhu: [4, 5, 6, 7, 8, 9],
    Nkjk: [],
  },
  Tuesday: {
    Adko: [19, 20, 21, 22, 23],
    Draco: [0, 1, 2, 3],
    Manger: [8, 9, 10, 11, 12],
    Bla: [13, 14, 15, 16, 17, 18],
    Karhu: [4, 5, 6, 7],
    Nkjk: [],
  },
  Wednesday: {
    Adko: [19, 20, 21, 22, 23],
    Draco: [],
    Manger: [6, 7, 8, 9, 10, 11],
    Bla: [12, 13, 14, 15, 16, 17, 18],
    Karhu: [],
    Nkjk: [0, 1, 2, 3, 4, 5],
  },
  Thursday: {
    Adko: [],
    Draco: [18, 19, 20, 21, 22, 23],
    Manger: [6, 7, 8, 9, 10, 11],
    Bla: [12, 13, 14, 15, 16, 17],
    Karhu: [],
    Nkjk: [0, 1, 2, 3, 4, 5],
  },
  Friday: {
    Adko: [18, 19, 20, 21, 22, 23],
    Draco: [],
    Manger: [10, 11, 12, 13, 14, 15],
    Bla: [16, 17],
    Karhu: [4, 5, 6, 7, 8, 9],
    Nkjk: [0, 1, 2, 3],
  },
  Saturday: {
    Adko: [12, 13],
    Draco: [16, 17, 18, 19, 20, 21, 22, 23],
    Manger: [],
    Bla: [],
    Karhu: [6, 7, 8, 9, 10, 11],
    Nkjk: [0, 1, 2, 3, 4, 5, 14, 15],
  },
  Sunday: {
    Adko: [18, 19, 20, 21],
    Draco: [12, 13, 14, 15, 16, 17],
    Manger: [],
    Bla: [22, 23],
    Karhu: [6, 7, 8, 9, 10, 11],
    Nkjk: [0, 1, 2, 3, 4, 5],
  }
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Merges a sorted array of scheduled hours (0-23) into contiguous
// [startHour, endHourExclusive] ranges, e.g. [0,1,2,3,16,17] -> [[0,4],[16,18]].
function toBlocks(hours) {
  if (!hours || hours.length === 0) return [];
  const sorted = [...hours].sort((a, b) => a - b);
  const blocks = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i];
      continue;
    }
    blocks.push([start, prev + 1]);
    start = sorted[i];
    prev = sorted[i];
  }
  blocks.push([start, prev + 1]);
  return blocks;
}

// Fixed CET is UTC+1 year-round (no DST), so CET wall-clock fields for a
// given instant are just that instant's UTC fields shifted by +1h.
function cetPartsOf(date) {
  const shifted = new Date(date.getTime() + 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    dayIdx: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function cetToUtcDate(year, month, day, hour) {
  return new Date(Date.UTC(year, month, day, hour, 0, 0) - 60 * 60 * 1000);
}

// Returns the roster for a specific CET calendar day: [{ nickname,
// username, userId, startHour, endHour }], endHour possibly 24 (rolls to
// midnight).
function scheduleForCetDay(year, month, day) {
  const dayIdx = new Date(Date.UTC(year, month, day)).getUTCDay();
  const dayName = DAY_NAMES[dayIdx];
  const weekData = WEEKLY_SCHEDULE[dayName] || {};

  const entries = [];
  for (const [nickname, hours] of Object.entries(weekData)) {
    for (const [startHour, endHour] of toBlocks(hours)) {
      const person = ROSTER[nickname];
      if (!person) continue;
      entries.push({ nickname, username: person.username, userId: person.userId, startHour, endHour });
    }
  }
  return entries;
}

// Who is scheduled to be on shift at the given instant (default now).
function getScheduledNow(date = new Date()) {
  const { year, month, day, hour } = cetPartsOf(date);
  return scheduleForCetDay(year, month, day).filter((e) => hour >= e.startHour && hour < e.endHour);
}

// Prefer a known Telegram ID. For roster entries without one, compare the
// username supplied by Telegram on the current update.
function matchesRosterUser(person, userId, username) {
  return person.userId
    ? person.userId === userId
    : Boolean(username) && person.username.toLowerCase() === username.toLowerCase();
}

function isRosterUser(userId, username) {
  return Object.values(ROSTER).some((person) => matchesRosterUser(person, userId, username));
}

// For /whensmynextshift: either they're on shift right now
// ({ status: 'now', entry }), their next upcoming block within the next 14
// days
// ({ status: 'upcoming', start, end, ...entry }), or they're not on the
// roster at all ({ status: 'none' }).
function getNextShiftForUser(userId, from = new Date(), username) {
  const nowMs = from.getTime();
  const { year, month, day, hour } = cetPartsOf(from);

  const todaysBlocks = scheduleForCetDay(year, month, day).filter((e) => matchesRosterUser(e, userId, username));
  const current = todaysBlocks.find((e) => hour >= e.startHour && hour < e.endHour);
  if (current) return { status: 'now', entry: current };

  for (let offset = 0; offset <= 14; offset++) {
    const d = new Date(Date.UTC(year, month, day + offset));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const dd = d.getUTCDate();

    const candidates = scheduleForCetDay(y, m, dd)
      .filter((e) => matchesRosterUser(e, userId, username))
      .map((e) => ({ ...e, start: cetToUtcDate(y, m, dd, e.startHour), end: cetToUtcDate(y, m, dd, e.endHour) }))
      .filter((e) => e.start.getTime() > nowMs)
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    if (candidates.length > 0) return { status: 'upcoming', ...candidates[0] };
  }

  return { status: 'none' };
}

// The full day's roster, sorted by start time, for the CET calendar day
// containing `date` (default now) — used by /schedule. A block ending
// exactly at midnight is extended into tomorrow's continuation (same
// person's block starting at 00:00) so it displays as one real shift
// instead of looking truncated at "24:00" — endHour can be >24 in that
// case (e.g. 28 = 04:00 the next day); callers should treat endHour > 24
// as "ends the following day" when formatting.
function getScheduleForCetDate(date = new Date()) {
  const { year, month, day, dayIdx } = cetPartsOf(date);
  const dayName = DAY_NAMES[dayIdx];

  const tomorrow = new Date(Date.UTC(year, month, day + 1));
  const tomorrowEntries = scheduleForCetDay(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate());

  const entries = scheduleForCetDay(year, month, day)
    .map((entry) => {
      if (entry.endHour !== 24) return entry;
      const continuation = tomorrowEntries.find((e) => e.username === entry.username && e.startHour === 0);
      return continuation ? { ...entry, endHour: 24 + continuation.endHour } : entry;
    })
    .sort((a, b) => a.startHour - b.startHour);

  return { dayName, entries };
}

// A person's block on one day can end exactly at midnight and pick back up
// at 00:00 the next day (e.g. a 22:00-04:00 overnight shift shows as two
// separate day-rows in the sheet: [22,23] today, [0,1,2,3] tomorrow). Those
// are one continuous shift, not two — merge any occurrence whose end lands
// exactly on the next one's start (same person) so reminder logic doesn't
// fire a false "shift ended" at the midnight seam, or a redundant "starting
// soon" for a shift they're already clocked in for.
function mergeMidnightContinuations(occurrences) {
  const byUser = new Map();
  for (const occ of occurrences) {
    if (!byUser.has(occ.username)) byUser.set(occ.username, []);
    byUser.get(occ.username).push(occ);
  }

  const merged = [];
  for (const list of byUser.values()) {
    list.sort((a, b) => a.start.getTime() - b.start.getTime());
    let current = null;
    for (const occ of list) {
      if (current && occ.start.getTime() === current.end.getTime()) {
        current.end = occ.end;
        current.endHour = occ.endHour;
      } else {
        if (current) merged.push(current);
        current = { ...occ };
      }
    }
    if (current) merged.push(current);
  }
  return merged;
}

// All block start/end occurrences (as absolute Date objects) for the CET
// calendar days spanning [-1, +2] around `date` — wide enough to safely
// catch any start/end within a same-day lookahead/lookbehind window
// (including across a midnight boundary) with room either side to resolve
// a midnight-continuation merge.
function getBlockOccurrencesAround(date = new Date()) {
  const { year, month, day } = cetPartsOf(date);
  const occurrences = [];
  for (const offset of [-1, 0, 1, 2]) {
    const d = new Date(Date.UTC(year, month, day + offset));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const dd = d.getUTCDate();
    for (const entry of scheduleForCetDay(y, m, dd)) {
      occurrences.push({
        username: entry.username,
        userId: entry.userId,
        nickname: entry.nickname,
        startHour: entry.startHour,
        endHour: entry.endHour,
        start: cetToUtcDate(y, m, dd, entry.startHour),
        end: cetToUtcDate(y, m, dd, entry.endHour),
      });
    }
  }
  return mergeMidnightContinuations(occurrences);
}

module.exports = {
  ROSTER,
  getScheduledNow,
  getBlockOccurrencesAround,
  getScheduleForCetDate,
  getNextShiftForUser,
  isRosterUser,
};
