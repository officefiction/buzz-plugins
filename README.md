# Meet

Your next Google Meet calls inside Buzz, with a **Join** button that opens them in your browser.

One pasted string connects it: your calendar's **secret address in iCal format**. No Google
sign-in, no OAuth client, no token that expires in an hour.

## What it does

- A **Meet** page (sidebar) showing the next call and the ones after it
- **Join** opens the meeting in your system browser, where you are already signed in to
  Workspace — full camera, microphone, screen share and audio
- Refreshes every 60 seconds while the page is open
- Follows Buzz's theme: every colour comes from a host token

## Why the link and not an embedded call

`meet.google.com` answers `X-Frame-Options: DENY`, so the meeting cannot be drawn inside an
iframe in any engine, and no Google API returns an embeddable Meet UI. A link handed to the real
browser is the only shape that works. Google's own Add-ons SDK runs the other way: it puts your
app inside Meet.

## How to install

1. **Settings → Plugins → Manage plugins → Add**, then either drop this folder in or point at a
   Git repository that holds it and press **Find**.
2. Review what it asks for: **one network origin**, `https://calendar.google.com`, and six
   commands for the credential store (`security` three times, `secret-tool` three times).
3. Install, then **enable** it.
4. **Settings → Plugins → Meet**, paste the calendar address, press **Save**.
5. Open **Meet** in the page navigation.

## Where to get the calendar address

Google Calendar → **Settings and sharing** → *Integrate calendar* → **Secret address in iCal
format**. It looks like:

```text
https://calendar.google.com/calendar/ical/<id>/private-<token>/basic.ics
```

It is a private, read-only link to **one** calendar. Anyone who has it can read that calendar, so
treat it like a password. It is sent only to `calendar.google.com`.

To see shared or team calendars too, add one of those calendars' own secret address — this version
reads a single feed.

## Where the address is kept

| Platform | Where |
| --- | --- |
| macOS | Your Keychain, through `security`. A save counts only once it has been read back. |
| Linux | The system secret store (Secret Service), through `secret-tool`. |
| Windows, or a Linux box with no secret store | This Buzz profile's `localStorage`, as **plain text**, and the settings card says so. |

After saving, the address is never shown again and never logged. It goes into one request header
and nowhere else.

## Limits, stated plainly

- **The feed is cached by Google.** A meeting created or moved a minute ago may take a few minutes
  to appear. This is a feed, not a live API.
- **A changed single occurrence is shown from the original rule.** If you edit one instance of a
  repeating meeting, this version shows the master's time for it (`RECURRENCE-ID` overrides are
  not applied).
- **Monthly rules that count weekdays** ("second Tuesday") fall back to the day of the month.
  Weekly rules with `BYDAY`, daily rules and `INTERVAL` all work.
- **One calendar per install.**
- Never run on Windows, and macOS is untested. See `NOTES.md`.

## Development

Nothing to build: `plugin.js` is the shipped module. Node runs the tests.

```bash
npm test
```

- `test.mjs` — iCalendar parsing, folding, Meet-link extraction, recurrence, EXDATE, UNTIL
- `test-dst.mjs` — a weekly meeting across a DST change keeps its wall-clock time
- `check.mjs` — manifest rules taken from `block/buzz-app`, plus an `apply()` smoke test

Written against `block/buzz-app` (Buzz 1.0, plugin API v1). Sources are named in `NOTES.md`.
