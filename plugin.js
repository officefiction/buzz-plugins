/**
 * Meet — a Buzz plugin.
 *
 * Shows the next Google Meet calls from a Google Calendar and hands the Join
 * button to the browser. Meet cannot be embedded: meet.google.com answers
 * X-Frame-Options: DENY, so the frame would never paint. A link is the honest
 * shape, and the host already opens external links in the user's browser.
 *
 * Google is reached with an installed-app OAuth flow — PKCE, the loopback
 * address pasted back by the user — over three declared origins. The client ID
 * and secret belong to the user's own Google Cloud project; ctx.host.request
 * refuses every origin the manifest does not name.
 *
 * API v1, written against block/buzz-app (docs/plugin-architecture.md).
 * Plain ES module: Buzz never runs a build.
 */

export const inject = ["react", "pages", "panels", "settingsCards", "conversation", "navigation", "host"];

const PLUGIN_ID = "com.buzzplugins.meet";
const SETTINGS_SECTION = PLUGIN_ID + "/settings";
const CALENDAR_ORIGIN = "https://calendar.google.com";
const STORAGE_KEY = PLUGIN_ID + ".vault.v1";
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
// Time
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/**
 * The slots that start between an hour ago and the lookahead, soonest first.
 * The Calendar API returns an already-expanded series, so this is a filter.
 */
