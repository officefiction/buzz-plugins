# Meet

Your next Google Meet calls inside Buzz. A **Join** button opens the meeting in your browser, and
**Start a meeting now** creates one on the spot.

Two ways to connect:

| | What it needs | What you get |
| --- | --- | --- |
| **Google sign-in** (recommended) | an OAuth client from your own Google Cloud project | live calendar, real Meet links, instant meetings |
| **iCal address** (fallback) | one pasted URL | the calendar, a few minutes behind |

## What it does

- A **Meet** page in the sidebar: the next call and the ones after it
- **Join** opens the meeting in your system browser, where you are already signed in to
  Workspace — full camera, microphone, screen share and audio
- **Start a meeting now** creates a Meet space and hands you its link
- Refreshes every 60 seconds while the page is open
- Every colour comes from a Buzz theme token

## Why the link and not an embedded call

`meet.google.com` answers `X-Frame-Options: DENY`, so the meeting cannot be drawn inside an
iframe in any engine, and no Google API returns an embeddable Meet UI. Google's Add-ons SDK runs
the other way: it puts your app inside Meet. A link handed to the real browser is the only shape
that works.

## Install

1. **Settings → Plugins → Manage plugins → Add**, then drop this folder in, or point at
   `https://github.com/officefiction/buzz-plugins` and press **Find**
2. Review the grants: **four network origins** (`calendar.google.com`, `www.googleapis.com`,
   `meet.googleapis.com`, `oauth2.googleapis.com`) and six commands for the credential store
   (`security` ×3, `secret-tool` ×3)
3. Install, then **enable** it
4. **Settings → Plugins → Meet** and either connect Google or paste an iCal address

## Connecting Google

You need an OAuth client of type **Desktop app** from your own Google Cloud project. One-time
setup, roughly ten minutes:

1. Create a project — https://console.cloud.google.com/projectcreate
2. Enable **Google Calendar API** and **Google Meet REST API**
3. OAuth consent screen → user type **Internal** (Workspace only; no verification, and refresh
   tokens do not expire weekly the way *Testing* mode does)
4. Add these two scopes:

```
https://www.googleapis.com/auth/calendar.events.readonly
https://www.googleapis.com/auth/meetings.space.created
```

5. Create credentials → OAuth client ID → **Desktop app**. No redirect URI to enter.
6. Paste the **client ID** and **client secret** into Settings → Plugins → Meet, then press
   **Connect Google**

### The paste-back step, and why it exists

Press **Connect Google** and the card shows an **Open Google sign-in** link. Press it: the page
opens in your real browser, you approve, and the browser then lands on a page saying the site
cannot be reached.

**That is expected.** Nothing listens on `127.0.0.1:8765`, because a plugin cannot open a port.
The authorisation code is in the address bar:

```
http://127.0.0.1:8765/?state=&code=4/0AX4XfWi…&scope=…
```

Copy that whole address and paste it into the card, then press **Finish**. The code is exchanged
for a refresh token, which goes into the system credential store and is never shown again.

The alternative would be OAuth inside Buzz's own webview, which Google refuses outright.

## Where the details are kept

| Platform | Where |
| --- | --- |
| macOS | Your Keychain, through `security`. A save counts only once it has been read back. |
| Linux | The system secret store (Secret Service), through `secret-tool`. |
| Windows, or a Linux box with no secret store | This Buzz profile's `localStorage`, as **plain text**, and the settings card says so. |

The client secret and the refresh token are never rendered after saving and never logged. They
go to `oauth2.googleapis.com` and nowhere else.

## The iCal fallback

Google Calendar → **Settings and sharing** → *Integrate calendar* → **Secret address in iCal
format**:

```text
https://calendar.google.com/calendar/ical/<id>/private-<token>/basic.ics
```

> **Not the public address.** `…/public/basic.ics` also loads, but Google strips it: every event
> that is not public arrives as `SUMMARY:Busy`, with no summary, no location and **no Meet link**.
> A calendar of private events read through the public address looks empty. The plugin says so
> when it sees one.

The feed is cached by Google, so a meeting created a minute ago may take several minutes to
appear. This is the reason Google sign-in is the recommended path.

## Limits, stated plainly

- **Meet cannot be embedded.** The Join button hands off to the browser.
- **The Meet API manages meetings, not video.** It creates spaces and reports attendance,
  recordings and transcripts; it cannot draw a call.
- **One calendar.** The OAuth path reads the account's primary calendar; the iCal path reads one
  feed.
- **A changed single occurrence** of a repeating event: the iCal path shows the master's time.
  The OAuth path does not have this problem, because Google expands the series.
- Never run on Windows. macOS is untested.

## Development

Nothing to build: `plugin.js` is the shipped module, and Node runs the tests.

```bash
npm test
```

| Test | Covers |
| --- | --- |
| `test.mjs` | iCalendar parsing, folding, Meet links, recurrence, EXDATE, UNTIL |
| `test-dst.mjs` | a weekly meeting keeps its wall-clock time across a DST change |
| `test-address.mjs` | secret vs public address shapes |
| `test-oauth.mjs` | PKCE, the auth URL, the pasted redirect, token bodies, Calendar API mapping |
| `test-vault.mjs` | the JSON vault over the credential store |
| `check.mjs` | manifest rules from `block/buzz-app`, plus an `apply()` smoke test |

Written against `block/buzz-app` (Buzz 1.0, plugin API v1). Sources are named in `NOTES.md`.
