// Static roster parsed from the "BJ clippers.xlsx" rota. Times are fixed
// CET (UTC+1, no daylight saving) as labeled in the sheet. The rota
// alternates between two blocks by ISO week parity: odd ISO week numbers
// use WEEK1, even use WEEK2 ("Week 1 (odd)" per the sheet).
//
// To update the roster: re-export the sheet's hour flags per day/person
// into WEEK1/WEEK2 below (nickname -> array of scheduled hours, 0-23,
// CET), and keep USERNAME_MAP in sync with each person's Telegram
// @username.

const USERNAME_MAP = {
  Adko: 'Adko04',
  Draco: 'sp3ade',
  Manger: 'Mangerhom',
  Bla: 'bla2k',
  Anthony: 'antoniusrisen',
  Neo: 'neoboller',
};

const WEEK1 = {
  "Monday": {
    "Adko": [0, 1, 2, 3, 16, 17, 18, 19, 20, 21],
    "Draco": [22, 23],
    "Manger": [10, 11, 12, 13, 14, 15],
    "Bla": [],
    "Anthony": [],
    "Neo": [4, 5, 6, 7, 8, 9]
  },
  "Tuesday": {
    "Adko": [16, 17, 18, 19, 20, 21],
    "Draco": [0, 1, 2, 3],
    "Manger": [10, 11, 12, 13, 14, 15],
    "Bla": [22, 23],
    "Anthony": [],
    "Neo": [4, 5, 6, 7, 8, 9]
  },
  "Wednesday": {
    "Adko": [16, 17, 18, 19, 20, 21],
    "Draco": [22, 23],
    "Manger": [10, 11, 12, 13, 14, 15],
    "Bla": [0, 1, 2, 3],
    "Anthony": [4, 5, 6, 7, 8, 9],
    "Neo": []
  },
  "Thursday": {
    "Adko": [],
    "Draco": [16, 17, 18, 19, 20, 21],
    "Manger": [10, 11, 12, 13, 14, 15],
    "Bla": [0, 1, 2, 3, 22, 23],
    "Anthony": [],
    "Neo": [4, 5, 6, 7, 8, 9]
  },
  "Friday": {
    "Adko": [0, 1, 2, 3, 16, 17, 18, 19, 20, 21],
    "Draco": [22, 23],
    "Manger": [10, 11, 12, 13, 14, 15],
    "Bla": [0, 1, 2, 3],
    "Anthony": [],
    "Neo": [4, 5, 6, 7, 8, 9]
  },
  "Saturday": {
    "Adko": [],
    "Draco": [0, 1, 2, 3],
    "Manger": [],
    "Bla": [10, 11, 12, 13, 14, 15],
    "Anthony": [4, 5, 6, 7, 8, 9],
    "Neo": [16, 17, 18, 19, 20, 21, 22, 23]
  },
  "Sunday": {
    "Adko": [22, 23],
    "Draco": [8, 9, 10, 11, 12, 13, 14, 15, 18, 19, 20, 21],
    "Manger": [],
    "Bla": [16, 17],
    "Anthony": [0, 1, 2, 3, 4, 5, 6, 7],
    "Neo": []
  }
};

const WEEK2 = {
  "Monday": {
    "Adko": [0, 1, 2, 3, 16, 17, 18, 19, 20, 21],
    "Draco": [22, 23],
    "Manger": [10, 11, 12, 13, 14, 15],
    "Bla": [],
    "Anthony": [],
    "Neo": [4, 5, 6, 7, 8, 9]
  },
  "Tuesday": {
    "Adko": [16, 17, 18, 19, 20, 21],
    "Draco": [0, 1, 2, 3],
    "Manger": [10, 11, 12, 13, 14, 15],
    "Bla": [22, 23],
    "Anthony": [],
    "Neo": [4, 5, 6, 7, 8, 9]
  },
  "Wednesday": {
    "Adko": [16, 17, 18, 19, 20, 21],
    "Draco": [22, 23],
    "Manger": [10, 11, 12, 13, 14, 15],
    "Bla": [0, 1, 2, 3],
    "Anthony": [4, 5, 6, 7, 8, 9],
    "Neo": []
  },
  "Thursday": {
    "Adko": [22, 23],
    "Draco": [16, 17, 18, 19, 20, 21],
    "Manger": [10, 11, 12, 13, 14, 15],
    "Bla": [0, 1, 2, 3],
    "Anthony": [],
    "Neo": [4, 5, 6, 7, 8, 9]
  },
  "Friday": {
    "Adko": [0, 1, 2, 3],
    "Draco": [22, 23],
    "Manger": [10, 11, 12, 13, 14, 15],
    "Bla": [16, 17, 18, 19, 20, 21],
    "Anthony": [],
    "Neo": [4, 5, 6, 7, 8, 9]
  },
  "Saturday": {
    "Adko": [],
    "Draco": [0, 1, 2, 3],
    "Manger": [],
    "Bla": [10, 11, 12, 13, 14, 15],
    "Anthony": [4, 5, 6, 7, 8, 9],
    "Neo": [16, 17, 18, 19, 20, 21, 22, 23]
  },
  "Sunday": {
    "Adko": [22, 23],
    "Draco": [8, 9, 10, 11, 12, 13, 14, 15, 18, 19, 20, 21],
    "Manger": [],
    "Bla": [16, 17],
    "Anthony": [0, 1, 2, 3, 4, 5, 6, 7],
    "Neo": []
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
// username, startHour, endHour }], endHour possibly 24 (rolls to midnight).
function scheduleForCetDay(year, month, day) {
  const dayIdx = new Date(Date.UTC(year, month, day)).getUTCDay();
  const dayName = DAY_NAMES[dayIdx];
  const week = isoWeekNumber(Date.UTC(year, month, day));
  const weekData = (week % 2 === 1 ? WEEK1 : WEEK2)[dayName] || {};

  const entries = [];
  for (const [nickname, hours] of Object.entries(weekData)) {
    for (const [startHour, endHour] of toBlocks(hours)) {
      const username = USERNAME_MAP[nickname];
      if (!username) continue;
      entries.push({ nickname, username, startHour, endHour });
    }
  }
  return entries;
}

// Who is scheduled to be on shift at the given instant (default now).
function getScheduledNow(date = new Date()) {
  const { year, month, day, hour } = cetPartsOf(date);
  return scheduleForCetDay(year, month, day).filter((e) => hour >= e.startHour && hour < e.endHour);
}

// All block start/end occurrences (as absolute Date objects) for the CET
// calendar days spanning [-1, +1] around `date` — wide enough to safely
// catch any start/end within a same-day lookahead/lookbehind window,
// including across a midnight boundary.
function getBlockOccurrencesAround(date = new Date()) {
  const { year, month, day } = cetPartsOf(date);
  const occurrences = [];
  for (const offset of [-1, 0, 1]) {
    const d = new Date(Date.UTC(year, month, day + offset));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const dd = d.getUTCDate();
    for (const entry of scheduleForCetDay(y, m, dd)) {
      occurrences.push({
        username: entry.username,
        nickname: entry.nickname,
        startHour: entry.startHour,
        endHour: entry.endHour,
        start: cetToUtcDate(y, m, dd, entry.startHour),
        end: cetToUtcDate(y, m, dd, entry.endHour),
      });
    }
  }
  return occurrences;
}

module.exports = {
  USERNAME_MAP,
  getScheduledNow,
  getBlockOccurrencesAround,
};
