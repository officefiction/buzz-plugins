/**
 * Meet — a Buzz plugin.
 *
 * Shows the next Google Meet calls from a Google Calendar and hands the Join
 * button to the browser. Meet cannot be embedded: meet.google.com answers
 * X-Frame-Options: DENY, so the frame would never paint. A link is the honest
 * shape, and the host already opens external links in the user's browser.
 *
 * The credential is the calendar's "secret address in iCal format": one pasted
 * string, no OAuth, never expires. It reaches calendar.google.com and nowhere
 * else — ctx.host.request refuses any other origin.
 *
 * API v1, written against block/buzz-app (docs/plugin-architecture.md).
 * Plain ES module: Buzz never runs a build.
 */

export const inject = ["react", "pages", "settingsCards", "navigation", "host"];

const PLUGIN_ID = "com.officefiction.meet";
const SETTINGS_SECTION = PLUGIN_ID + "/settings";
const CALENDAR_ORIGIN = "https://calendar.google.com";
const STORAGE_KEY = PLUGIN_ID + ".ical-url.v1";
const MEET_LINK = /https:\/\/meet\.google\.com\/[a-z0-9-]{5,}/i;
const LOOKAHEAD_DAYS = 14;
const REFRESH_MS = 60_000;

// ---------------------------------------------------------------------------
// Credential store
//
// Buzz has no credential API for plugins. Where the system has a store a
// declared command can reach — the macOS Keychain, the Linux Secret Service —
// the address goes there. Otherwise it sits in this profile's localStorage in
// plain text, and the settings card says so in those words.
// ---------------------------------------------------------------------------

const STORES = {
  keychain: {
    read: "keychain-read",
    save: "keychain-save",
    del: "keychain-delete",
    // `-w` with no value makes `security` read the password twice from stdin.
    input: (v) => v + "\n" + v + "\n",
    plainFallback: false,
  },
  "secret-service": {
    read: "secret-read",
    save: "secret-save",
    del: "secret-delete",
    input: (v) => v,
    plainFallback: true,
  },
};

const STORE_LABEL = {
  keychain: "your Keychain",
  "secret-service": "the system secret store",
};

function detectStore(platform, userAgent) {
  const p = platform || "";
  const ua = userAgent || "";
  if (/^Mac/i.test(p) || /Macintosh/.test(ua)) return "keychain";
  if ((/^Linux/i.test(p) || /Linux/.test(ua)) && !/Android/i.test(ua)) return "secret-service";
  return undefined;
}

const stripBreak = (s) => (s == null ? undefined : s.replace(/\r?\n$/, "")) || undefined;

