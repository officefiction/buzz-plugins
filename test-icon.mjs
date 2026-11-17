import { meetMark } from "./plugin.js";

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`}`);
};

const idle = meetMark({ strong: "#9aa0a6", soft: "#e8eaed" });
const live = meetMark({ strong: "#fbbc04", soft: "#fef7e0" });

check("is a data URI", idle.startsWith("data:image/svg+xml,"), true);
check("carries no remote reference", /src=|href=|url\(/.test(decodeURIComponent(idle)), false);

const svg = decodeURIComponent(idle.slice("data:image/svg+xml,".length));
check("decodes to an svg element", svg.startsWith("<svg"), true);
check("declares the svg namespace", svg.includes('xmlns="http://www.w3.org/2000/svg"'), true);
check("keeps the source viewBox", svg.includes('viewBox="0 0 176 138"'), true);
check("has the four paths", (svg.match(/<path/g) ?? []).length, 4);
check("strong colour on the body", svg.includes("#9aa0a6"), true);
check("soft colour on the face", svg.includes("#e8eaed"), true);
check("no unfilled path", svg.includes('fill=""'), false);

// Draw order matters: the wing sits behind the body, as in the source file.
const order = ["102.015,81.88", "M 0,44", "M 8,71", "M 73.906,99.198"].map((needle) => svg.indexOf(needle));
check("wing before body", order[0] < order[1], true);
check("body before face", order[1] < order[2], true);
check("face before play", order[2] < order[3], true);

check("the two states differ", idle === live, false);
const liveSvg = decodeURIComponent(live.slice("data:image/svg+xml,".length));
check("live uses Google yellow", liveSvg.includes("#fbbc04"), true);
check("live soft face", liveSvg.includes("#fef7e0"), true);
check("live drops the grey", liveSvg.includes("#9aa0a6"), false);

check("output is URI safe", /[\s#<>"]/.test(idle.slice("data:image/svg+xml,".length)), false);

// Deterministic: two calls with the same colours give the same string.
check("is deterministic", meetMark({ strong: "#9aa0a6", soft: "#e8eaed" }), idle);

console.log(fail === 0 ? "\nALL CHECKS PASSED" : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
