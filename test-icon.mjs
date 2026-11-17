import { meetMarkShapes } from "./plugin.js";

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`}`);
};
const ok = (name, value, detail = "") => {
  if (!value) fail += 1;
  console.log(`${value ? "PASS" : "FAIL"}  ${name}${value || !detail ? "" : ` — ${detail}`}`);
};

const idle = meetMarkShapes({ strong: "#9aa0a6", soft: "#ffffff" });
const live = meetMarkShapes({ strong: "#fbbc04", soft: "#ffffff" });

// The source draws the horn first so the body covers its tip, then the dot.
check("three shapes", idle.length, 3);
check("source draw order", idle.map((s) => s.name), ["horn", "body", "dot"]);
check("two paths and a circle", idle.map((s) => s.kind), ["path", "body", "circle"].map((k) => (k === "body" ? "path" : k)));

const [horn, body, dot] = idle;
ok("the horn is a path with geometry", horn.kind === "path" && horn.d.startsWith("M"));
ok("the body is a path with geometry", body.kind === "path" && body.d.startsWith("M"));
check("the dot is a circle", dot.kind, "circle");
check("the dot sits lower left", [dot.cx, dot.cy, dot.r], [30, 108, 14]);

check("horn takes the state colour", horn.fill, "#9aa0a6");
check("body takes the state colour", body.fill, "#9aa0a6");
check("the dot stays white", dot.fill, "#ffffff");

// The mask shape and the blurred glow must not be drawn.
const all = JSON.stringify(idle);
ok("the mask path is not drawn", !all.includes("M 8,71"), "found the mask rounded rect");
ok("the blurred glow is not drawn", !all.includes("183.906,36"), "found the pink glow triangle");
ok("no remote reference", !/https?:/.test(all));

check("live uses Google yellow", live[1].fill, "#fbbc04");
check("the two states differ", all === JSON.stringify(live), false);
check(
  "geometry is identical between states",
  idle.map((s) => s.d ?? `${s.cx},${s.cy},${s.r}`).join("|"),
  live.map((s) => s.d ?? `${s.cx},${s.cy},${s.r}`).join("|"),
);

console.log(fail === 0 ? "\nALL CHECKS PASSED" : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
