# Music Queue Module — Specification

## Purpose

Manage a viewer-driven song queue for streams.
Supports Yandex Music and YouTube. Viewers request songs via Twitch channel point
rewards; the module controls browser tabs through the **MusicBridge** Tampermonkey UserScript (`teammater.js`).

## Components

| File | Role |
|------|------|
| `modules/music-queue/module.js` | Queue logic, state, cross-tab dispatch, OBS broadcast |
| `teammater.js` (root) | **MusicBridge** UserScript — MASTER tab + Yandex CLIENT + YouTube CLIENT |
| `actions.js` — `music()`, `vote_skip()`, `playing()` | Twitch reward handlers |
| `config.js` — `getDefaultRewards()` | Reward definitions with costs and prompts |
| `obs.html` / `obs.js` | OBS overlay — heart rate + now-playing widget |

---

## Cross-Tab Communication Protocol

MusicBridge bridges tabs via `GM_setValue` / `GM_addValueChangeListener`.
All messages carry a `target` field for routing.

### Message envelope

```js
{ target: "yandex" | "youtube" | "master" | "all", command: string, payload: any }
```

Each tab ignores messages where `target` does not match its type (or `"all"`).

### Tab roles

| Tab | URL pattern | Role | `window` flag |
|-----|-------------|------|---------------|
| MASTER | `localhost:8443/**` | Sends commands, receives replies, manages tab handles | `i_am_a_master = true` |
| Yandex CLIENT | `music.yandex.ru/**` | Handles Yandex commands, fires replies | — |
| YouTube CLIENT | `youtube.com/**` | Handles YouTube commands, fires replies | `sessionStorage.yt_player === "1"` |

YouTube player role persists across navigations via `sessionStorage.yt_player`,
which is per-TAB and survives the full page load that the `song` command's own
`window.location =` assignment causes. (This was documented long before it was
true, along with a `window.i_am_youtube_player` flag that never existed. Until
2026-09-01 the only marker was the one-shot GM flag below, consumed on first
load — so every navigation after the first demoted the player to an observer
that answered nothing and stalled the master until its 65s watchdog.)

A new tab is designated via `GM_setValue("yt_next_is_player", {videoId, at})`
before `GM_openInTab`. The claim names the video it was opened FOR, and a
loading tab only takes it when the id matches its own `?v=`: the flag is GM
storage, shared across every tab, so a bare `true` could be claimed by any
youtube.com page that happened to load next — including one the streamer opened
themselves, which would then drive the queue while `closeYoutubePlayer()` closed
the innocent tab.

### API exposed on `unsafeWindow` (MASTER tab)

```js
sendCommandToOtherTabs(command, payload, target = "all")
registerReplyListener(name, callback)
openYoutubePlayer(url)   // GM_openInTab(url, {active:true}); stores tab handle
closeYoutubePlayer()     // closes the stored GM tab handle
```

### Commands: MASTER → Yandex CLIENT (`target: "yandex"`)

| Command | Payload | Effect |
|---------|---------|--------|
| `song` | URL string | Navigate to URL (or resume if already there) |
| `pause` | — | `audio.pause()` + hold via 200ms interval + mute |
| `resume` | — | Clear pause interval, unmute, `audio.play()` |
| `next` | — | Click "Next song" button |
| `query_status` | — | Reply with `status_reply` |
| `ping` | — | Reply with `pong` |

**Yandex pause implementation**: uses a 200ms interval to re-pause and mute, fighting Yandex React's internal state machine. Audio element is captured at first `play()` call and stored; pause requests before audio exists are queued as `_pausePending`.

### Commands: MASTER → YouTube CLIENT (`target: "youtube"`)

| Command | Payload | Effect |
|---------|---------|--------|
| `song` | URL string | Navigate to clean URL (v= and t= only), then validate + play |
| `pause` | — | `video.pause()` |
| `resume` | — | `video.play()` |
| `query_status` | — | Reply with `status_reply` |
| `ping` | — | Reply with `pong` |

YouTube URL cleaning: strip all query params except `v=` and `t=` to prevent playlist autoadvance.

### Reply events: CLIENT → MASTER (`target: "master"`)

**Payloads are OBJECTS keyed `artist`, not `author`, and `music_start` is not a
string.** This table said `"title\nauthor"` and `{title, author, ...}` until
2026-09-01; the consumer (`module.js`, `info.title ?? ""` / `info.artist ?? ""`)
reads neither, so a sender built to the old spec produced a blank now-playing on
the overlay and the mobile remote with nothing logged anywhere.

