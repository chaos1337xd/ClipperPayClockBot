// Static roster parsed from the "BJ clippers.xlsx" rota. Times are fixed
// CET (UTC+1, no daylight saving) as labeled in the sheet. The rota
// alternates between two blocks by ISO week parity: odd ISO week numbers
// use WEEK1, even use WEEK2 ("Week 1 (odd)" per the sheet).
//
// To update the roster: re-export the sheet's hour flags per day/person
// into WEEK1/WEEK2 below (nickname -> array of scheduled hours, 0-23,
// CET), and keep ROSTER in sync with each person's Telegram @username and
// numeric user ID.
//
// "Vacant" is an unfilled slot: it has no username/userId, so it shows up in
// /schedule and /whosonshift but never gets reminders or "not clocked in"
// warnings. Fill it by giving it a real username + userId (and renaming it).
//
// userId is stored directly here (not resolved from shift history at
// runtime) so reminders work even for someone who hasn't clocked in yet,
// and keep working if they later rename their @username — get a fresh ID
// from https://t.me/userinfobot if someone new joins the roster.
const ROSTER = {
  Adko: { username: 'Adko04', userId: 1632388627 },
  Draco: { username: 'Draco212', userId: 7064498111 },
  Manger: { username: 'Mangerhom', userId: 1642743726 },
  Bla: { username: 'bla2k', userId: 5996362594 },
  Vacant: { username: null, userId: null },
  CTC: { username: 'ketolanossi', userId: 8953994254 },
};

const WEEK1 = {
  "Monday": {
    "Adko": [0, 1, 2, 3, 16, 17, 18, 19, 20, 21],
    "Draco": [22, 23],
    "Manger": [10, 11, 12, 13, 14, 15],
    "Bla": [],
    "Vacant": [],
    "CTC": [4, 5, 6, 7, 8, 9]
  },
  "Tuesday": {
    "Adko": [16, 17, 18, 19, 20, 21],
    "Draco": [0, 1, 2, 3],
    "Manger": [10, 11, 12, 13, 14, 15],
    "Bla": [22, 23],
    "Vacant": [],
    "CTC": [4, 5, 6, 7, 8, 9]
  },
  "Wednesday": {
    "Adko": [16, 17, 18, 19, 20, 21],
    "Draco": [22, 23],
    "Manger": [10, 11, 12, 13, 14, 15],
    "Bla": [0, 1, 2, 3],
    "Vacant": [4, 5, 6, 7, 8, 9],
    "CTC": []
  },
  "Thursday": {
    "Adko": [],
    "Draco": [16, 17, 18, 19, 20, 21],
    "Manger": [10, 11, 12, 13, 14, 15],
    "Bla": [0, 1, 2, 3, 22, 23],
    "Vacant": [],
    "CTC": [4, 5, 6, 7, 8, 9]
  },
  "Friday": {
    "Adko": [0, 1, 2, 3, 16, 17, 18, 19, 20, 21],
    "Draco": [22, 23],
    "Manger": [10, 11, 12, 13, 14, 15],
    "Bla": [0, 1, 2, 3],
    "Vacant": [],
    "CTC": [4, 5, 6, 7, 8, 9]
  },
  "Saturday": {
    "Adko": [],
    "Draco": [0, 1, 2, 3],
    "Manger": [],
    "Bla": [10, 11, 12, 13, 14, 15],
    "Vacant": [4, 5, 6, 7, 8, 9],
    "CTC": [16, 17, 18, 19, 20, 21, 22, 23]
  },
  "Sunday": {
    "Adko": [22, 23],
    "Draco": [8, 9, 10, 11, 12, 13, 14, 15, 18, 19, 20, 21],
    "Manger": [],
    "Bla": [16, 17],
    "Vacant": [0, 1, 2, 3, 4, 5, 6, 7],
    "CTC": []
  }
};

