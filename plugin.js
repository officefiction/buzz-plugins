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
// Google OAuth (Calendar API + Meet API)
//
// An installed-app flow with PKCE, as Google documents it for desktop clients
// (developers.google.com/identity/protocols/oauth2/native-app). The browser is
// the system browser — Google refuses OAuth inside an embedded webview — and
// nothing listens on the loopback port, so the browser lands on an error page
// whose address bar carries the code. The user pastes that address back here.
//
// The client ID and secret belong to the user's own Google Cloud project.
// ---------------------------------------------------------------------------

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/meetings.space.created",
];

export const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const LOOPBACK_REDIRECT = "http://127.0.0.1:8765";

const UNRESERVED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/** A PKCE code verifier: 64 characters from the unreserved set, per RFC 7636. */
export function makeVerifier(randomBytes) {
  const bytes = randomBytes ?? crypto.getRandomValues(new Uint8Array(64));
  let out = "";
  for (let i = 0; i < 64; i += 1) out += UNRESERVED[bytes[i] % UNRESERVED.length];
  return out;
}

export function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** S256: the base64url of the SHA-256 of the verifier. */
export async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function buildAuthUrl({ clientId, challenge, redirectUri = LOOPBACK_REDIRECT, scopes = GOOGLE_SCOPES }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline", // asks for a refresh token
    prompt: "consent", // forces a refresh token even on a repeat authorisation
  });
  return AUTH_ENDPOINT + "?" + params.toString();
}

/** Reads the code, or the reason there is none, out of whatever the browser showed. */
export function parseRedirect(pasted) {
  const text = String(pasted ?? "").trim();
  if (!text) return { ok: false, reason: "empty" };
  let query;
  try {
    query = new URL(text).searchParams;
  } catch {
    // A browser shows a full address, but a bare query string is just as valid.
    const mark = text.indexOf("?");
    query = new URLSearchParams(mark < 0 ? text : text.slice(mark + 1));
  }
  const error = query.get("error");
  if (error) return { ok: false, reason: error };
  const code = query.get("code");
  if (!code) return { ok: false, reason: "no code in that address" };
  return { ok: true, code };
}

export function exchangeBody({ code, verifier, clientId, clientSecret, redirectUri = LOOPBACK_REDIRECT }) {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  }).toString();
}

export function refreshBody({ refreshToken, clientId, clientSecret }) {
  return new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  }).toString();
}

/**
 * Maps a Calendar API events.list response into the same shape the iCal reader
 * produces, so upcoming() needs no change. singleEvents=true means Google has
 * already expanded recurrences, so no rrule is carried.
 */
export function eventsFromApi(json) {
  const out = [];
  for (const item of json?.items ?? []) {
    if (item.status === "cancelled") continue;
    const allDay = Boolean(item.start?.date);
    const startText = item.start?.dateTime ?? item.start?.date;
    const endText = item.end?.dateTime ?? item.end?.date;
    if (!startText) continue;
    const startMs = Date.parse(startText);
    if (Number.isNaN(startMs)) continue;
    const endMs = endText ? Date.parse(endText) : startMs + 30 * 60_000;
    const meetUrl =
      item.hangoutLink ||
      (item.conferenceData?.entryPoints ?? []).find((entry) => entry.entryPointType === "video")?.uri ||
      MEET_LINK.exec(item.location ?? "")?.[0] ||
      MEET_LINK.exec(item.description ?? "")?.[0] ||
      undefined;
    out.push({
      startCivil: startMs,
      endCivil: Number.isNaN(endMs) ? startMs + 30 * 60_000 : endMs,
      timeZone: undefined, // the API sends offsets, so the instant is exact
      start: new Date(startMs),
      summary: item.summary || "Busy",
      location: item.location,
      meetUrl,
      uid: item.iCalUID || item.id,
      allDay,
      exdates: [],
    });
  }
  return out;
}



// ---------------------------------------------------------------------------
// The vault: one JSON document in whichever credential store the system has
// ---------------------------------------------------------------------------

