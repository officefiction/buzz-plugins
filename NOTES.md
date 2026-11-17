# Notes — what was verified, what was not

Kept in the shape the MEGATECH build guide asks for: what works through the API, what needed the
DOM and why, what was verified, and what was not.

## Written against

| Thing | Where |
| --- | --- |
| Plugin API v1 (services, `ctx.host`, `ctx.effect`) | `block/buzz-app` `docs/plugin-architecture.md` |
| Manifest schema and limits | `block/buzz-app` `crates/plugin-manager/src/lib.rs` (`Manifest`, `valid_program`, `MAX_*`) |
| Category slugs | `block/buzz-app` `src/app/plugin-categories.ts` |
| Build rules and pitfalls | `0xnfrith/buzz-plugins` `docs/building.md` |
| Worked connector example | `0xnfrith/buzz-plugins` `plugins/linear` |

## Through the API only

Everything in this plugin uses documented services:

- `ctx.pages.register` — the Meet page
- `ctx.settingsCards.register` — the settings card
- `ctx.navigation.open` — the "Open settings" button, to `com.officefiction.meet/settings`
- `ctx.host.request` — the one call that reads the calendar, restricted by the manifest to
  `https://calendar.google.com`
- `ctx.host.runCommand` — the six declared credential-store commands
- `ctx.effect` — the style element, removed when the plugin's scope ends
- `ctx.react` — every element; no other import, no build step

## DOM, and why

One line, tagged `[DOM]` in `plugin.js`:

- A single `<style>` element appended to `document.head`, inside `ctx.effect`. API v1 has no CSS
  file and the host exposes no style service, so the rules have to arrive this way. It is removed
  by the effect's cleanup.

No selectors reach into host markup. Nothing here breaks when Block renames a component.

## Network

One origin: `https://calendar.google.com`, declared in `manifest.json` and used only through
`ctx.host.request`. No `fetch`, no `WebSocket`, no remote image, no `eval`.

## The credential

The calendar's secret iCal address, which is the user's own and is not a password:

- Never embedded in the plugin, the manifest, a test or a log
- Saved to the Keychain (`security`) or the Secret Service (`secret-tool`), and confirmed by
  reading it back — an exit status of 0 is not trusted
- Where neither store exists, kept in this profile's `localStorage` as plain text, and the
  settings card says so in those words
- Never rendered after saving, never logged, sent only in one request header

The address is validated before it is saved: it must be
`https://calendar.google.com/calendar/ical/…/basic.ics`, and the feed must actually parse. A
refused address is not saved, and an existing saved address is never replaced by one that failed.

## What was verified

Run on Node 22, `npm test`:

| Check | Result |
| --- | --- |
| iCalendar line unfolding | pass |
| `X-GOOGLE-CONFERENCE` and Meet link in `DESCRIPTION` | pass |
| `TZID` start converted to the right UTC instant | pass |
| Weekly `BYDAY` with `COUNT`, `EXDATE` removed after `COUNT` | pass |
| Daily `INTERVAL` | pass |
| `UNTIL` bounds the series | pass |
| All-day events flagged, duration carried to instances | pass |
| **Wall-clock time holds across a DST change** | pass (14:00Z → 15:00Z, still 10:00 local) |
| Manifest: allowed keys, byte limits, category slug, program and argument rules | pass |
| `apply()` registers one page and one card, adds one style, cleanup callable | pass |

Two bugs were found and fixed by these tests rather than by luck:

1. `UNTIL` was compared against the **series start** instead of each candidate, so a bounded
   series ran forever.
2. Repeated times were computed in **UTC**, so a weekly 10:00 meeting became 09:00 after the
   clocks changed. Calendar times are now held as civil time plus a zone and placed in that zone
   per occurrence.

## What was not verified

- **Never loaded into the Buzz desktop app.** The `apply()` smoke test uses a stub host, not the
  real one. The first install is the real test.
- **Never fetched a real Google calendar.** The parser was tested against hand-written feeds
  shaped like Google's export. A real feed may carry properties this parser ignores — that is
  fine — or a shape it mishandles, which is not.
- **The credential store was not exercised.** No `security` or `secret-tool` call was made: the
  tests pass a stub runner. The read-back logic is unproven against the real programs.
- **macOS (WKWebView) and Windows were not run at all.** Linux desktop was not run either.
- **`placement: "sidebar"`** is from the `Page` type. Whether the host honours it for an installed
  plugin is unconfirmed; if the page does not appear in the sidebar, drop that one line.

## Found in the field

The first real install added the **public** calendar address, not the secret one, and the page
showed nothing. The feed was fetched and parsed to find out why:

| Observed | Cause |
| --- | --- |
| 21 events parsed | the feed is real and the parser reads it |
| **21 of 21 titled `Busy`** | Google redacts every non-public event in a public feed |
| **0 with a Meet link** | details are stripped with the summary |
| latest event 2026-11-16, page empty on 2026-11-17 | every event in the feed was already in the past |

So the plugin was correct and the address was wrong. Two changes came from it:

- `isPublicFeed()` marks a `…/public/basic.ics` address, and the settings card warns as soon as one
  is typed or saved
- The empty page now says what it read — "Read N events; the latest starts <date>" — and names the
  public-address fault directly instead of showing a bare "nothing coming up"

Covered by `test-address.mjs`.

## Known gaps in behaviour

- `RECURRENCE-ID` overrides (a single edited instance) are ignored; the master rule is used.
- Monthly rules with an ordinal `BYDAY` (e.g. `2TU`) fall back to the day of the month.
- One calendar feed per install.
- Google caches the iCal export, so changes are not instant.
- An all-day event with a Meet link shows "All day" and no time range.