const WEEK2 = {
  "Monday": {
    "Adko": [0, 1, 2, 3, 16, 17, 18, 19, 20, 21],
    "Draco": [22, 23],
    "Manger": [10, 11, 12, 13, 14, 15],
    "Bla": [],
    "Vacant": [],
    "CTC": [4, 5, 6, 7, 8, 9]
  },
  "Tuesday": {
    "Adko": [16, 17, 18, 19, 20, 21],
    "Draco": [0, 1, 2, 3],
    "Manger": [10, 11, 12, 13, 14, 15],
    "Bla": [22, 23],
    "Vacant": [],
    "CTC": [4, 5, 6, 7, 8, 9]
  },
  "Wednesday": {
    "Adko": [16, 17, 18, 19, 20, 21],
    "Draco": [22, 23],
    "Manger": [10, 11, 12, 13, 14, 15],
    "Bla": [0, 1, 2, 3],
    "Vacant": [4, 5, 6, 7, 8, 9],
    "CTC": []
  },
  "Thursday": {
    "Adko": [],
    "Draco": [16, 17, 18, 19, 20, 21],
    "Manger": [10, 11, 12, 13, 14, 15],
    "Bla": [0, 1, 2, 3, 22, 23],
    "Vacant": [],
    "CTC": [4, 5, 6, 7, 8, 9]
  },
  "Friday": {
    "Adko": [16, 17, 18, 19, 20, 21],
    "Draco": [22, 23],
    "Manger": [10, 11, 12, 13, 14, 15],
    "Bla": [0, 1, 2, 3],
    "Vacant": [],
    "CTC": [4, 5, 6, 7, 8, 9]
  },
  "Saturday": {
    "Adko": [],
    "Draco": [0, 1, 2, 3],
    "Manger": [],
    "Bla": [10, 11, 12, 13, 14, 15],
    "Vacant": [4, 5, 6, 7, 8, 9],
    "CTC": [16, 17, 18, 19, 20, 21, 22, 23]
  },
  "Sunday": {
    "Adko": [22, 23],
    "Draco": [8, 9, 10, 11, 12, 13, 14, 15, 18, 19, 20, 21],
    "Manger": [],
    "Bla": [16, 17],
    "Vacant": [0, 1, 2, 3, 4, 5, 6, 7],
    "CTC": []
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

function isoWeekNumber(utcMs) {
  const d = new Date(utcMs);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
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
  const week = isoWeekNumber(Date.UTC(year, month, day));
  const weekData = (week % 2 === 1 ? WEEK1 : WEEK2)[dayName] || {};

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

// For /whensmynextshift: either they're on shift right now
// ({ status: 'now', entry }), their next upcoming block within the next 14
// days — a full rotation, since the roster alternates weekly
// ({ status: 'upcoming', start, end, ...entry }), or they're not on the
// roster at all ({ status: 'none' }).
function getNextShiftForUser(userId, from = new Date()) {
  const nowMs = from.getTime();
  const { year, month, day, hour } = cetPartsOf(from);

  const todaysBlocks = scheduleForCetDay(year, month, day).filter((e) => e.userId === userId);
  const current = todaysBlocks.find((e) => hour >= e.startHour && hour < e.endHour);
  if (current) return { status: 'now', entry: current };

  for (let offset = 0; offset <= 14; offset++) {
    const d = new Date(Date.UTC(year, month, day + offset));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const dd = d.getUTCDate();

    const candidates = scheduleForCetDay(y, m, dd)
      .filter((e) => e.userId === userId)
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
  const week = isoWeekNumber(Date.UTC(year, month, day));

  const tomorrow = new Date(Date.UTC(year, month, day + 1));
  const tomorrowEntries = scheduleForCetDay(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate());

  const entries = scheduleForCetDay(year, month, day)
    .map((entry) => {
      if (entry.endHour !== 24) return entry;
      const continuation = tomorrowEntries.find((e) => e.username === entry.username && e.startHour === 0);
      return continuation ? { ...entry, endHour: 24 + continuation.endHour } : entry;
    })
    .sort((a, b) => a.startHour - b.startHour);

  return { dayName, weekParity: week % 2 === 1 ? 'odd' : 'even', entries };
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
};
