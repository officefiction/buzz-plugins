# Notes — what was verified, what was not

Kept in the shape the build guide asks for: what works through the API, what needed the DOM and
why, what was verified, and what was not.

## Written against

| Thing | Where |
| --- | --- |
| Plugin API v1 (services, `ctx.host`, `ctx.effect`) | `block/buzz-app` `docs/plugin-architecture.md` |
| Manifest schema and limits | `block/buzz-app` `crates/plugin-manager/src/lib.rs` (`Manifest`, `valid_program`, `MAX_*`) |
| Category slugs | `block/buzz-app` `src/app/plugin-categories.ts` |
| Build rules and pitfalls | the MEGATECH `buzz-plugins` `docs/building.md` |
| OAuth for installed apps | `developers.google.com/identity/protocols/oauth2/native-app` |
| Calendar API | `developers.google.com/workspace/calendar/api/v3/reference/events/list` |
| Meet API | `developers.google.com/workspace/meet/api/reference/rest/v2/spaces/create` |

## Through the API only

- `ctx.pages.register` — the Meet page
- `ctx.settingsCards.register` — the settings card
- `ctx.navigation.open` — the "Open settings" button, to `com.buzzplugins.meet/settings`
- `ctx.host.request` — the token exchange, the refresh, `events.list` and `spaces.create`,
  restricted by the manifest to three origins
- `ctx.host.runCommand` — the six declared credential-store commands
- `ctx.effect` — the style element, removed when the plugin's scope ends
- `ctx.react` — every element; no other import, no build step

## DOM, and why

One line, tagged `[DOM]` in `plugin.js`:

- A single `<style>` element appended to `document.head`, inside `ctx.effect`. API v1 has no CSS
  file and the host exposes no style service, so the rules have to arrive this way. It is removed
  by the effect's cleanup.

No selector reaches into host markup. Nothing here breaks when the host renames a component.

## Network

Three declared origins, all reached through `ctx.host.request`:

| Origin | Why |
| --- | --- |
| `https://oauth2.googleapis.com` | code exchange and refresh |
| `https://www.googleapis.com` | Calendar API `events.list` |
| `https://meet.googleapis.com` | Meet API `spaces.create` |

No `fetch`, no `WebSocket`, no remote image, no `eval`. The Google sign-in page is opened by the
host from an `<a>`, not fetched — which is also why it is not a declared origin.

## The credentials

The client ID and secret from the user's own Google Cloud project, plus the refresh token Google
issues. The client secret is a public-client secret: for a Desktop app client it cannot be kept
confidential, which is why PKCE is used on top of it.

They are:

- Never embedded in the plugin, the manifest, a test or a log
- Stored as one JSON document in the Keychain (`security`) or the Secret Service (`secret-tool`),
  confirmed by reading it back — an exit status of 0 is not trusted
- Where neither store exists, kept in this profile's `localStorage` as plain text, and the
  settings card says so in those words
- Never rendered after saving, never logged
- Sent only to the origins above

## What was verified

Run on Node 22, `npm test`:

| Check | Result |
| --- | --- |
| PKCE verifier length and character set; two are never equal | pass |
| S256 challenge matches an independent SHA-256 | pass |
| Auth URL: endpoint, loopback redirect, `S256`, `offline`, forced consent, both scopes, no write scope | pass |
| Pasted redirect: code extracted, `access_denied` reported as itself, empty and code-less input | pass |
| Exchange and refresh bodies carry the verifier, redirect and client | pass |
| Calendar mapping: cancelled dropped, `hangoutLink` and video entry points, offsets, all-day, duration, missing end | pass |
| `upcoming()`: window filter, order, de-duplication | pass |
| Vault: merge, key removal, corrupt and non-object documents, a refused save | pass |
| Manifest: allowed keys, byte limits, category slug, program and argument rules | pass |
| Naming and origin hygiene: no company name in the plugin, exactly three API origins | pass |
| `apply()` registers one page and one card, adds one style, cleanup callable | pass |

Bugs these tests found, rather than luck:

1. `createVault` accepted a JSON **array** as a document. Spreading one into a later write would
   have stored numeric keys.
2. `parseRedirect` refused a bare query string with no `?`.
3. The vault, the redirect parser and the auth URL were all written before they had a caller.

Earlier, while the plugin still read iCal feeds, the same discipline caught two more: `UNTIL` was
compared against the series start instead of each occurrence, and repeated times were computed in
UTC so a weekly 10:00 meeting became 09:00 after the clocks changed. Both mattered only to that
path, which has since been removed — the Calendar API expands recurrences itself.

## What was not verified

- **The OAuth flow has never been run by the author against Google.** PKCE, the auth URL, the
  redirect parser and the Calendar mapping are tested against a stand-in host. The one real
  connect was done by the plugin's owner, in the app, and it worked — but that run is not
  reproducible here and no error path has been seen.
- **Never loaded into the Buzz desktop app by the author.** The `apply()` smoke test uses a stub
  host. Two host behaviours are assumed rather than seen: that `<a target="_blank">` opens the
  system browser (the sign-in link and every Join button depend on it), and that `crypto.subtle`
  exists in the webview for the S256 challenge.
- **POST bodies through `host.request`.** The exchange and refresh send
  `application/x-www-form-urlencoded` bodies. The documented `HostRequest` carries a `body` string
  and headers, but nothing states the content type survives — untested here.
- **`spaces.create` has never been called.** The request shape and the `meetingUri` field are from
  the reference, not from a response.
- **The credential store was not exercised directly.** No `security` or `secret-tool` call was
  made by the tests: they pass a stub runner.
- **macOS (WKWebView) and Windows were not run.** Linux desktop was not run either.
- **`placement: "sidebar"`** is from the `Page` type. Whether the host honours it for an installed
  plugin is unconfirmed; if the page does not appear in the sidebar, drop that one line.

## Known gaps in behaviour

- Meet cannot be embedded; the Join button hands off to the browser.
- One calendar: the connected account's primary calendar.
- The Meet API reports attendance, recordings and transcripts but none of that is shown yet.
- Refresh happens on demand, not on a timer; a token is fetched again when it is close to expiry.
