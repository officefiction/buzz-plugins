# Meet

Your next Google Meet calls inside Buzz. A **Join** button opens the meeting in your browser, and
**Start a meeting now** creates one on the spot.

Connects to Google with OAuth: your calendar, live, with real Meet links.

## What it does

- A **Meet** page in the sidebar: the next call and the ones after it
- **Join** opens the meeting in your system browser, where you are already signed in to
  Workspace — full camera, microphone, screen share and audio
- **Start a meeting now** creates a Meet space and hands you its link
- Refreshes every 60 seconds while the page is open
- Every colour comes from a Buzz theme token

## Why a link and not an embedded call

`meet.google.com` answers `X-Frame-Options: DENY`, so the meeting cannot be drawn inside an
iframe in any engine, and no Google API returns an embeddable Meet UI. Google's Add-ons SDK runs
the other way: it puts your app inside Meet. A link handed to the real browser is the only shape
that works.

## Install

1. **Settings → Plugins → Manage plugins → Add**, then drop this folder in, or point at a git
   repository that holds it and press **Find**
2. Review the grants: **three network origins** (`www.googleapis.com`, `meet.googleapis.com`,
   `oauth2.googleapis.com`) and six commands for the credential store (`security` ×3,
   `secret-tool` ×3)
3. Install, then **enable** it
4. **Settings → Plugins → Meet** and connect Google

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

The client secret and the refresh token are never rendered after saving and never logged. They go
to `oauth2.googleapis.com` and nowhere else.

## What is asked of your Google account

| Scope | Grants | Does not grant |
| --- | --- | --- |
| `calendar.events.readonly` | read events, titles, attendees, conferencing details | creating or changing events |
| `meetings.space.created` | create a meeting space | reading anyone else's spaces |

Deliberately not `calendar` (full read-write): the plugin has no reason to change your calendar.

## Limits, stated plainly

- **Meet cannot be embedded.** The Join button hands off to the browser.
- **The Meet API manages meetings, not video.** It creates spaces and reports attendance,
  recordings and transcripts; it cannot draw a call.
- **One calendar**: the primary calendar of the connected account.
- **Nothing is cached.** Every read is live, so a meeting you just created is there.
- Never run on Windows. macOS is untested.

## Installing for a team

A plugin installs into one machine, not into the relay. There is no relay-side plugin
store: the registry is `registry.json` in the app data folder
(`~/Library/Application Support/xyz.block.buzz.desktop/` on macOS).

Buzz can *recommend* a plugin across a team, which still needs one confirmation per person.
Write `managed-plugins.json` into the app data folder of each machine:

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/xyz.block.buzz.desktop/managed-plugins.json` |
| Windows | `%APPDATA%\xyz.block.buzz.desktop\managed-plugins.json` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/xyz.block.buzz.desktop/managed-plugins.json` |

`managed-plugins.example.json` in this repository is a working file. Update its `commit` to
the revision you have tested — a pin, so everyone gets the same code:

```bash
git rev-parse HEAD
```

The entry then appears under **Settings → Plugins** as "Recommended by Fiction". The person
still reviews the grants and presses install; the file never installs, enables or updates
anything itself. Delete it to withdraw the recommendation.

## Per-conversation rooms

A **Meet** icon button sits in the channel and DM header, to the left of the huddle control. It
gives each conversation one Meet room, the same room for everyone on the team:

| State | The icon is | Pressing it |
| --- | --- | --- |
| the conversation has no room | **grey** | creates a Meet space and records it |
| the conversation has a room | **yellow** | opens the room in your browser |
| no registry token is set | absent | — |

The mark is inlined as an SVG data URI — no image is fetched, so it renders offline and adds no
origin to the manifest. Its tooltip carries the room's meeting code.

The host sorts launchers by key, and only the huddle and GitHub controls rank above zero, so this
one renders to their left.

### `/meet` in the composer

Type `/meet` in any channel or DM. The composer offers **Insert the Meet link**, and accepting it
replaces the command with that conversation's room link. If the conversation has no room yet, one is
created first — the same room the launcher would make.

The message is still sent by you: a plugin cannot send one. The host replaces exactly the `/meet`
text, so the link lands where you typed it, and the room is recorded either way.

### Why a registry, and not the relay

The plugin API has no write path into Buzz: `ctx.conversation` contributes UI but never sends, and
`ctx.artifactStorage` exposes `get` and `page` only. A plugin therefore cannot publish a room to a
channel, and cannot write the canvas.

So the mapping lives in a small service, `meet-rooms.fiction.services`, keyed by channel id:

```
PUT    /rooms/<channelId>   { uri, code }   -> the room for that conversation
GET    /rooms/<channelId>                   -> 200 room, or 404
DELETE /rooms/<channelId>                   -> forget it
```

Source and compose file: `registry/` in this repository. One bearer token guards every route; the
token is stored in the system credential store beside the Google credentials.

Set the token once per person in **Settings → Plugins → Meet → Shared rooms**. Without it the
launcher stays hidden, so a missing token costs nothing.

This is also where transcripts will hang later: Meet's `conferenceRecords` are per space, and a
space is per conversation, so the room record is the join.

## Development

Nothing to build: `plugin.js` is the shipped module, and Node runs the tests.

```bash
npm test
```

| Test | Covers |
| --- | --- |
| `test-oauth.mjs` | PKCE, the auth URL, the pasted redirect, token bodies, Calendar mapping, the upcoming window |
| `test-vault.mjs` | the JSON vault over the credential store |
| `check.mjs` | manifest rules from `block/buzz-app`, naming and origin hygiene, an `apply()` smoke test |

Written against `block/buzz-app` (Buzz 1.0, plugin API v1). Sources are named in `NOTES.md`.