export function createVault(store) {
  const read = () => {
    try {
      const raw = store.read();
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      // Arrays and nulls are objects to typeof, and spreading one would poison
      // every later write with numeric keys.
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };
  return {
    get ready() {
      return store.ready;
    },
    read,
    place: () => store.place(),
    store: () => store.store(),
    subscribe: (fn) => store.subscribe(fn),
    async write(patch) {
      const next = { ...read(), ...patch };
      for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
      return store.save(JSON.stringify(next));
    },
    async clear() {
      return store.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Google client: refresh, list events, create a space, exchange a code
// ---------------------------------------------------------------------------

function createGoogle({ host, vault }) {
  let cached = null;

  async function accessToken() {
    if (cached && Date.now() < cached.expiresAt - 60_000) return cached.access;
    const config = vault.read();
    if (!config.refreshToken || !config.clientId || !config.clientSecret) throw new Error("not-connected");
    const response = await host.request({
      url: TOKEN_ENDPOINT,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: refreshBody({
        refreshToken: config.refreshToken,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      }),
    });
    const json = JSON.parse(response.body || "{}");
    if (response.status !== 200 || !json.access_token) {
      // invalid_grant: revoked by the user, or expired. Only a reconnect fixes it.
      throw new Error(json.error === "invalid_grant" ? "reauthorise" : "token");
    }
    cached = { access: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 };
    return cached.access;
  }

  async function listEvents(now) {
    const token = await accessToken();
    const query = new URLSearchParams({
      timeMin: new Date(now - 3600_000).toISOString(),
      timeMax: new Date(now + LOOKAHEAD_DAYS * DAY_MS).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "100",
    });
    const response = await host.request({
      url: "https://www.googleapis.com/calendar/v3/calendars/primary/events?" + query.toString(),
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    });
    if (response.status === 401 || response.status === 403) throw new Error("reauthorise");
    if (response.status !== 200) throw new Error("calendar");
    return eventsFromApi(JSON.parse(response.body));
  }

  async function createSpace() {
    const token = await accessToken();
    const response = await host.request({
      url: "https://meet.googleapis.com/v2/spaces",
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: "{}",
    });
    if (response.status !== 200 && response.status !== 201) throw new Error("meet");
    const json = JSON.parse(response.body || "{}");
    if (!json.meetingUri) throw new Error("meet");
    return json.meetingUri;
  }

  async function exchange({ code, verifier }) {
    const config = vault.read();
    const response = await host.request({
      url: TOKEN_ENDPOINT,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: exchangeBody({
        code,
        verifier,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      }),
    });
    const json = JSON.parse(response.body || "{}");
    if (response.status !== 200 || !json.access_token) {
      throw new Error(json.error === "invalid_grant" ? "expired-code" : "exchange");
    }
    if (!json.refresh_token) throw new Error("no-refresh");
    await vault.write({ refreshToken: json.refresh_token, verifier: undefined });
    cached = { access: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 };
    return true;
  }

  return {
    accessToken,
    listEvents,
    createSpace,
    exchange,
    connected: () => Boolean(vault.read().refreshToken),
    forget() {
      cached = null;
    },
  };
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
.ofm-divider { border: 0; border-top: 1px solid var(--border-subtle, rgba(128,128,128,0.24)); margin: 20px 0; }
.ofm-button-primary { background: var(--accent-9, #ff8b1a); color: var(--accent-contrast, #fff); border-color: transparent; font-weight: 600; text-decoration: none; }
.ofm-button-primary:hover { background: var(--affordance-backdrop-pressed, var(--accent-9, #ff8b1a)); }
.ofm-button[disabled] { opacity: 0.5; cursor: default; }
.ofm-footer { display: flex; gap: 14px; align-items: center; margin-top: 22px; flex-wrap: wrap; }
.ofm-source { font-size: 11px; opacity: 0.55; margin-left: auto; }
.ofm-field + .ofm-field { margin-top: 8px; }
`;

// ---------------------------------------------------------------------------
// Pages and cards
// ---------------------------------------------------------------------------

function createMeetPage({ React, vault, google, host, openSettings }) {
  const { useState, useEffect, useCallback } = React;
  const h = React.createElement;

  return function MeetPage() {
    const [state, setState] = useState({ status: "loading" });
    const [tick, setTick] = useState(0);
    const [instant, setInstant] = useState({ status: "idle" });

    const load = useCallback(async () => {
      await vault.ready;
      const config = vault.read();

      // OAuth first: no feed, so no cache, no redaction and a real Meet link.
      if (config.refreshToken) {
        try {
          const events = await google.listEvents(Date.now());
          setState({
            status: "ready",
            source: "google",
            slots: upcoming(events, Date.now()),
            read: events.length,
            redacted: false,
            lastStart: events.length
              ? new Date(Math.max(...events.map((event) => event.start.getTime())))
              : null,
            publicFeed: false,
          });
        } catch (error) {
          setState({ status: "error", reason: error.message, source: "google" });
        }
        return;
      }

      if (!config.ical) {
        setState({ status: "unconfigured" });
        return;
      }
      try {
        const events = await fetchCalendar(host, config.ical);
        setState({
          status: "ready",
          source: "ical",
          slots: upcoming(events, Date.now()),
          read: events.length,
          redacted: events.length > 0 && events.every((event) => event.summary === "Busy"),
          lastStart: events.length
            ? new Date(Math.max(...events.map((event) => event.start.getTime())))
            : null,
          publicFeed: isPublicFeed(config.ical),
        });
      } catch (error) {
        setState({ status: "error", reason: error.message, source: "ical" });
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

    const startInstant = async () => {
      setInstant({ status: "working" });
      try {
        setInstant({ status: "ready", uri: await google.createSpace() });
      } catch {
        setInstant({ status: "error" });
      }
    };

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
          "Connect Google in Settings to read your calendar and start meetings. Or paste a calendar's secret iCal address there instead.",
        ),
        h("button", { className: "ofm-button", onClick: openSettings, type: "button" }, "Open Meet settings"),
      );
    }

    if (state.status === "error") {
      let message;
      if (state.reason === "reauthorise") {
        message = "Google access expired or was revoked. Reconnect in Settings → Plugins → Meet.";
      } else if (state.reason === "no-refresh") {
        message = "Google did not send a refresh token. Remove this website's access at myaccount.google.com/permissions, then connect again.";
      } else if (state.reason === "gone" || state.reason === "denied") {
        message = "Google refused that calendar address. Check it in Settings — a reset calendar has a new address.";
      } else if (state.source === "google") {
        message = "Could not read your calendar from Google just now. It will try again in a minute.";
      } else {
        message = "Could not read the calendar just now. It will try again in a minute.";
      }
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
      h(
        "div",
        { className: "ofm-footer" },
        state.source === "google"
          ? instant.status === "ready"
            ? h(
                "a",
                {
                  className: "ofm-button ofm-button-primary",
                  href: instant.uri,
                  target: "_blank",
                  rel: "noopener noreferrer",
                },
                "Join your new meeting",
              )
            : h(
                "button",
                {
                  className: "ofm-button",
                  type: "button",
                  disabled: instant.status === "working",
                  onClick: () => void startInstant(),
                },
                instant.status === "working" ? "Starting…" : "Start a meeting now",
              )
          : null,
        instant.status === "error"
          ? h("span", { className: "ofm-error" }, "Google could not create the meeting.")
          : null,
        h("span", { className: "ofm-source" }, state.source === "google" ? "Google Calendar" : "iCal feed"),
      ),
    );
  };
}

function createSettingsCard({ React, vault, google, host }) {
  const { useState, useEffect } = React;
  const h = React.createElement;

  return function MeetSettings() {
    const [config, setConfig] = useState({});
    const [place, setPlace] = useState(vault.place());
    const [clientId, setClientId] = useState("");
    const [clientSecret, setClientSecret] = useState("");
    const [phase, setPhase] = useState("idle"); // idle | authorize
    const [authUrl, setAuthUrl] = useState("");
    const [pasted, setPasted] = useState("");
    const [address, setAddress] = useState("");
    const [message, setMessage] = useState(null);
    const [busy, setBusy] = useState(false);

    const sync = () => {
      setConfig(vault.read());
      setPlace(vault.place());
    };

    useEffect(() => {
      void vault.ready.then(sync);
      return vault.subscribe(sync);
    }, []);

    const storeName = STORE_LABEL[vault.store()] ?? null;
    const connected = Boolean(config.refreshToken);
    const publishedFeed = isPublicFeed(address) || isPublicFeed(config.ical ?? "");
    const whereKept = place === "profile" ? "this Buzz profile, in plain text" : storeName ?? "the system store";

    // --- Google: start the sign-in -----------------------------------------
    const beginConnect = async () => {
      const id = clientId.trim();
      const secret = clientSecret.trim();
      if (!/^[0-9A-Za-z_-]+\.apps\.googleusercontent\.com$/.test(id)) {
        setMessage({ kind: "error", text: "That is not a Google client ID — it ends in .apps.googleusercontent.com." });
        return;
      }
      if (!secret) {
        setMessage({ kind: "error", text: "Paste the client secret as well." });
        return;
      }
      setBusy(true);
      setMessage(null);
      try {
        const verifier = makeVerifier();
        const challenge = await challengeFor(verifier);
        const saved = await vault.write({ clientId: id, clientSecret: secret, verifier });
        if (!saved.kept) {
          setMessage({ kind: "error", text: "The system store did not keep the client details. Nothing was changed." });
        } else {
          setAuthUrl(buildAuthUrl({ clientId: id, challenge }));
          setPhase("authorize");
        }
      } catch {
        setMessage({ kind: "error", text: "Could not prepare the sign-in. Try again." });
      }
      setBusy(false);
    };

    // --- Google: finish the sign-in with the pasted address ----------------
    const finishConnect = async () => {
      const parsed = parseRedirect(pasted);
      if (!parsed.ok) {
        setMessage({
          kind: "error",
          text:
            parsed.reason === "access_denied"
              ? "You cancelled the Google consent, or the app is not approved."
              : "That address has no code in it. Copy the whole address the browser landed on.",
        });
        return;
      }
      const verifier = vault.read().verifier;
      if (!verifier) {
        setPhase("idle");
        setMessage({ kind: "error", text: "The sign-in request expired. Start again." });
        return;
      }
      setBusy(true);
      setMessage(null);
      try {
        await google.exchange({ code: parsed.code, verifier });
        sync();
        setPhase("idle");
        setClientId("");
        setClientSecret("");
        setPasted("");
        setAuthUrl("");
        setMessage({ kind: "ok", text: "Connected to Google Calendar and Meet." });
      } catch (error) {
        const text = {
          "expired-code": "That code has expired or was already used. Start the sign-in again.",
          "no-refresh":
            "Google did not send a refresh token. Remove this app at myaccount.google.com/permissions, then connect again.",
          exchange: "Google refused the exchange. Check the client ID and secret.",
        }[error.message];
        setMessage({ kind: "error", text: text ?? "The exchange failed. Try again." });
      }
      setBusy(false);
    };

    const disconnect = async () => {
      setBusy(true);
      google.forget();
      await vault.write({ refreshToken: undefined, verifier: undefined });
      sync();
      setBusy(false);
      setMessage({
        kind: "ok",
        text: "Disconnected here. Revoke the app at myaccount.google.com/permissions to remove it from your Google account too.",
      });
    };

    // --- iCal fallback -----------------------------------------------------
    const saveAddress = async () => {
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
      const result = await vault.write({ ical: value });
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
          : "Saved, and it works.",
      });
    };

    const clearAddress = async () => {
      setBusy(true);
      await vault.write({ ical: undefined });
      setBusy(false);
      setMessage({ kind: "ok", text: "Calendar address removed." });
    };

    const googleSection = connected
      ? h(
          "div",
          null,
          h("p", { className: "ofm-status" }, "Connected to Google Calendar and Meet."),
          h(
            "div",
            { className: "ofm-actions" },
            h(
              "button",
              { className: "ofm-button", type: "button", disabled: busy, onClick: () => void disconnect() },
              "Disconnect",
            ),
          ),
        )
      : phase === "authorize"
        ? h(
            "div",
            null,
            h(
              "p",
              { className: "ofm-hint" },
              "Open the link and approve access. The browser then lands on a page that says the site cannot be reached — " +
                "that is expected, because nothing listens on 127.0.0.1. Copy that whole address and paste it below.",
            ),
            h(
              "a",
              { className: "ofm-button ofm-button-primary", href: authUrl, target: "_blank", rel: "noopener noreferrer" },
              "Open Google sign-in",
            ),
            h(
              "div",
              { className: "ofm-actions" },
              h("input", {
                className: "ofm-field",
                type: "text",
                spellCheck: false,
                autoComplete: "off",
                placeholder: "http://127.0.0.1:8765/?code=…",
                value: pasted,
                onChange: (event) => setPasted(event.target.value),
              }),
              h(
                "button",
                { className: "ofm-button", type: "button", disabled: busy || !pasted.trim(), onClick: () => void finishConnect() },
                busy ? "Finishing…" : "Finish",
              ),
            ),
          )
        : h(
            "div",
            null,
            h(
              "p",
              { className: "ofm-hint" },
              "Paste the client ID and secret from your Google Cloud project's OAuth client (type Desktop app). " +
                "They are kept in the system credential store, never shown again, and never sent anywhere except Google's token endpoint.",
            ),
            h("input", {
              className: "ofm-field",
              type: "text",
              spellCheck: false,
              autoComplete: "off",
              placeholder: "Client ID (…apps.googleusercontent.com)",
              value: clientId,
              onChange: (event) => setClientId(event.target.value),
            }),
            h("input", {
              className: "ofm-field",
              type: "password",
              autoComplete: "off",
              placeholder: "Client secret",
              value: clientSecret,
              onChange: (event) => setClientSecret(event.target.value),
            }),
            h(
              "div",
              { className: "ofm-actions" },
              h(
                "button",
                { className: "ofm-button ofm-button-primary", type: "button", disabled: busy, onClick: () => void beginConnect() },
                busy ? "Preparing…" : "Connect Google",
              ),
            ),
          );

    return h(
      "div",
      null,
      h("p", { className: "ofm-label" }, "Google Calendar and Meet"),
      googleSection,
      message ? h("p", { className: message.kind === "error" ? "ofm-error" : "ofm-status" }, message.text) : null,

      h("hr", { className: "ofm-divider" }),

      h("p", { className: "ofm-label" }, "Or a calendar iCal address"),
      h("input", {
        className: "ofm-field",
        type: "text",
        spellCheck: false,
        autoComplete: "off",
        placeholder: config.ical ? "A calendar address is saved" : "https://calendar.google.com/calendar/ical/…/basic.ics",
        value: address,
        onChange: (event) => setAddress(event.target.value),
      }),
      h(
        "p",
        { className: "ofm-hint" },
        "Google Calendar → Settings and sharing → Integrate calendar → Secret address in iCal format. ",
        "Use this when Google sign-in is not available for the account. It is a private read-only link to one calendar. ",
        "Anyone holding it can read that calendar, so treat it like a password.",
      ),
      h(
        "div",
        { className: "ofm-actions" },
        h(
          "button",
          { className: "ofm-button", type: "button", disabled: busy || !address.trim(), onClick: () => void saveAddress() },
          busy ? "Checking…" : config.ical ? "Replace" : "Save",
        ),
        config.ical
          ? h(
              "button",
              { className: "ofm-button", type: "button", disabled: busy, onClick: () => void clearAddress() },
              "Remove",
            )
          : null,
      ),
      publishedFeed
        ? h(
            "p",
            { className: "ofm-error" },
            "That is the public address. Google hides event details from it: every event arrives as “Busy”, with no summary and no Meet link. " +
              "Use the secret address, or connect Google above.",
          )
        : null,
      h(
        "p",
        { className: "ofm-status" },
        connected || config.ical
          ? `Saved in ${whereKept}.`
          : storeName
            ? `Nothing saved yet. Your details will go to ${storeName}.`
            : "Nothing saved yet. This system has no credential store the plugin can reach, so details will be kept in this Buzz profile in plain text.",
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
  const vault = createVault(credentials);
  const google = createGoogle({ host: ctx.host, vault });

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
    component: createMeetPage({ React, vault, google, host: ctx.host, openSettings }),
  });

  ctx.settingsCards.register({
    id: "settings",
    title: "Meet",
    group: "Plugins",
    component: createSettingsCard({ React, vault, google, host: ctx.host }),
  });
}