function createCredentials({ storage, run, store }) {
  const driver = run && store ? STORES[store] : undefined;
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => fn());
  let value;
  let place;
  let started;

  const call = (id, input) => (run ? run(id, input).catch(() => null) : Promise.resolve(null));

  const profileGet = () => {
    try {
      return storage.getItem(STORAGE_KEY) || undefined;
    } catch {
      return undefined;
    }
  };
  const profileSet = (v) => {
    try {
      storage.setItem(STORAGE_KEY, v);
    } catch {
      /* a profile that refuses the write leaves the value in memory only */
    }
  };
  const profileDrop = () => {
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {
      /* nothing to undo */
    }
  };

  async function readStore() {
    if (!driver) return undefined;
    return stripBreak(await call(driver.read));
  }

  // A save is trusted only after reading it back: `security` and `secret-tool`
  // exit 0 in cases where nothing was kept.
  async function toStore(v) {
    if (!driver) return false;
    await call(driver.save, driver.input(v));
    if ((await readStore()) !== v) return false;
    profileDrop();
    return true;
  }

  async function load(initial) {
    const kept = await readStore();
    const plain = profileGet();
    if (kept && (plain === undefined || plain === kept || !(driver && driver.plainFallback))) {
      value = kept;
      place = store;
      if (plain !== undefined) profileDrop();
    } else if (plain !== undefined) {
      value = plain;
      place = "profile";
      if (driver && (await toStore(plain))) place = store;
    } else {
      value = undefined;
      place = undefined;
    }
    if (initial || value !== undefined) notify();
  }

  return {
    get ready() {
      return (started ||= load(true));
    },
    has: () => value !== undefined,
    place: () => place,
    store: () => store,
    read: () => value,
    async save(v) {
      await this.ready;
      if (driver && (await toStore(v))) {
        value = v;
        place = store;
        notify();
        return { kept: true, degraded: false };
      }
      if (driver && !driver.plainFallback) return { kept: false, degraded: false };
      profileSet(v);
      value = v;
      place = "profile";
      notify();
      return { kept: true, degraded: Boolean(driver) };
    },
    async clear() {
      await this.ready;
      profileDrop();
      if (driver) await call(driver.del);
      const left = (await readStore()) || profileGet();
      value = left;
      place = left ? (left === (await readStore()) ? store : "profile") : undefined;
      notify();
      return left === undefined;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// ---------------------------------------------------------------------------
// iCalendar reading
//
// Only what a Google Calendar export needs: unfolded lines, UTC and zoned
// start times, the Meet link Google puts in X-GOOGLE-CONFERENCE, and the
// recurrence rules a real calendar uses (DAILY/WEEKLY/MONTHLY, INTERVAL,
// COUNT, UNTIL, BYDAY, BYMONTHDAY, EXDATE).
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const WEEKDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function unfold(text) {
  return String(text).replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

function splitLine(line) {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const pieces = head.split(";");
  const params = {};
  for (const piece of pieces.slice(1)) {
    const eq = piece.indexOf("=");
    if (eq > 0) params[piece.slice(0, eq).toUpperCase()] = piece.slice(eq + 1);
  }
  return { name: pieces[0].toUpperCase(), params, value: line.slice(colon + 1) };
}

// The offset a named zone had at a given instant, from the platform's own tz db.
function zoneOffset(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return (
    Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second")) -
    instant
  );
}

function zonedToUtc([y, mo, d, h, mi, s], timeZone) {
  let guess = Date.UTC(y, mo, d, h, mi, s);
  for (let i = 0; i < 2; i += 1) guess = Date.UTC(y, mo, d, h, mi, s) - zoneOffset(guess, timeZone);
  return new Date(guess);
}

// A calendar time is held as civil (wall-clock) time plus a zone, never as a
// bare instant: a weekly 10:00 meeting has to stay 10:00 after the clocks
// change, which a fixed UTC offset cannot do.
function parseDate(value, params) {
  const raw = String(value).trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (dateOnly) {
    return {
      civil: Date.UTC(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3]),
      timeZone: undefined,
      allDay: true,
    };
  }
  const full = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(raw);
  if (!full) return null;
  const civil = Date.UTC(+full[1], +full[2] - 1, +full[3], +full[4], +full[5], +full[6]);
  if (full[7] === "Z") return { civil, timeZone: undefined, allDay: false };
  if (params.TZID) {
    try {
      // Trust a zone name only if the platform's tz db knows it.
      new Intl.DateTimeFormat("en-US", { timeZone: params.TZID }).format(0);
      return { civil, timeZone: params.TZID, allDay: false };
    } catch {
      /* an unknown zone falls through to the device's own */
    }
  }
  return { civil, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, allDay: false };
}

/** The instant a civil time names in a zone. No zone means the civil time is UTC. */
function civilToInstant(civil, timeZone) {
  if (!timeZone) return new Date(civil);
  const d = new Date(civil);
  return zonedToUtc(
    [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()],
    timeZone,
  );
}

function parseRule(text) {
  const rule = {};
  for (const piece of String(text).split(";")) {
    const eq = piece.indexOf("=");
    if (eq > 0) rule[piece.slice(0, eq).toUpperCase()] = piece.slice(eq + 1);
  }
  return rule;
}

function readEvent(lines) {
  const event = { exdateEntries: [], recurrenceIds: [] };
  let raw = "";
  for (const line of lines) {
    const parsed = splitLine(line);
    if (!parsed) continue;
    raw += line + "\n";
    switch (parsed.name) {
      case "UID":
        event.uid = parsed.value;
        break;
      case "SUMMARY":
        event.summary = parsed.value.replace(/\\,/g, ",").replace(/\\n/gi, " ").trim();
        break;
      case "LOCATION":
        event.location = parsed.value.replace(/\\,/g, ",").trim();
        break;
      case "DESCRIPTION":
        event.description = parsed.value;
        break;
      case "DTSTART": {
        const start = parseDate(parsed.value, parsed.params);
        if (start) {
          event.startCivil = start.civil;
          event.timeZone = start.timeZone;
          event.allDay = start.allDay;
        }
        break;
      }
      case "DTEND": {
        const end = parseDate(parsed.value, parsed.params);
        if (end) event.endCivil = end.civil;
        break;
      }
      case "RRULE":
        event.rrule = parsed.value;
        break;
      case "EXDATE":
        for (const piece of parsed.value.split(",")) {
          const ex = parseDate(piece, parsed.params);
          if (ex) event.exdateEntries.push(ex);
        }
        break;
      case "RECURRENCE-ID": {
        const rec = parseDate(parsed.value, parsed.params);
        if (rec) event.recurrenceIds.push(rec.civil);
        break;
      }
      case "X-GOOGLE-CONFERENCE": {
        const link = MEET_LINK.exec(parsed.value);
        if (link) event.meetUrl = link[0];
        break;
      }
      default:
        break;
    }
  }
  if (!event.meetUrl) {
    const found = MEET_LINK.exec(raw);
    if (found) event.meetUrl = found[0];
  }
  if (event.startCivil == null) return null;
  // EXDATE names an instant; the zone it was written in decides which one.
  event.exdates = event.exdateEntries.map((entry) =>
    civilToInstant(entry.civil, entry.timeZone ?? event.timeZone).getTime(),
  );
  event.start = civilToInstant(event.startCivil, event.timeZone);
  return event;
}

export function parseCalendar(text) {
  const lines = unfold(text).split("\n");
  const events = [];
  let current = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = [];
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) {
        const event = readEvent(current);
        if (event) events.push(event);
      }
      current = null;
      continue;
    }
    if (current) current.push(line);
  }
  return events;
}