| Event | Payload | Source | When |
|-------|---------|--------|------|
| `music_start` | `{title, artist, version, cover, coverFallback, source, url}` | Yandex | Audio `play` fires |
| `music_done` | clean URL | Yandex | Audio `ended` fires |
| `youtube_ready` | `{title, artist, duration, url, ...}` | YouTube | Validated OK, play started |
| `youtube_invalid` | `{url, reason}` | YouTube | Validation failed |
| `music_done` | clean URL | YouTube | Video `ended` fires; MASTER then calls `closeYoutubePlayer()` |
| `status_reply` | `{type?, playing, currentTime, duration, trackInfo, url}` | Either | Response to `query_status` |
| `pong` | `{type: "yandex"\|"youtube"}` | Either | Response to `ping` |

`status_reply` from YouTube includes `type: "youtube"` — used by MASTER to detect a live YouTube tab on reconnect and restore `_ytPlayerActive`.

---

## YouTube Tab Lifecycle

```
openYoutubePlayer(url)
  → closes previous _ytTab if any
  → sets GM flag yt_next_is_player=true
  → GM_openInTab(url, {active: true})  ← opens in foreground (required for autoplay)
  → stores tab handle in _ytTab

music_done received from YouTube
  → closeYoutubePlayer()  ← MASTER closes _ytTab via GM handle
  → _ytPlayerActive = false
  → _playNext()
```

Every YouTube song opens a fresh tab and closes it when done. No tab reuse.

---

## YouTube Validation

Performed inside the YouTube CLIENT tab after navigation, by reading page globals.
Runs before clicking play. If validation fails, sends `youtube_invalid` and does NOT play.

| Check | Source | Condition |
|-------|--------|-----------|
| Category | `ytInitialPlayerResponse.microformat.playerMicroformatRenderer.category` | `=== "Music"`, **or** `looksLikeMusic()` fallback |
| View count | `ytInitialPlayerResponse.videoDetails.viewCount` | `> 1000` |
| Duration | `ytInitialPlayerResponse.videoDetails.lengthSeconds` | `120–480 s` (2–8 min) |

`waitForYtReady()` polls until `ytInitialPlayerResponse`, `<video>`, and `#movie_player` are all present (10s timeout).
Play is started via `player.playVideo()` (YouTube internal API), falling back to `video.play()` then button click.

On invalid: MASTER logs error, skips to next in queue.

---

## Auto-play After Navigation

`song` command causes a full page reload in the CLIENT tab. UserScript re-initializes:

- **Yandex track URL** (`/album/N/track/N`): `hookYandexAudio()` + click play after 4s
- **Yandex root URL** (`music.yandex.ru/`): `hookYandexAudio()` + click "Play My Vibe" after 4s
- **YouTube watch URL**: `setupYoutubePlayer()` — wait for globals, validate, `player.playVideo()`

---

## Queue Behavior

### Base state (queue empty)
Navigate Yandex tab to `https://music.yandex.ru/` → UserScript clicks "Play My Vibe".
`currentlyPlaying = emptyUrl`.

### New song requested (`smartAdd(url)`)
- `currentlyPlaying === null || currentlyPlaying === emptyUrl` → **play immediately** via `_playSong(url)`
- Otherwise → **push to queue** (FIFO, `PersistentDeck.push`), broadcast updated queue size to OBS

### Song ends (`music_done`)
- Ignored if `currentlyPlaying === emptyUrl || null` (My Vibes track endings)
- YouTube: MASTER closes the tab via `closeYoutubePlayer()`
- `_ytPlayerActive = false`, then `_playNext()`

### Skip
- **Immediate** (`skip()`): stops watchdog → `_playNext()` or My Vibes
  - If YouTube was playing: send `pause` to YouTube, clear `_ytPlayerActive`
  - If queue empty: send `next` to Yandex (advance its playlist), stay on My Vibes mode
- **Vote skip** (`voteSkip()`): decrement counter, skip when reaches 0; resets from config after each skip

---

## YouTube Routing (`_playSong(url)`)

```
if YouTube URL:
  send pause → yandex
  openYoutubePlayer(url)   // always opens new tab (closed on done)
else (Yandex URL):
  if _ytPlayerActive: send pause → youtube; _ytPlayerActive = false
  send song → yandex
```

`_ytPlayerActive` is set `true` in `youtube_ready` listener, `false` in `music_done`, `youtube_invalid`, `skip()`.

---

## Watchdog

