# glados-link — wire protocol (device side)

Teammater is a device on GLaDOS's hub (`wss://c.local:8095` by default). JSON text frames.
Handshake (unchanged since 2026-10-10): `hello` → `challenge` → `auth` → `ready`; both
sides prove Ed25519 keys pinned at pairing. See the header of `module.js`.

## auth
`{t:"auth", sig, commands:[{name:"say"},{name:"sound"},{name:"voices"},{name:"ping"}], events:[{name:"chat"},{name:"error"}]}`

## Commands (hub → device) and results
`{t:"cmd", cid, name, args}` → `{t:"result", cid, ok:true, value}` | `{t:"result", cid, ok:false, error}`

| name | args | value |
|---|---|---|
| say (voice) | `audio`: base64, `mime`: `audio/ogg` \| `audio/wav` \| any `audio/*`, `text?` (log only) | `"playing"`, once this clip starts |
| say (text) | `text` with `[emotion]` tags, `voice?`, `lang?` | `"spoken"` (browser voice, fallback) |
| sound | `name` (mp3 in `mp3/`) | `"played"` |
| voices | — | `[{name, lang}]` browser voices |
| ping | — | `"pong"` |

`say` with `audio` wins over `text`. Clips are queued: they never overlap, so the result for
a clip arrives only after the clips before it finish. Hub timeouts must allow for that.

## Events (device → hub)
`{t:"event", name, data}`. Sent only while the link is up; nothing is buffered.

- `chat`: `{id, user, display, text, ts, badges}`: one per Twitch chat line, including
  echowire voice commands injected into chat. `user` is the lowercase login, `ts` is ms epoch
  (Twitch `tmi-sent-ts`), and `badges` lists names only (`["broadcaster","subscriber"]`).
- `error`: `{cmd:"say", cid, reason, message}`: the browser couldn't play.
  `reason`: `autoplay` (no user gesture on the page yet: click it once), `decode`
  (bad base64, non-audio mime, or undecodable data), `playback` (failed mid-clip, or a
  speech error). A failure before playback starts also fails the command's result. A failure
  after the start comes only as this event, because the result was already sent.

A certificate that isn't accepted, or a hub that is down, breaks the link itself, so it can't
arrive as an event. It shows in teammater's status line, and the module retries every
`reconnect_delay`.

## Voice level → overlay (/obs bus, not the hub)
While a `say` clip plays, the module sends `{type:"kira_level", level}` on the /obs bus every 50 ms.
`level` is the RMS of the samples (0 = silence; speech is roughly 0.05–0.3), and the last
message of each clip is `0`. `kira-avatar/` turns it into the speaking frame and bounce.
If the page has had no user gesture yet, the AudioContext is suspended. The clip then plays
unmeasured, because routing it through a suspended graph would mute it, and the avatar stays idle.
The browser-voice fallback can't be measured and doesn't move the avatar.

## Status (teammater UI)
A line under the module header, mirrored in the control panel: 🟢/🔴 link, last event
(`←` from the hub, `→` to it, name, time), last error.
