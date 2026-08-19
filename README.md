# clipper-payclock

A Telegram bot that tracks clipper shifts in a group chat: clock in/out, periodic
"are you still here" status checks with a tap-to-confirm button, and a daily
summary report (hours worked + missed check-ins) sent privately to the bot
owner.

## Commands

- `/clockin` — start your shift
- `/clockout` — end your shift (auto-expires any check-in still pending)
- `/status [@user]` — see how long you (or someone else) have been clocked in
- `/whosonshift` — see everyone currently clocked in
- `/myhistory` — see your last 10 completed shifts
- `/checkins [@user]` — (admin only) see status-check timestamps (sent +
  confirmed) for a clipper's current or most recent shift
- `/report` — (admin only) get today's report on demand
- `/weeklyreport` — (admin only) get the trailing-7-days report on demand
- `/forceclockout @user` — (admin only) clock a clipper out; can also be used
  by replying to their message instead of naming them
- `/checknow @user` — (admin only) send an immediate status check outside the
  normal 30-min cadence; also works by replying to their message
- `/help` — list commands

## How status checks work

While a clipper is clocked in, the bot posts a message in the group every
`CHECKIN_INTERVAL_MINUTES` (default 30) tagging them with an inline
"✅ I'm here" button. They have `CHECKIN_GRACE_MINUTES` (default 5) to press
it. If they don't, it's logged as a missed check-in — the clipper stays
clocked in (nothing is auto-closed), and it shows up in the daily report.
Multiple clippers can be on shift at once; each gets their own independent
check-in schedule.

If the bot restarts, active shifts are picked back up from the database and
their check-in schedules resume automatically. Timing is anchored to the
shift's actual timeline (the last check-in sent, or clock-in if there hasn't
been one yet) rather than to the restart moment — so a restart doesn't reset
the 30-min clock and drift the schedule later with every deploy. Any
check-in left pending across a restart is marked missed (it can no longer be
verified as answered in time).

## Reports

Once a day (`DAILY_REPORT_CRON`, default midnight in `TZ`) and once a week
(`WEEKLY_REPORT_CRON`, default Monday midnight, covering the trailing 7 days),
the bot DMs the owner (`ADMIN_ID`) a summary: hours worked, number of shifts,
and confirmed vs. missed check-ins, per clipper. `/report` and `/weeklyreport`
get the same thing on demand.

**Note:** the owner (`ADMIN_ID`) must have started a DM with the bot at least
once before it can message them — Telegram bots can't message a user first.

## Long-shift safety net

If a clipper stays clocked in past `MAX_SHIFT_HOURS` (default 12) without
clocking out, the admin gets a one-time DM warning — usually means someone
forgot to run `/clockout`. From there, `/forceclockout` (reply to their
message, or `/forceclockout @username`) closes their shift for them.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather), grab the token.
2. Add the bot to your group, and **disable privacy mode** for it via
   BotFather (`/setprivacy` → Disable) so it can read the group's messages —
   otherwise it only sees commands.
3. Get your own Telegram user ID from [@userinfobot](https://t.me/userinfobot)
   and message the bot privately once so it's able to DM you.
4. Copy `.env.example` to `.env` and fill in `BOT_TOKEN` and `ADMIN_ID`
   locally if you want to test before deploying.

## Deploy to Railway

1. Push this folder to a GitHub repo (or `railway up` directly from here).
2. In Railway: New Project → Deploy from repo (or CLI).
3. Add a **Postgres** plugin to the project — Railway auto-injects
   `DATABASE_URL` into your service.
4. Set the remaining env vars on the service: `BOT_TOKEN`, `ADMIN_ID`, and
   optionally `CHECKIN_INTERVAL_MINUTES`, `CHECKIN_GRACE_MINUTES`,
   `DAILY_REPORT_CRON`, `WEEKLY_REPORT_CRON`, `TZ`, `MAX_SHIFT_HOURS`,
   `LONG_SHIFT_CHECK_CRON`.
5. Deploy. The bot calls `db.init()` on boot, so the schema (and any new
   columns) is created/migrated automatically — no manual migration step.

## Local dev

```bash
npm install
cp .env.example .env   # fill in values
npm start
```

Requires a reachable Postgres instance for `DATABASE_URL` (a local Postgres,
or point it at your Railway Postgres plugin's public connection string for
testing).
