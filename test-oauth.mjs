import { createHash, randomBytes } from "node:crypto";
import {
  makeVerifier,
  base64url,
  challengeFor,
  buildAuthUrl,
  parseRedirect,
  exchangeBody,
  refreshBody,
  eventsFromApi,
  AUTH_ENDPOINT,
  LOOPBACK_REDIRECT,
} from "./plugin.js";

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`}`);
};

// --- PKCE -----------------------------------------------------------------
const verifier = makeVerifier(randomBytes(64));
check("verifier is 64 chars", verifier.length, 64);
check("verifier uses only unreserved chars", /^[A-Za-z0-9\-._~]+$/.test(verifier), true);
check("two verifiers differ", makeVerifier() === makeVerifier(), false);

// independent reference implementation of S256
const reference = createHash("sha256").update(verifier).digest("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const challenge = await challengeFor(verifier);
check("challenge matches an independent SHA-256", challenge, reference);
check("challenge is base64url with no padding", /^[A-Za-z0-9\-._]+$/.test(challenge), true);
check("base64url of empty is empty", base64url(new Uint8Array([])), "");

// --- auth URL -------------------------------------------------------------
const url = buildAuthUrl({ clientId: "123.apps.googleusercontent.com", challenge });
check("auth URL uses the documented endpoint", url.startsWith(AUTH_ENDPOINT + "?"), true);
const params = new URL(url).searchParams;
check("client_id carried", params.get("client_id"), "123.apps.googleusercontent.com");
check("redirect_uri is the loopback", params.get("redirect_uri"), LOOPBACK_REDIRECT);
check("response_type is code", params.get("response_type"), "code");
check("PKCE method is S256", params.get("code_challenge_method"), "S256");
check("challenge carried", params.get("code_challenge"), challenge);
check("offline access requested", params.get("access_type"), "offline");
check("consent forced for a refresh token", params.get("prompt"), "consent");
const scopes = params.get("scope").split(" ");
check("calendar scope requested", scopes.includes("https://www.googleapis.com/auth/calendar.events.readonly"), true);
check("meet scope requested", scopes.includes("https://www.googleapis.com/auth/meetings.space.created"), true);
check("no write scope on the calendar", scopes.some((s) => s === "https://www.googleapis.com/auth/calendar"), false);

// --- pasted redirect ------------------------------------------------------
const real =
  "http://127.0.0.1:8765/?state=&code=4/0AX4XfWiEXAMPLEcode-_123&scope=https://www.googleapis.com/auth/calendar.events.readonly";
check("code extracted from a pasted address", parseRedirect(real), { ok: true, code: "4/0AX4XfWiEXAMPLEcode-_123" });
check("consent denied is reported", parseRedirect("http://127.0.0.1:8765/?error=access_denied"), {
  ok: false,
  reason: "access_denied",
});
check("empty paste", parseRedirect("   "), { ok: false, reason: "empty" });
check("no code", parseRedirect("http://127.0.0.1:8765/?state=x"), { ok: false, reason: "no code in that address" });
check(
  "bare query string still parsed",
  parseRedirect("code=abc123").ok,
  true,
);

// --- token requests -------------------------------------------------------
const body = new URLSearchParams(
  exchangeBody({ code: "c0de", verifier: "v3r", clientId: "cid", clientSecret: "sec" }),
);
check("exchange uses authorization_code", body.get("grant_type"), "authorization_code");
check("exchange carries the verifier", body.get("code_verifier"), "v3r");
check("exchange carries the redirect", body.get("redirect_uri"), LOOPBACK_REDIRECT);
check("exchange carries the client", [body.get("client_id"), body.get("client_secret")], ["cid", "sec"]);

const refresh = new URLSearchParams(refreshBody({ refreshToken: "rt", clientId: "cid", clientSecret: "sec" }));
check("refresh uses refresh_token", refresh.get("grant_type"), "refresh_token");
check("refresh carries the token", refresh.get("refresh_token"), "rt");

// --- Calendar API mapping -------------------------------------------------
const api = eventsFromApi({
  items: [
    {
      id: "a1",
      iCalUID: "a1@google.com",
      status: "confirmed",
      summary: "Design review",
      start: { dateTime: "2026-11-18T10:00:00-05:00" },
      end: { dateTime: "2026-11-18T11:00:00-05:00" },
      hangoutLink: "https://meet.google.com/abc-defg-hij",
    },
    {
      id: "a2",
      status: "confirmed",
      summary: "No conferencing",
      start: { dateTime: "2026-11-19T09:00:00Z" },
      end: { dateTime: "2026-11-19T09:30:00Z" },
      conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+1" }] },
    },
    {
      id: "a3",
      status: "confirmed",
      summary: "Entry point only",
      start: { dateTime: "2026-11-20T12:00:00Z" },
      end: { dateTime: "2026-11-20T13:00:00Z" },
      conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/xyz-1234-abc" }] },
    },
    { id: "a4", status: "cancelled", summary: "Gone", start: { dateTime: "2026-11-21T12:00:00Z" } },
    { id: "a5", status: "confirmed", summary: "Holiday", start: { date: "2026-11-22" }, end: { date: "2026-11-23" } },
  ],
});
check("cancelled events dropped", api.length, 4);
check("hangoutLink read", api[0].meetUrl, "https://meet.google.com/abc-defg-hij");
check("offset converted to the right instant", api[0].start.toISOString(), "2026-11-18T15:00:00.000Z");
check("no link when only a phone entry point", api[1].meetUrl, undefined);
check("video entry point used", api[2].meetUrl, "https://meet.google.com/xyz-1234-abc");
check("all-day flagged", api[3].allDay, true);
check("all-day keeps a date", api[3].start.toISOString(), "2026-11-22T00:00:00.000Z");
check("duration carried", (api[0].end - api[0].start) / 60000, 60);
check("empty response", eventsFromApi({}), []);
check(
  "a missing end defaults to 30 minutes",
  (() => {
    const one = eventsFromApi({ items: [{ id: "z", status: "confirmed", summary: "Z", start: { dateTime: "2026-11-25T10:00:00Z" } }] });
    return (one[0].end - one[0].start) / 60000;
  })(),
  30,
);

// --- upcoming(): window, order, de-duplication ----------------------------
const { upcoming } = await import("./plugin.js");
const slots = upcoming(api, Date.parse("2026-11-18T00:00:00Z"), 14);
check("upcoming keeps what is in the window", slots.length, 4); // 18th, 19th, 20th, all-day 22nd
check("soonest first", slots[0].summary, "Design review");
check("nothing in a later window", upcoming(api, Date.parse("2026-12-30T00:00:00Z"), 14).length, 0);
check("anything older than an hour is dropped", upcoming(api, Date.parse("2026-11-19T18:00:00Z"), 14).length, 2);
check("same uid and start counted once", upcoming([api[0], api[0]], Date.parse("2026-11-18T00:00:00Z"), 14).length, 1);

console.log(fail === 0 ? "\nALL CHECKS PASSED" : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
