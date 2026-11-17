import { matchMeetCommand, MEET_COMMAND } from "./plugin.js";

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`}`);
};

check("the command is /meet", MEET_COMMAND, "/meet");

// --- the matching cases ----------------------------------------------------
check("bare /meet matches", matchMeetCommand("/meet", 5), { start: 0, end: 5, query: "meet" });
check("after a space matches", matchMeetCommand("hello /meet", 11), { start: 6, end: 11, query: "meet" });
check("after a newline matches", matchMeetCommand("one\ntwo\n/meet", 13), { start: 8, end: 13, query: "meet" });
check("after an opening bracket matches", matchMeetCommand("(/meet", 6), { start: 1, end: 6, query: "meet" });
check("after a quote matches", matchMeetCommand('"/meet', 6), { start: 1, end: 6, query: "meet" });

// --- cursor behaviour ------------------------------------------------------
check("text after the cursor is ignored", matchMeetCommand("/meet and then some", 5), {
  start: 0,
  end: 5,
  query: "meet",
});
check("a cursor in the middle does not match", matchMeetCommand("/meet and then", 3), null);

// --- things that must not trigger -----------------------------------------
check("a longer word does not match", matchMeetCommand("/meeting", 8), null);
check("a trailing space ends the match", matchMeetCommand("/meet ", 6), null);
check("the bare word does not match", matchMeetCommand("meet", 4), null);
check("a path does not match", matchMeetCommand("https://example.com/meet", 23), null);
check("a suffix typed onto a word does not match", matchMeetCommand("something/meet", 13), null);
check("an empty draft does not match", matchMeetCommand("", 0), null);
check("a partial word does not match", matchMeetCommand("/mee", 4), null);
check("a null draft does not match", matchMeetCommand(null, 0), null);

// --- shape ----------------------------------------------------------------
const hit = matchMeetCommand("  /meet", 7);
check("start points at the slash", hit.start, 2);
check("end is the cursor", hit.end, 7);
check("the host replaces exactly the command", "  /meet".slice(hit.start, hit.end), "/meet");

// The matcher is called on every keystroke; it must be free of side effects.
const before = "draft /meet";
const snapshot = JSON.stringify([before, 11]);
matchMeetCommand(before, 11);
check("the matcher does not mutate its input", JSON.stringify([before, 11]), snapshot);

console.log(fail === 0 ? "\nALL CHECKS PASSED" : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
