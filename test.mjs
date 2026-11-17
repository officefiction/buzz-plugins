import { parseCalendar, upcoming, occurrences } from "./plugin.js";

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "BEGIN:VEVENT",
  "DTSTART:20261117T150000Z",
  "DTEND:20261117T153000Z",
  "SUMMARY:Studio sync",
  "DESCRIPTION:Join here: https://meet.google.com/abc-defg-hij",
  "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij",
  "UID:evt-1@google.com",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/Toronto:20261118T100000",
  "DTEND;TZID=America/Toronto:20261118T110000",
  "SUMMARY:Recurring weekly",
  "RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=5",
  "EXDATE;TZID=America/Toronto:20261125T100000",
  "X-GOOGLE-CONFERENCE:https://meet.google.com/xyz-1234-abc",
  "UID:evt-2@google.com",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART;VALUE=DATE:20261120",
  "DTEND;VALUE=DATE:20261121",
  "SUMMARY:All day thing",
  "UID:evt-3@google.com",
  "END:VEVENT",
  // folded line + meet link only in DESCRIPTION
  "BEGIN:VEVENT",
  "DTSTART:20261119T180000Z",
  "DTEND:20261119T190000Z",
  "SUMMARY:A very long summary that Google folds across",
  "  two lines",
  "DESCRIPTION:Agenda\\nhttps://meet.google.com/fold-ed1-abc",
  "UID:evt-4@google.com",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const events = parseCalendar(ICS);
const now = Date.parse("2026-11-17T12:00:00Z");
const slots = upcoming(events, now, 14);

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`}`);
};

check("event count", events.length, 4);
check("folded summary", events[3].summary, "A very long summary that Google folds across two lines");
check("meet link from DESCRIPTION", events[3].meetUrl, "https://meet.google.com/fold-ed1-abc");
check("meet link from X-GOOGLE-CONFERENCE", events[0].meetUrl, "https://meet.google.com/abc-defg-hij");
check("all-day flagged", events[2].allDay, true);

// TZID -> UTC: Toronto on 2026-11-18 is EST (UTC-5), so 10:00 local is 15:00Z
check("TZID start in UTC", events[1].start.toISOString(), "2026-11-18T15:00:00.000Z");

// window Nov 17 11:00Z -> Dec 1 12:00Z
check(
  "upcoming order and times",
  slots.map((s) => [s.summary, s.start.toISOString()]),
  [
    ["Studio sync", "2026-11-17T15:00:00.000Z"],
    ["Recurring weekly", "2026-11-18T15:00:00.000Z"],
    ["A very long summary that Google folds across two lines", "2026-11-19T18:00:00.000Z"],
    ["All day thing", "2026-11-20T00:00:00.000Z"],
  ],
);

// COUNT applies to the rule, EXDATE removes the instance afterwards (RFC 5545):
// Nov 18, 25(removed), Dec 2, 9, 16 -> 4 occurrences survive
const series = occurrences(events[1], Date.parse("2026-11-01T00:00:00Z"), Date.parse("2026-12-31T00:00:00Z"));
check("weekly count minus exdate", series.length, 4);
check(
  "weekly dates",
  series.map((s) => s.start.toISOString().slice(0, 10)),
  ["2026-11-18", "2026-12-02", "2026-12-09", "2026-12-16"],
);

// duration carried to instances
check("instance duration (min)", (series[0].end - series[0].start) / 60000, 60);

// DAILY with interval, no COUNT, bounded by window
const daily = parseCalendar(
  [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "DTSTART:20261110T090000Z",
    "DTEND:20261110T091500Z",
    "SUMMARY:Standup",
    "RRULE:FREQ=DAILY;INTERVAL=2",
    "UID:daily@google.com",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n"),
)[0];
const dailySlots = occurrences(daily, Date.parse("2026-11-17T00:00:00Z"), Date.parse("2026-11-22T00:00:00Z"));
check(
  "daily interval 2",
  dailySlots.map((s) => s.start.toISOString().slice(0, 10)),
  ["2026-11-18", "2026-11-20"],
);

// UNTIL stops the series
const until = parseCalendar(
  [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "DTSTART:20261110T090000Z",
    "DTEND:20261110T091500Z",
    "SUMMARY:Bounded",
    "RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261124T090000Z",
    "UID:until@google.com",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n"),
)[0];
const untilSlots = occurrences(until, Date.parse("2026-11-01T00:00:00Z"), Date.parse("2026-12-31T00:00:00Z"));
check(
  "until bounds the series",
  untilSlots.map((s) => s.start.toISOString().slice(0, 10)),
  ["2026-11-10", "2026-11-17", "2026-11-24"],
);

console.log(fail === 0 ? "\nALL TESTS PASSED" : `\n${fail} TEST(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