// Occurrence start times inside [from, to], honouring the rule and EXDATE.
// Candidates are stepped in civil time so the wall clock holds still across a
// DST change; each one is then placed in its zone to get a real instant.
export function occurrences(event, from, to) {
  const civilStart = event.startCivil;
  const durCivil = event.endCivil != null ? event.endCivil - civilStart : 0;
  const exdates = new Set(event.exdates);
  const instant = (civil) => civilToInstant(civil, event.timeZone).getTime();
  const inside = (civil) => {
    const t = instant(civil);
    return t >= from && t <= to && !exdates.has(t);
  };
  const make = (civil) => ({
    start: new Date(instant(civil)),
    end: new Date(instant(civil + durCivil)),
    summary: event.summary,
    location: event.location,
    meetUrl: event.meetUrl,
    uid: event.uid,
    allDay: event.allDay,
  });

  if (!event.rrule) return inside(civilStart) ? [make(civilStart)] : [];

  const rule = parseRule(event.rrule);
  const freq = (rule.FREQ || "").toUpperCase();
  const interval = Math.max(1, Number(rule.INTERVAL || 1) || 1);
  const count = rule.COUNT ? Number(rule.COUNT) : null;
  const untilParsed = rule.UNTIL ? parseDate(rule.UNTIL, {}) : null;
  const until = untilParsed ? civilToInstant(untilParsed.civil, untilParsed.timeZone).getTime() : null;
  const byDay = rule.BYDAY
    ? rule.BYDAY.split(",")
        .map((token) => WEEKDAY[token.slice(-2).toUpperCase()])
        .filter((d) => d !== undefined)
    : null;
  const byMonthDay = rule.BYMONTHDAY ? Number(rule.BYMONTHDAY) : null;

  const out = [];
  let emitted = 0;
  let halted = false;

  // COUNT bounds the rule's own generation and UNTIL bounds the series; both
  // stop every later candidate. EXDATE removes an instance from the set after
  // COUNT has been applied, which is what RFC 5545 specifies.
  const push = (civil) => {
    if (halted) return false;
    const t = instant(civil);
    if (count !== null && emitted >= count) {
      halted = true;
      return false;
    }
    if (until !== null && t > until) {
      halted = true;
      return false;
    }
    emitted += 1;
    if (inside(civil)) out.push(make(civil));
    return true;
  };

  if (freq === "DAILY") {
    for (let step = 0; step < 5000 && !halted; step += 1) {
      const civil = civilStart + step * interval * DAY_MS;
      if (instant(civil) > to) break;
      push(civil);
    }
  } else if (freq === "WEEKLY") {
    const baseWeekday = new Date(civilStart).getUTCDay();
    const days = byDay ?? [baseWeekday];
    for (let week = 0; week < 800 && !halted; week += 1) {
      const base = civilStart + week * interval * 7 * DAY_MS;
      if (instant(base) > to) break;
      for (const day of days) {
        const civil = base + (day - baseWeekday) * DAY_MS;
        if (civil < civilStart) continue;
        if (instant(civil) > to) continue;
        if (!push(civil)) break;
      }
    }
  } else if (freq === "MONTHLY" || freq === "YEARLY") {
    const stepMonths = freq === "YEARLY" ? 12 * interval : interval;
    const anchor = new Date(civilStart);
    for (let step = 0; step < 600 && !halted; step += 1) {
      const civil = Date.UTC(
        anchor.getUTCFullYear(),
        anchor.getUTCMonth() + step * stepMonths,
        byMonthDay ?? anchor.getUTCDate(),
        anchor.getUTCHours(),
        anchor.getUTCMinutes(),
        anchor.getUTCSeconds(),
      );
      if (instant(civil) > to) break;
      if (byDay && !byDay.includes(new Date(civil).getUTCDay())) continue;
      push(civil);
    }
  } else {
    return inside(civilStart) ? [make(civilStart)] : [];
  }
  return out;
}

