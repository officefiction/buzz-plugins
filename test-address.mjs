import { isCalendarAddress, isPublicFeed } from "./plugin.js";

let fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — got ${got}, want ${want}`}`);
};

// The exact address that produced an empty page in the field.
const USER_PUBLIC = "https://calendar.google.com/calendar/ical/max%40officefiction.com/public/basic.ics";
const SECRET = "https://calendar.google.com/calendar/ical/max%40officefiction.com/private%2Fabc123def456/basic.ics";

check("public feed recognised", isPublicFeed(USER_PUBLIC), true);
check("secret feed is not public", isPublicFeed(SECRET), false);
check("public address is a valid iCal address", isCalendarAddress(USER_PUBLIC), true);
check("secret address is a valid iCal address", isCalendarAddress(SECRET), true);
check("rejects a foreign host", isCalendarAddress("https://example.com/x/basic.ics"), false);
check("rejects a non-iCal path", isCalendarAddress("https://calendar.google.com/calendar/u/0/r"), false);
check("empty string is not public", isPublicFeed(""), false);

console.log(fail === 0 ? "\nALL CHECKS PASSED" : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