export function upcoming(events, now, days = LOOKAHEAD_DAYS) {
  const from = now - 60 * 60 * 1000;
  const to = now + days * DAY_MS;
  const seen = new Set();
  const list = [];
  for (const event of events) {
    const startMs = event.start.getTime();
    if (startMs < from || startMs > to) continue;
    const key = `${event.uid || ""}|${startMs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(event);
  }
  return list.sort((a, b) => a.start - b.start);
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
 * Maps a Calendar API events.list response into the slot shape the page uses.
 * singleEvents=true means Google has already expanded recurrences and resolved
 * the offsets, so every time here is an exact instant.
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
    const parsedEnd = endText ? Date.parse(endText) : NaN;
    const meetUrl =
      item.hangoutLink ||
      (item.conferenceData?.entryPoints ?? []).find((entry) => entry.entryPointType === "video")?.uri ||
      MEET_LINK.exec(item.location ?? "")?.[0] ||
      MEET_LINK.exec(item.description ?? "")?.[0] ||
      undefined;
    out.push({
      start: new Date(startMs),
      end: new Date(Number.isNaN(parsedEnd) ? startMs + 30 * 60_000 : parsedEnd),
      summary: item.summary || "Busy",
      location: item.location,
      meetUrl,
      uid: item.iCalUID || item.id,
      allDay,
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
    if (!json.meetingUri || !json.meetingCode) throw new Error("meet");
    return { uri: json.meetingUri, code: json.meetingCode };
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
// The room registry
//
// The plugin API has no write path into Buzz — the conversation service sends
// nothing and artifact storage is read-only — so a channel's meeting cannot be
// published to the relay. A small service holds the mapping instead, keyed by
// channel id, and every client reads the same room from it.
// ---------------------------------------------------------------------------

export const REGISTRY_ORIGIN = "https://meet-rooms.fiction.services";

export function createRegistry({ host, vault }) {
  const base = REGISTRY_ORIGIN;

  const token = () => vault.read().registryToken;

  function headers(extra) {
    const value = token();
    if (!value) throw new Error("no-registry-token");
    return { Authorization: "Bearer " + value, ...extra };
  }

  const roomUrl = (channelId) => `${base}/rooms/${encodeURIComponent(channelId)}`;

  async function getRoom(channelId) {
    const response = await host.request({
      url: roomUrl(channelId),
      headers: headers({ Accept: "application/json" }),
    });
    if (response.status === 404) return null;
    if (response.status === 401 || response.status === 403) throw new Error("registry-token");
    if (response.status !== 200) throw new Error("registry");
    return JSON.parse(response.body);
  }

  async function putRoom(channelId, { uri, code }) {
    const response = await host.request({
      url: roomUrl(channelId),
      method: "PUT",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ uri, code }),
    });
    if (response.status === 401 || response.status === 403) throw new Error("registry-token");
    if (response.status !== 200 && response.status !== 201) throw new Error("registry");
    return JSON.parse(response.body);
  }

  async function forgetRoom(channelId) {
    const response = await host.request({
      url: roomUrl(channelId),
      method: "DELETE",
      headers: headers(),
    });
    if (response.status === 401 || response.status === 403) throw new Error("registry-token");
    return response.status === 200;
  }

  return { getRoom, putRoom, forgetRoom, configured: () => Boolean(token()) };
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
.bp-meet-page { padding: 24px; max-width: 720px; color: var(--text-standard, inherit); }
.bp-meet-lead { font-size: 13px; opacity: 0.72; margin: 0 0 20px; }
.bp-meet-card { border: 1px solid var(--border-subtle, rgba(128,128,128,0.24)); border-radius: 12px; padding: 18px; background: var(--surface-popover, transparent); }
.bp-meet-card-next { border-color: var(--accent-9, currentColor); }
.bp-meet-kicker { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.7; margin: 0 0 6px; }
.bp-meet-title { font-size: 17px; font-weight: 600; margin: 0 0 6px; }
.bp-meet-meta { font-size: 13px; opacity: 0.8; margin: 0 0 2px; }
.bp-meet-actions { display: flex; gap: 10px; align-items: center; margin-top: 16px; flex-wrap: wrap; }
.bp-meet-join { display: inline-block; padding: 8px 16px; border-radius: 8px; background: var(--accent-9, #ff8b1a); color: var(--accent-contrast, #fff); font-weight: 600; font-size: 13px; text-decoration: none; }
.bp-meet-join:hover { background: var(--affordance-backdrop-pressed, var(--accent-9, #ff8b1a)); }
.bp-meet-button { padding: 7px 14px; border-radius: 8px; border: 1px solid var(--border-subtle, rgba(128,128,128,0.32)); background: transparent; color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
.bp-meet-button:hover { background: var(--affordance-backdrop-pressed, rgba(128,128,128,0.12)); }
.bp-meet-button:focus-visible { outline: 2px solid var(--border-focus, currentColor); outline-offset: 2px; }
.bp-meet-list { list-style: none; padding: 0; margin: 16px 0 0; display: flex; flex-direction: column; gap: 8px; }
.bp-meet-row { display: flex; gap: 14px; align-items: baseline; padding: 10px 12px; border-radius: 8px; }
.bp-meet-row:hover { background: var(--affordance-backdrop-pressed, rgba(128,128,128,0.08)); }
.bp-meet-row-time { font-variant-numeric: tabular-nums; font-size: 12px; opacity: 0.75; min-width: 116px; }
.bp-meet-row-title { font-size: 13px; flex: 1; }
.bp-meet-row-join { font-size: 12px; color: var(--accent-9, inherit); text-decoration: none; }
.bp-meet-error { color: var(--text-standard, inherit); opacity: 0.85; font-size: 13px; }
.bp-meet-field { display: block; width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border-subtle, rgba(128,128,128,0.32)); background: transparent; color: inherit; font: inherit; font-size: 13px; }
.bp-meet-field:focus-visible { outline: 2px solid var(--border-focus, currentColor); outline-offset: 1px; }
.bp-meet-label { display: block; font-size: 13px; font-weight: 600; margin: 0 0 6px; }
.bp-meet-hint { font-size: 12px; opacity: 0.72; margin: 8px 0 0; line-height: 1.5; }
.bp-meet-status { font-size: 12px; margin: 12px 0 0; opacity: 0.8; }
.bp-meet-divider { border: 0; border-top: 1px solid var(--border-subtle, rgba(128,128,128,0.24)); margin: 20px 0; }
.bp-meet-button-primary { background: var(--accent-9, #ff8b1a); color: var(--accent-contrast, #fff); border-color: transparent; font-weight: 600; text-decoration: none; }
.bp-meet-button-primary:hover { background: var(--affordance-backdrop-pressed, var(--accent-9, #ff8b1a)); }
.bp-meet-button[disabled] { opacity: 0.5; cursor: default; }
.bp-meet-footer { display: flex; gap: 14px; align-items: center; margin-top: 22px; flex-wrap: wrap; }
.bp-meet-source { font-size: 11px; opacity: 0.55; margin-left: auto; }
.bp-meet-field + .bp-meet-field { margin-top: 8px; }
.bp-meet-launcher { font: inherit; padding: 4px 6px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: inherit; text-decoration: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; line-height: 0; }
.bp-meet-launcher:hover { background: var(--affordance-backdrop-hover, rgba(128,128,128,0.14)); }
.bp-meet-launcher[disabled] { opacity: 0.45; cursor: default; }
.bp-meet-mark { width: 18px; height: 14px; display: block; }
`;

// ---------------------------------------------------------------------------
// Pages and cards
// ---------------------------------------------------------------------------

function createMeetPage({ React, vault, google, openSettings }) {
  const { useState, useEffect, useCallback } = React;
  const h = React.createElement;

  return function MeetPage() {
    const [state, setState] = useState({ status: "loading" });
    const [tick, setTick] = useState(0);
    const [instant, setInstant] = useState({ status: "idle" });

    const load = useCallback(async () => {
      await vault.ready;
      if (!google.connected()) {
        setState({ status: "unconfigured" });
        return;
      }
      try {
        const events = await google.listEvents(Date.now());
        setState({
          status: "ready",
          slots: upcoming(events, Date.now()),
          read: events.length,
          lastStart: events.length
            ? new Date(Math.max(...events.map((event) => event.start.getTime())))
            : null,
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

    const startInstant = async () => {
      setInstant({ status: "working" });
      try {
        const space = await google.createSpace();
        setInstant({ status: "ready", uri: space.uri });
      } catch {
        setInstant({ status: "error" });
      }
    };

    if (state.status === "loading") {
      return h("div", { className: "bp-meet-page" }, h("p", { className: "bp-meet-lead" }, "Reading your calendar…"));
    }

    if (state.status === "unconfigured") {
      return h(
        "div",
        { className: "bp-meet-page" },
        h("h2", { className: "bp-meet-title" }, "Your calendar is not connected"),
        h(
          "p",
          { className: "bp-meet-lead" },
          "Connect Google in Settings to read your calendar and start meetings.",
        ),
        h("button", { className: "bp-meet-button", onClick: openSettings, type: "button" }, "Open Meet settings"),
      );
    }

    if (state.status === "error") {
      let message;
      if (state.reason === "reauthorise") {
        message = "Google access expired or was revoked. Reconnect in Settings → Plugins → Meet.";
      } else if (state.reason === "not-connected") {
        message = "Google is not connected. Open Settings to connect it.";
      } else {
        message = "Could not read your calendar just now. It will try again in a minute.";
      }
      return h(
        "div",
        { className: "bp-meet-page" },
        h("p", { className: "bp-meet-error" }, message),
        h(
          "div",
          { className: "bp-meet-actions" },
          h("button", { className: "bp-meet-button", onClick: () => void load(), type: "button" }, "Try now"),
          h("button", { className: "bp-meet-button", onClick: openSettings, type: "button" }, "Open settings"),
        ),
      );
    }

    const now = Date.now();
    const [next, ...rest] = state.slots ?? [];

    if (!next) {
      // Say what was actually read. "Nothing here" and "nothing readable here"
      // look identical otherwise, and the second one is a setup fault.
      const notes = [];
      if (!state.read) {
        notes.push("Your calendar came back with no events at all.");
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
        { className: "bp-meet-page" },
        h("h2", { className: "bp-meet-title" }, "Nothing coming up"),
        notes.map((text, index) => h("p", { className: "bp-meet-lead", key: index }, text)),
        h(
          "div",
          { className: "bp-meet-actions" },
          h("button", { className: "bp-meet-button", onClick: openSettings, type: "button" }, "Open settings"),
        ),
      );
    }

    const join = next.meetUrl
      ? h(
          "a",
          {
            className: "bp-meet-join",
            href: next.meetUrl,
            target: "_blank",
            rel: "noopener noreferrer",
          },
          "Join",
        )
      : h("span", { className: "bp-meet-meta" }, "No Meet link on this event");

    return h(
      "div",
      { className: "bp-meet-page" },
      h("div", { className: "bp-meet-card bp-meet-card-next" }, [
        h("p", { className: "bp-meet-kicker", key: "k" }, `Next · ${relative(next.start.getTime(), now)}`),
        h("h2", { className: "bp-meet-title", key: "t" }, next.summary || "Untitled event"),
        h("p", { className: "bp-meet-meta", key: "w" }, when(next, now)),
        next.location ? h("p", { className: "bp-meet-meta", key: "l" }, next.location) : null,
        h("div", { className: "bp-meet-actions", key: "a" }, join),
      ]),
      rest.length
        ? h(
            "ul",
            { className: "bp-meet-list" },
            rest.slice(0, 6).map((slot, index) =>
              h(
                "li",
                { className: "bp-meet-row", key: `${slot.uid || index}-${slot.start.getTime()}` },
                h("span", { className: "bp-meet-row-time" }, when(slot, now)),
                h("span", { className: "bp-meet-row-title" }, slot.summary || "Untitled event"),
                slot.meetUrl
                  ? h(
                      "a",
                      {
                        className: "bp-meet-row-join",
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
        { className: "bp-meet-footer" },
        instant.status === "ready"
          ? h(
              "a",
              {
                className: "bp-meet-button bp-meet-button-primary",
                href: instant.uri,
                target: "_blank",
                rel: "noopener noreferrer",
              },
              "Join your new meeting",
            )
          : h(
              "button",
              {
                className: "bp-meet-button",
                type: "button",
                disabled: instant.status === "working",
                onClick: () => void startInstant(),
              },
              instant.status === "working" ? "Starting…" : "Start a meeting now",
            ),
        instant.status === "error"
          ? h("span", { className: "bp-meet-error" }, "Google could not create the meeting.")
          : null,
      ),
    );
  };
}

function createSettingsCard({ React, vault, google, registry }) {
  const { useState, useEffect } = React;
  const h = React.createElement;

  return function MeetSettings() {
    const [config, setConfig] = useState({});
    const [place, setPlace] = useState(vault.place());
    const [clientId, setClientId] = useState("");
    const [clientSecret, setClientSecret] = useState("");
    const [registryToken, setRegistryToken] = useState("");
    const [phase, setPhase] = useState("idle"); // idle | authorize
    const [authUrl, setAuthUrl] = useState("");
    const [pasted, setPasted] = useState("");
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

    // --- the shared room registry ------------------------------------------
    const saveRegistry = async () => {
      const value = registryToken.trim();
      if (value.length < 16) {
        setMessage({ kind: "error", text: "That is too short to be the registry token." });
        return;
      }
      setBusy(true);
      const result = await vault.write({ registryToken: value });
      setBusy(false);
      if (!result.kept) {
        setMessage({ kind: "error", text: "The system store did not keep the token. Nothing was changed." });
        return;
      }
      setRegistryToken("");
      sync();
      setMessage({ kind: "ok", text: "Registry token saved. The Meet button now appears in every conversation." });
    };

    const clearRegistry = async () => {
      setBusy(true);
      await vault.write({ registryToken: undefined });
      sync();
      setBusy(false);
      setMessage({ kind: "ok", text: "Registry token removed. The Meet button is hidden." });
    };

    const googleSection = connected
      ? h(
          "div",
          null,
          h("p", { className: "bp-meet-status" }, "Connected to Google Calendar and Meet."),
          h(
            "div",
            { className: "bp-meet-actions" },
            h(
              "button",
              { className: "bp-meet-button", type: "button", disabled: busy, onClick: () => void disconnect() },
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
              { className: "bp-meet-hint" },
              "Open the link and approve access. The browser then lands on a page that says the site cannot be reached — " +
                "that is expected, because nothing listens on 127.0.0.1. Copy that whole address and paste it below.",
            ),
            h(
              "a",
              { className: "bp-meet-button bp-meet-button-primary", href: authUrl, target: "_blank", rel: "noopener noreferrer" },
              "Open Google sign-in",
            ),
            h(
              "div",
              { className: "bp-meet-actions" },
              h("input", {
                className: "bp-meet-field",
                type: "text",
                spellCheck: false,
                autoComplete: "off",
                placeholder: "http://127.0.0.1:8765/?code=…",
                value: pasted,
                onChange: (event) => setPasted(event.target.value),
              }),
              h(
                "button",
                { className: "bp-meet-button", type: "button", disabled: busy || !pasted.trim(), onClick: () => void finishConnect() },
                busy ? "Finishing…" : "Finish",
              ),
            ),
          )
        : h(
            "div",
            null,
            h(
              "p",
              { className: "bp-meet-hint" },
              "Paste the client ID and secret from your Google Cloud project's OAuth client (type Desktop app). " +
                "They are kept in the system credential store, never shown again, and never sent anywhere except Google's token endpoint.",
            ),
            h("input", {
              className: "bp-meet-field",
              type: "text",
              spellCheck: false,
              autoComplete: "off",
              placeholder: "Client ID (…apps.googleusercontent.com)",
              value: clientId,
              onChange: (event) => setClientId(event.target.value),
            }),
            h("input", {
              className: "bp-meet-field",
              type: "password",
              autoComplete: "off",
              placeholder: "Client secret",
              value: clientSecret,
              onChange: (event) => setClientSecret(event.target.value),
            }),
            h(
              "div",
              { className: "bp-meet-actions" },
              h(
                "button",
                { className: "bp-meet-button bp-meet-button-primary", type: "button", disabled: busy, onClick: () => void beginConnect() },
                busy ? "Preparing…" : "Connect Google",
              ),
            ),
          );

    return h(
      "div",
      null,
      h("p", { className: "bp-meet-label" }, "Google Calendar and Meet"),
      googleSection,
      message ? h("p", { className: message.kind === "error" ? "bp-meet-error" : "bp-meet-status" }, message.text) : null,

      h("hr", { className: "bp-meet-divider" }),

      h("p", { className: "bp-meet-label" }, "Shared rooms"),
      h(
        "p",
        { className: "bp-meet-hint" },
        "A conversation's Meet room is stored in a small registry so everyone with this token joins the same room. " +
          `Without a token the Meet button stays hidden. The registry is ${REGISTRY_ORIGIN}.`,
      ),
      h("input", {
        className: "bp-meet-field",
        type: "password",
        autoComplete: "off",
        placeholder: config.registryToken ? "A token is saved" : "Registry token",
        value: registryToken,
        onChange: (event) => setRegistryToken(event.target.value),
      }),
      h(
        "div",
        { className: "bp-meet-actions" },
        h(
          "button",
          {
            className: "bp-meet-button",
            type: "button",
            disabled: busy || !registryToken.trim(),
            onClick: () => void saveRegistry(),
          },
          config.registryToken ? "Replace token" : "Save token",
        ),
        config.registryToken
          ? h(
              "button",
              { className: "bp-meet-button", type: "button", disabled: busy, onClick: () => void clearRegistry() },
              "Remove",
            )
          : null,
      ),

      h(
        "p",
        { className: "bp-meet-status" },
        connected
          ? `Saved in ${whereKept}.`
          : storeName
            ? `Nothing saved yet. Your details will go to ${storeName}.`
            : "Nothing saved yet. This system has no credential store the plugin can reach, so details will be kept in this Buzz profile in plain text.",
      ),
    );
  };
}

// ---------------------------------------------------------------------------
// The channel launcher: one Meet room per conversation, shared by the registry
//
// Rendered inside the channel and DM header, left of the huddle control: the
// host sorts launchers by key, and only buzz.huddles and buzz.github rank above
// zero.
// ---------------------------------------------------------------------------

function launcherMessage(reason) {
  if (reason === "registry-token") return "Set the registry token in Settings → Plugins → Meet.";
  if (reason === "no-registry-token") return "Set the registry token in Settings → Plugins → Meet.";
  if (reason === "meet") return "Google could not create the meeting.";
  if (reason === "reauthorise") return "Google access expired. Reconnect in Settings → Plugins → Meet.";
  return "The room registry is unreachable.";
}

// The Meet mark, drawn inline as DOM nodes: no image element, no data URI, no
// fetch, and no dependence on the injected stylesheet.
//
// Shape from Wikimedia Commons, "Google Meet icon (2026).svg" — public domain
// there, flagged trademarked. Read from the file rather than guessed:
//   path2   the horn, drawn first so the body overlaps its tip
//   path4   the body
//   circle  the white dot
//   path6   only a <mask> shape, not something to draw
//   path9   a blurred pink glow inside the body; dropped, it needs the filter
const MEET_MARK = {
  horn: "M 102.015,81.88 C 95.186,77.162 95.094,67.102 101.836,62.26 L 157,22.643 c 7.94,-5.701 19,-0.038 19,9.737 v 77.755 c 0,9.675 -10.861,15.359 -18.821,9.859 z",
  body: "M 0,44 C 0,19.7 19.7,0 44,0 h 64 c 11.046,0 20,8.954 20,20 v 98 c 0,11.046 -8.954,20 -20,20 H 20 C 8.9539999,138 0,129.046 0,118 Z",
  dot: { cx: 30, cy: 108, r: 14 },
};

// Muted while the conversation has no room, yellow once it has one.
const MARK_IDLE = { strong: "#9aa0a6", soft: "#ffffff" };
const MARK_LIVE = { strong: "#fbbc04", soft: "#ffffff" };

/** Horn, body, then the dot on top — the order the source draws them in. */
export function meetMarkShapes(colors) {
  const { strong, soft } = colors;
  return [
    { kind: "path", name: "horn", d: MEET_MARK.horn, fill: strong },
    { kind: "path", name: "body", d: MEET_MARK.body, fill: strong },
    { kind: "circle", name: "dot", cx: MEET_MARK.dot.cx, cy: MEET_MARK.dot.cy, r: MEET_MARK.dot.r, fill: soft },
  ];
}

function meetMarkElement(h, colors) {
  return h(
    "svg",
    {
      className: "bp-meet-mark",
      viewBox: "0 0 176 138",
      width: 18,
      height: 14,
      // Inline so the mark renders even if the style element did not apply.
      style: { width: "18px", height: "14px", display: "block" },
      "aria-hidden": "true",
      focusable: "false",
    },
    meetMarkShapes(colors).map((shape) =>
      shape.kind === "circle"
        ? h("circle", { key: shape.name, cx: shape.cx, cy: shape.cy, r: shape.r, fill: shape.fill })
        : h("path", { key: shape.name, d: shape.d, fill: shape.fill }),
    ),
  );
}

function createChannelLauncher({ React, registry, google }) {
  const { useState, useEffect, useCallback } = React;
  const h = React.createElement;

  return function MeetLauncher({ context }) {
    const channelId = context?.channelId;
    const [state, setState] = useState({ status: "loading" });
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
      if (!channelId || !registry.configured()) {
        setState({ status: "off" });
        return;
      }
      try {
        const room = await registry.getRoom(channelId);
        setState(room ? { status: "room", room } : { status: "none" });
      } catch (error) {
        setState({ status: "error", reason: error.message });
      }
    }, [channelId]);

    useEffect(() => {
      void load();
    }, [load]);

    const start = async () => {
      setBusy(true);
      try {
        const space = await google.createSpace();
        const room = await registry.putRoom(channelId, space);
        setState({ status: "room", room });
      } catch (error) {
        setState({ status: "error", reason: error.message });
      }
      setBusy(false);
    };

    // No token, or still reading: contribute nothing rather than a dead control.
    if (state.status === "off" || state.status === "loading") return null;

    if (state.status === "room") {
      return h(
        "a",
        {
          className: "bp-meet-launcher",
          href: state.room.uri,
          target: "_blank",
          rel: "noopener noreferrer",
          "aria-label": "Join the Meet room for this conversation",
          title: `Join the Meet room — ${state.room.code}`,
        },
        meetMarkElement(h, MARK_LIVE),
      );
    }

    return h(
      "button",
      {
        className: "bp-meet-launcher",
        type: "button",
        disabled: busy,
        "aria-label": "Start a Meet room for this conversation",
        title:
          state.status === "error"
            ? launcherMessage(state.reason)
            : "Start a Meet room that everyone in this conversation can join",
        onClick: () => void start(),
      },
      meetMarkElement(h, MARK_IDLE),
    );
  };
}

// ---------------------------------------------------------------------------
// The /meet command
//
// A composer completion: typing /meet offers the conversation's room link, and
// accepting it replaces the command with that link. The message is still sent
// by the person — a plugin cannot send one.
// ---------------------------------------------------------------------------

export const MEET_COMMAND = "/meet";

/**
 * A pure matcher for the /meet word immediately before the cursor. The host
 * calls this on every keystroke, so it must not do anything but look at text.
 */
export function matchMeetCommand(text, cursor) {
  const upTo = String(text ?? "").slice(0, Math.max(0, cursor ?? 0));
  if (!upTo.endsWith(MEET_COMMAND)) return null;
  const start = upTo.length - MEET_COMMAND.length;
  // Only at the start of a word, so an address or a path never triggers it.
  if (start > 0 && !/[\s([{>"']/.test(upTo[start - 1])) return null;
  return { start, end: upTo.length, query: "meet" };
}

// One creation per conversation, even if two composers mount at once.
const creating = new Map();

async function ensureRoom({ registry, google, channelId }) {
  const existing = await registry.getRoom(channelId);
  if (existing) return existing;
  if (creating.has(channelId)) return creating.get(channelId);
  const attempt = (async () => {
    const space = await google.createSpace();
    return registry.putRoom(channelId, space);
  })().finally(() => creating.delete(channelId));
  creating.set(channelId, attempt);
  return attempt;
}

function createMeetCommand({ React, registry, google }) {
  const { useEffect } = React;

  return function MeetCommand({ channelId, publish }) {
    useEffect(() => {
      let live = true;
      let withdraw = false;
      publish({ items: [], status: "Looking up this conversation's Meet room…" });
      void ensureRoom({ registry, google, channelId })
        .then((room) => {
          if (!live) return;
          if (withdraw) withdraw();
          withdraw = publish({
            items: [
              {
                id: "meet-link",
                label: "Insert the Meet link",
                detail: room.code,
                edit: { text: room.uri },
              },
            ],
          });
        })
        .catch((error) => {
          if (!live) return;
          if (withdraw) withdraw();
          withdraw = publish({ items: [], status: launcherMessage(error.message) });
        });
      return () => {
        live = false;
        if (withdraw) withdraw();
      };
    }, [channelId, publish]);
    return null;
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
  const registry = createRegistry({ host: ctx.host, vault });
  const MeetLauncher = createChannelLauncher({ React, registry, google });
  const MeetCommand = createMeetCommand({ React, registry, google });

  ctx.effect(() => {
    // [DOM] API v1 has no CSS file and the host has no style service, so the
    // page's rules are one <style> element, removed with this scope.
    const style = document.createElement("style");
    style.dataset.buzzPluginMeet = "";
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
    component: createMeetPage({ React, vault, google, openSettings }),
  });

  // The launcher is the whole point of this panel: it renders in the channel
  // and DM header, and the panel itself is never opened.
  ctx.panels.register({
    id: "meet-room",
    title: "Meet",
    matches: () => false,
    channelPlacement: "side",
    channelLauncher: ({ context }) => React.createElement(MeetLauncher, { context }),
    component: () => null,
  });

  // /meet in the composer offers this conversation's room link.
  ctx.conversation.registerCompletion({
    id: "meet-room",
    title: "Meet room",
    order: 0,
    match: (observation) => matchMeetCommand(observation.text, observation.start),
    component: MeetCommand,
  });

  ctx.settingsCards.register({
    id: "settings",
    title: "Meet",
    group: "Plugins",
    component: createSettingsCard({ React, vault, google, registry }),
  });
}