// Everything from a calendar that starts between now and the lookahead, soonest first.
export function upcoming(events, now, days = LOOKAHEAD_DAYS) {
  const from = now - 60 * 60 * 1000;
  const to = now + days * DAY_MS;
  const list = [];
  const seen = new Set();
  for (const event of events) {
    for (const slot of occurrences(event, from, to)) {
      const key = `${slot.uid || ""}|${slot.start.getTime()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(slot);
    }
  }
  return list.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function isCalendarAddress(value) {
  return /^https:\/\/calendar\.google\.com\/calendar\/ical\/[^\s]+\/basic\.ics$/i.test(value.trim());
}

// Google's public feed is not the same data as the secret one: every event that
// is not public arrives as SUMMARY:Busy with no details and no Meet link, and
// Google caches it hard.
export function isPublicFeed(value) {
  return /\/public\/basic\.ics$/i.test(String(value ?? "").trim());
}

export { isCalendarAddress };

async function fetchCalendar(host, address) {
  const response = await host.request({
    url: address,
    method: "GET",
    headers: { Accept: "text/calendar" },
  });
  if (response.status === 404) throw new Error("gone");
  if (response.status === 401 || response.status === 403) throw new Error("denied");
  if (response.status >= 400) throw new Error("server");
  return parseCalendar(response.body);
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function relative(target, now) {
  const minutes = Math.round((target - now) / 60_000);
  if (minutes < -1) return `started ${Math.abs(minutes)} min ago`;
  if (minutes <= 0) return "starting now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} d`;
}

function when(slot, now) {
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const day = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
  if (slot.allDay) return "All day";
  const sameDay = new Date(now).toDateString() === slot.start.toDateString();
  return `${sameDay ? "" : day.format(slot.start) + " · "}${time.format(slot.start)} – ${time.format(slot.end)}`;
}

// ---------------------------------------------------------------------------
// Styles — host tokens only, with fallbacks, so the plugin follows the theme.
// ---------------------------------------------------------------------------

const CSS = `
.ofm-page { padding: 24px; max-width: 720px; color: var(--text-standard, inherit); }
.ofm-lead { font-size: 13px; opacity: 0.72; margin: 0 0 20px; }
.ofm-card { border: 1px solid var(--border-subtle, rgba(128,128,128,0.24)); border-radius: 12px; padding: 18px; background: var(--surface-popover, transparent); }
.ofm-card-next { border-color: var(--accent-9, currentColor); }
.ofm-kicker { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.7; margin: 0 0 6px; }
.ofm-title { font-size: 17px; font-weight: 600; margin: 0 0 6px; }
.ofm-meta { font-size: 13px; opacity: 0.8; margin: 0 0 2px; }
.ofm-actions { display: flex; gap: 10px; align-items: center; margin-top: 16px; flex-wrap: wrap; }
.ofm-join { display: inline-block; padding: 8px 16px; border-radius: 8px; background: var(--accent-9, #ff8b1a); color: var(--accent-contrast, #fff); font-weight: 600; font-size: 13px; text-decoration: none; }
.ofm-join:hover { background: var(--affordance-backdrop-pressed, var(--accent-9, #ff8b1a)); }
.ofm-button { padding: 7px 14px; border-radius: 8px; border: 1px solid var(--border-subtle, rgba(128,128,128,0.32)); background: transparent; color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
.ofm-button:hover { background: var(--affordance-backdrop-pressed, rgba(128,128,128,0.12)); }
.ofm-button:focus-visible { outline: 2px solid var(--border-focus, currentColor); outline-offset: 2px; }
.ofm-list { list-style: none; padding: 0; margin: 16px 0 0; display: flex; flex-direction: column; gap: 8px; }
.ofm-row { display: flex; gap: 14px; align-items: baseline; padding: 10px 12px; border-radius: 8px; }
.ofm-row:hover { background: var(--affordance-backdrop-pressed, rgba(128,128,128,0.08)); }
.ofm-row-time { font-variant-numeric: tabular-nums; font-size: 12px; opacity: 0.75; min-width: 116px; }
.ofm-row-title { font-size: 13px; flex: 1; }
.ofm-row-join { font-size: 12px; color: var(--accent-9, inherit); text-decoration: none; }
.ofm-error { color: var(--text-standard, inherit); opacity: 0.85; font-size: 13px; }
.ofm-field { display: block; width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border-subtle, rgba(128,128,128,0.32)); background: transparent; color: inherit; font: inherit; font-size: 13px; }
.ofm-field:focus-visible { outline: 2px solid var(--border-focus, currentColor); outline-offset: 1px; }
.ofm-label { display: block; font-size: 13px; font-weight: 600; margin: 0 0 6px; }
.ofm-hint { font-size: 12px; opacity: 0.72; margin: 8px 0 0; line-height: 1.5; }
.ofm-status { font-size: 12px; margin: 12px 0 0; opacity: 0.8; }
`;

// ---------------------------------------------------------------------------
// Pages and cards
// ---------------------------------------------------------------------------

function createMeetPage({ React, credentials, host, openSettings }) {
  const { useState, useEffect, useCallback } = React;
  const h = React.createElement;

  return function MeetPage() {
    const [state, setState] = useState({ status: "loading" });
    const [tick, setTick] = useState(0);

    const load = useCallback(async () => {
      await credentials.ready;
      const address = credentials.read();
      if (!address) {
        setState({ status: "unconfigured" });
        return;
      }
      try {
        const events = await fetchCalendar(host, address);
        setState({
          status: "ready",
          slots: upcoming(events, Date.now()),
          read: events.length,
          redacted: events.length > 0 && events.every((event) => event.summary === "Busy"),
          lastStart: events.length
            ? new Date(Math.max(...events.map((event) => event.start.getTime())))
            : null,
          publicFeed: isPublicFeed(address),
        });
      } catch (error) {
        setState({ status: "error", reason: error.message });
      }
    }, []);

    useEffect(() => {
      let alive = true;
      const run = () => {
        if (alive) void load();
      };
      run();
      const timer = setInterval(run, REFRESH_MS);
      const clock = setInterval(() => alive && setTick((n) => n + 1), 30_000);
      return () => {
        alive = false;
        clearInterval(timer);
        clearInterval(clock);
      };
    }, [load]);

    if (state.status === "loading") {
      return h("div", { className: "ofm-page" }, h("p", { className: "ofm-lead" }, "Reading your calendar…"));
    }

    if (state.status === "unconfigured") {
      return h(
        "div",
        { className: "ofm-page" },
        h("h2", { className: "ofm-title" }, "Your calendar is not connected"),
        h(
          "p",
          { className: "ofm-lead" },
          "Paste your calendar's secret iCal address once. No password, no Google sign-in, and it does not expire.",
        ),
        h("button", { className: "ofm-button", onClick: openSettings, type: "button" }, "Open Meet settings"),
      );
    }

    if (state.status === "error") {
      const message =
        state.reason === "gone" || state.reason === "denied"
          ? "Google refused that calendar address. Check it in Settings — a reset calendar has a new address."
          : "Could not read the calendar just now. It will try again in a minute.";
      return h(
        "div",
        { className: "ofm-page" },
        h("p", { className: "ofm-error" }, message),
        h(
          "div",
          { className: "ofm-actions" },
          h("button", { className: "ofm-button", onClick: () => void load(), type: "button" }, "Try now"),
          h("button", { className: "ofm-button", onClick: openSettings, type: "button" }, "Open settings"),
        ),
      );
    }

    const now = Date.now();
    const [next, ...rest] = state.slots ?? [];

    if (!next) {
      // Say what was actually read. "Nothing here" and "nothing readable here"
      // look identical otherwise, and the second one is a setup fault.
      const notes = [];
      if (state.publicFeed) {
        notes.push(
          "This is the calendar's public address. Google hides event details from it: every event arrives as “Busy”, with no summary and no Meet link.",
        );
        notes.push(
          "Use the secret address instead — Google Calendar → Settings and sharing → Integrate calendar → Secret address in iCal format.",
        );
      } else if (!state.read) {
        notes.push("The feed was read, but it holds no events.");
      } else {
        const last = state.lastStart
          ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(state.lastStart)
          : "an unknown date";
        notes.push(
          `Read ${state.read} event${state.read === 1 ? "" : "s"}; the latest starts ${last}. Nothing starts in the next ${LOOKAHEAD_DAYS} days.`,
        );
      }
      return h(
        "div",
        { className: "ofm-page" },
        h("h2", { className: "ofm-title" }, "Nothing coming up"),
        notes.map((text, index) => h("p", { className: "ofm-lead", key: index }, text)),
        h(
          "div",
          { className: "ofm-actions" },
          h("button", { className: "ofm-button", onClick: openSettings, type: "button" }, "Open settings"),
        ),
      );
    }

    const join = next.meetUrl
      ? h(
          "a",
          {
            className: "ofm-join",
            href: next.meetUrl,
            target: "_blank",
            rel: "noopener noreferrer",
          },
          "Join",
        )
      : h("span", { className: "ofm-meta" }, "No Meet link on this event");

    return h(
      "div",
      { className: "ofm-page" },
      h("div", { className: "ofm-card ofm-card-next" }, [
        h("p", { className: "ofm-kicker", key: "k" }, `Next · ${relative(next.start.getTime(), now)}`),
        h("h2", { className: "ofm-title", key: "t" }, next.summary || "Untitled event"),
        h("p", { className: "ofm-meta", key: "w" }, when(next, now)),
        next.location ? h("p", { className: "ofm-meta", key: "l" }, next.location) : null,
        h("div", { className: "ofm-actions", key: "a" }, join),
      ]),
      rest.length
        ? h(
            "ul",
            { className: "ofm-list" },
            rest.slice(0, 6).map((slot, index) =>
              h(
                "li",
                { className: "ofm-row", key: `${slot.uid || index}-${slot.start.getTime()}` },
                h("span", { className: "ofm-row-time" }, when(slot, now)),
                h("span", { className: "ofm-row-title" }, slot.summary || "Untitled event"),
                slot.meetUrl
                  ? h(
                      "a",
                      {
                        className: "ofm-row-join",
                        href: slot.meetUrl,
                        target: "_blank",
                        rel: "noopener noreferrer",
                      },
                      "Join",
                    )
                  : null,
              ),
            ),
          )
        : null,
    );
  };
}

function createSettingsCard({ React, credentials, host }) {
  const { useState, useEffect } = React;
  const h = React.createElement;

  return function MeetSettings() {
    const [address, setAddress] = useState("");
    const [saved, setSaved] = useState(credentials.has());
    const [place, setPlace] = useState(credentials.place());
    const [message, setMessage] = useState(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
      void credentials.ready.then(() => {
        setSaved(credentials.has());
        setPlace(credentials.place());
      });
      return credentials.subscribe(() => {
        setSaved(credentials.has());
        setPlace(credentials.place());
      });
    }, []);

    const storeName = STORE_LABEL[credentials.store()] ?? null;
    const publishedFeed = isPublicFeed(address) || (saved && isPublicFeed(credentials.read()));

    const save = async () => {
      const value = address.trim();
      if (!isCalendarAddress(value)) {
        setMessage({
          kind: "error",
          text: "That is not a Google Calendar iCal address. It looks like https://calendar.google.com/calendar/ical/…/basic.ics",
        });
        return;
      }
      setBusy(true);
      setMessage(null);
      try {
        await fetchCalendar(host, value);
      } catch (error) {
        setBusy(false);
        setMessage({
          kind: "error",
          text:
            error.message === "gone" || error.message === "denied"
              ? "Google refused that address. Copy it again from Calendar settings."
              : "Could not reach that calendar to check it. It was not saved.",
        });
        return;
      }
      const result = await credentials.save(value);
      setBusy(false);
      if (!result.kept) {
        setMessage({ kind: "error", text: "Your system store did not keep the address. Nothing was changed." });
        return;
      }
      setAddress("");
      setMessage({
        kind: "ok",
        text: result.degraded
          ? "Saved, and it works. The system store would not take it, so it is kept in this profile in plain text."
          : "Saved, and it works. Nothing else in Buzz can read it.",
      });
    };

    const clear = async () => {
      setBusy(true);
      await credentials.clear();
      setBusy(false);
      setMessage({ kind: "ok", text: "Removed." });
    };

    return h(
      "div",
      null,
      h("p", { className: "ofm-label" }, "Calendar address"),
      h("input", {
        className: "ofm-field",
        type: "text",
        spellCheck: false,
        autoComplete: "off",
        placeholder: saved ? "A calendar address is saved" : "https://calendar.google.com/calendar/ical/…/basic.ics",
        value: address,
        onChange: (event) => setAddress(event.target.value),
      }),
      h(
        "p",
        { className: "ofm-hint" },
        "Google Calendar → Settings and sharing → Integrate calendar → Secret address in iCal format. ",
        "This is a private read-only link to one calendar. Anyone holding it can read that calendar, " +
          "so treat it like a password. It is sent only to calendar.google.com.",
      ),
      h(
        "div",
        { className: "ofm-actions" },
        h(
          "button",
          { className: "ofm-button", type: "button", disabled: busy || !address.trim(), onClick: () => void save() },
          busy ? "Checking…" : saved ? "Replace" : "Save",
        ),
        saved
          ? h("button", { className: "ofm-button", type: "button", disabled: busy, onClick: () => void clear() }, "Remove")
          : null,
      ),
      publishedFeed
        ? h(
            "p",
            { className: "ofm-error" },
            "That is the public address. Google hides event details from it: every event arrives as “Busy”, with no summary and no Meet link. " +
              "Use the secret address instead — Google Calendar → Settings and sharing → Integrate calendar → Secret address in iCal format.",
          )
        : null,
      message
        ? h("p", { className: message.kind === "error" ? "ofm-error" : "ofm-status" }, message.text)
        : null,
      h(
        "p",
        { className: "ofm-status" },
        saved
          ? `Saved in ${place === "profile" ? "this Buzz profile, in plain text" : storeName ?? "the system store"}.`
          : storeName
            ? `Nothing saved yet. Your address will go to ${storeName}.`
            : "Nothing saved yet. This system has no credential store the plugin can reach, so the address will be kept in this Buzz profile in plain text.",
      ),
    );
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function apply(ctx) {
  const React = ctx.react;

  const credentials = createCredentials({
    storage: window.localStorage,
    store: detectStore(navigator.platform, navigator.userAgent),
    run: (id, input) => ctx.host.runCommand(id, input),
  });

  ctx.effect(() => {
    // [DOM] API v1 has no CSS file and the host has no style service, so the
    // page's rules are one <style> element, removed with this scope.
    const style = document.createElement("style");
    style.dataset.officefictionMeet = "";
    style.textContent = CSS;
    document.head.append(style);
    return () => style.remove();
  });

  const openSettings = () => {
    void ctx.navigation
      .open({ version: 1, kind: "settings", section: SETTINGS_SECTION })
      .catch(() => {});
  };

  ctx.pages.register({
    id: "meet",
    title: "Meet",
    primary: true,
    layout: "workspace",
    placement: "sidebar",
    component: createMeetPage({ React, credentials, host: ctx.host, openSettings }),
  });

  ctx.settingsCards.register({
    id: "settings",
    title: "Meet",
    group: "Plugins",
    component: createSettingsCard({ React, credentials, host: ctx.host }),
  });
}
