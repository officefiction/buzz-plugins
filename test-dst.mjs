import { parseCalendar, occurrences } from "./plugin.js";

// A weekly 10:00 meeting in Toronto that crosses the DST change on 2026-11-01.
// Wall-clock time must stay 10:00 local: 14:00Z before, 15:00Z after.
const ICS = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/Toronto:20261021T100000",
  "DTEND;TZID=America/Toronto:20261021T110000",
  "SUMMARY:Crosses DST",
  "RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=4",
  "UID:dst@google.com",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const event = parseCalendar(ICS)[0];
const slots = occurrences(event, Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-12-01T00:00:00Z"));

console.log("occurrence  | UTC        | Toronto local");
for (const s of slots) {
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(s.start);
  console.log(`            | ${s.start.toISOString().slice(0, 16)}Z | ${local}`);
}

const locals = slots.map((s) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", hour12: false }).format(s.start),
);
const utc = slots.map((s) => s.start.toISOString().slice(11, 16));

const stable = locals.every((t) => t === "10:00");
const shifted = utc[0] !== utc[utc.length - 1];

console.log("");
console.log(`${stable ? "PASS" : "FAIL"}  local time stays 10:00 across DST`);
console.log(`${shifted ? "PASS" : "FAIL"}  UTC offset actually changed (14:00Z -> 15:00Z)`);
process.exit(stable && shifted ? 0 : 1);