Runs while a **queued** song is playing (not My Vibes):
- Started: in `_playNext()` for Yandex; in `youtube_ready` listener for YouTube
- Every 60s: send `ping` to active tab type
- 5s timeout: if no `pong` → assume tab dead → `_ytPlayerActive = false` → `_playNext()`
- Stopped: on `music_done`, `youtube_invalid`, `skip()`, `_playNext()`, `doDisconnect()`

Watchdog does not run when playing My Vibes (fallback, not queued content).

---

## OBS Now-Playing Widget

Module opens its own WebSocket to `/obs` (same broadcast bus as heart rate).

Broadcasts on **every** `music_start` / `youtube_ready`. The message is FLAT and
carries `type` — every consumer dispatches on `msg.type` (`mobile.html`'s
`case 'now_playing':`, `obs.js`'s `msg.type === 'now_playing'`), so the nested
`{ "now_playing": {...} }` shape this file used to document would be silently
ignored by all of them. Root `SPEC.md`'s bus-protocol section is authoritative
and already had it right:
```json
{ "type": "now_playing", "title": "Track Title", "artist": "Artist Name",
  "version": "", "cover": "https://...", "coverFallback": null,
  "source": "", "url": "", "queue_size": 3, "paused": false }
```

Also broadcasts after `smartAdd` (queue size update) and `clear()`.

On connect, `obs.html` sends `{"request": "now_playing"}` to `/obs`.
The module receives this and immediately replies with the current song.

`obs.html` / `obs.js` displays:
- Artist name, Track title
- Queue size (`N in queue`; always shown including `0 in queue`)
- Hidden until first message received

---

## Chat Notifications

- `music_start` does **not** post to Twitch chat — for any song (queued or My Vibes)
- **Only** the `playing` reward (viewer redeems) posts current song to chat

---

## State

| Field | Type | Description |
|-------|------|-------------|
| `queue` | `PersistentDeck` | LocalStorage-backed FIFO of queued URLs (Yandex or YouTube) |
| `currentlyPlaying` | `string \| null` | Active URL; `null` on init; `emptyUrl` when My Vibes |
| `nowPlaying` | `{title, artist}` | Last known track (from `music_start` or `youtube_ready`) |
| `needVoteSkip` | `number` | Votes remaining to skip; resets from config on each skip |
| `_ytPlayerActive` | `boolean` | True while a YouTube tab is open (cleared on tab close) |
| `_watchdogTimer` | `interval \| null` | Watchdog interval handle |

---

## Twitch Rewards

| Reward key | Cost | Prompt | Action |
|------------|------|--------|--------|
| `music` | 150 pts | "Yandex Music or YouTube track URL" | Validates URL, calls `smartAdd()` |
| `vote_skip` | 30 pts | — | Cast a skip vote |
| `playing` | 30 pts | — | Post current song to chat |

### URL validation (actions.js)

**Yandex Music**: `/^https:\/\/music\.yandex\.(ru|com)\/(album\/\d+\/)?track\/\d+/`
Normalized: `.com` → `.ru`

**YouTube**: `/^https:\/\/(www\.)?youtube\.com\/watch\?.*v=[\w-]+/`
Deep validation (category, views, duration) runs in the YouTube tab after navigation.

---

## LLM Tool

`next_song` — AI can suggest skipping; calls `vote_skip()` internally.

---

## Config Schema

| Key | Default | Description |
|-----|---------|-------------|
| `empty_url` | `https://music.yandex.ru/` | My Vibes fallback URL |
| `vote_skip_threshold` | `3` | Votes needed to skip |
| `initial_song_name` | `"Silence by silencer"` | Placeholder before first track event |
| `persistence_key` | `"toplay"` | LocalStorage key for `PersistentDeck` |

---

## Known Limitations

- `music_done` fires only on audio/video `ended` — if user manually navigates the tab, `currentlyPlaying` stays stale until the watchdog fires (up to 65s)
- If YouTube tab is closed mid-song by the user, watchdog recovers within 65s
- No per-user request cooldown or deduplication
- YouTube validation requires page load; invalid songs cause a brief tab navigation before rejection
- YouTube category `"Music"` passes outright. Anything else falls back to
  `looksLikeMusic()`: ≥2 DISTINCT keywords from a ~90-entry list matched against
  title + description + tags, each anchored with `\b`. The boundaries matter —
  unanchored, `ost` matched inside "most" and `ep` inside "episode", so the gate
  passed almost everything. Multi-word entries are tried longest-first, so
  "Official Video" counts as ONE keyword, not two; a non-Music upload therefore
  needs two genuinely different signals. Covers and unofficial uploads can still
  fail if their metadata is sparse.
