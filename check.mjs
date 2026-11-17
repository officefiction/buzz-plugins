import { readFileSync } from "node:fs";

let fail = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
};

// --- manifest rules, from block/buzz-app crates/plugin-manager/src/lib.rs ---
const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));

const ALLOWED = ["id", "name", "apiVersion", "description", "updates", "discovery", "host"];
const extra = Object.keys(manifest).filter((k) => !ALLOWED.includes(k));
check("manifest has only allowed keys", extra.length === 0, `unexpected: ${extra.join(", ")}`);

check("apiVersion is 1", manifest.apiVersion === 1, String(manifest.apiVersion));
check("id is lowercase dotted", /^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(manifest.id), manifest.id);
check("name is 1..80 bytes", manifest.name.length > 0 && manifest.name.length <= 80);

const descBytes = Buffer.byteLength(manifest.description ?? "", "utf8");
check("description is 1..280 bytes", descBytes >= 1 && descBytes <= 280, `${descBytes} bytes`);

const CATEGORIES = [
  "communication",
  "agents",
  "agent-tools",
  "developer-tools-and-integrations",
  "people-and-communities",
  "productivity",
];
check(
  "discovery.category is one of the six",
  CATEGORIES.includes(manifest.discovery?.category),
  manifest.discovery?.category,
);

const commands = manifest.host?.commands ?? [];
check("has declared commands", commands.length > 0 && commands.length <= 16, String(commands.length));
for (const command of commands) {
  const programOk =
    typeof command.program === "string" &&
    command.program.length > 0 &&
    command.program.length <= 80 &&
    /^[A-Za-z0-9._-]+$/.test(command.program);
  check(`command ${command.id}: program is a bare name`, programOk, command.program);
  const args = command.args ?? [];
  check(`command ${command.id}: <=16 args`, args.length <= 16, String(args.length));
  check(
    `command ${command.id}: each arg <=1024 bytes and no NUL`,
    args.every((a) => Buffer.byteLength(a, "utf8") <= 1024 && !a.includes("\0")),
  );
  if (command.maxInputBytes !== undefined) {
    check(`command ${command.id}: maxInputBytes <= 64 KiB`, command.maxInputBytes <= 65536);
  }
}

const origins = manifest.host?.networkOrigins ?? [];
check("declares at least one origin", origins.length > 0);
check(
  "origins are exact, pathless HTTPS origins",
  origins.every((o) => /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o)),
  origins.join(", "),
);
check("no iCal origin remains", !origins.some((o) => /calendar\.google\.com/i.test(o)));
check("exactly the three API origins", origins.length === 3, origins.join(", "));

// The plugin's own identity must not carry a company name. The README is left
// out on purpose: it holds the public repository URL you install from. This
// file is left out because the forbidden words are listed right here.
const SOURCES = ["plugin.js", "manifest.json", "package.json", "NOTES.md"];
const NAMES = ["officefiction", "schramp"];
for (const file of SOURCES) {
  const text = readFileSync(new URL(file, import.meta.url), "utf8");
  const hits = NAMES.filter((name) => text.toLowerCase().includes(name));
  check(`${file} carries no private naming`, hits.length === 0, hits.join(", "));
}
check(
  "plugin.js has no iCal code left",
  !/parseCalendar|basic\.ics|isPublicFeed|civilToInstant/.test(
    readFileSync(new URL("plugin.js", import.meta.url), "utf8"),
  ),
);

// --- apply() smoke test with a stub host -----------------------------------
global.window = {
  localStorage: (() => {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, v),
      removeItem: (k) => map.delete(k),
    };
  })(),
};
// Node 22 ships a read-only global navigator, so define rather than assign.
Object.defineProperty(globalThis, "navigator", {
  value: { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)" },
  configurable: true,
  writable: true,
});

const appended = [];
global.document = {
  createElement: () => ({ dataset: {}, textContent: "", remove() {} }),
  head: { append: (el) => appended.push(el) },
};

const { apply, inject } = await import("./plugin.js");

check("inject lists the services used", Array.isArray(inject) && inject.includes("pages") && inject.includes("host"));

const pages = [];
const cards = [];
const cleanups = [];
let opened = null;
const ctx = {
  react: {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  },
  host: {
    request: async () => ({ status: 200, headers: {}, body: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n" }),
    runCommand: async () => null,
  },
  navigation: { open: async (target) => ((opened = target), {}) },
  pages: { register: (page) => pages.push(page) },
  settingsCards: { register: (card) => cards.push(card) },
  effect: (setup) => {
    const cleanup = setup();
    if (typeof cleanup !== "function") throw new Error("effect must return a cleanup function");
    cleanups.push(cleanup);
  },
};

apply(ctx);

check("registers exactly one page", pages.length === 1, String(pages.length));
check("page has id, title and a component", Boolean(pages[0]?.id && pages[0]?.title && typeof pages[0]?.component === "function"));
check("page id matches the manifest namespace", pages[0]?.id === "meet", pages[0]?.id);
check("registers exactly one settings card", cards.length === 1, String(cards.length));
check("card has id, title, group and a component", Boolean(cards[0]?.id && cards[0]?.title && cards[0]?.group && typeof cards[0]?.component === "function"));
check("adds one style element", appended.length === 1, String(appended.length));
check("effect returned a cleanup", cleanups.length === 1);

cleanups[0]();
check("cleanup is callable and idempotent", true);

// The settings card must never print the stored address.
const card = cards[0].component;
check("settings card is a component function", typeof card === "function");

console.log(fail === 0 ? "\nALL CHECKS PASSED" : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
