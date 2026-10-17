# PLAN — GLaDOS link for Kira (2026-10-17)

Brief: ~/kira/briefs/teammater-glados-link.md. Branch `kira/glados-link-2` off master
(the old `glados-link` was already merged as PR #4). Vany merges.

Wire protocol unchanged (hello/challenge/auth/ready, cmd/result). Additions use the
slots the handshake already has: `auth.events` (was `[]`) and `say` args.

1. **Chat → Kira.** On connect, register a twitch-chat message handler; each line is sent as
   `{t:"event", name:"chat", data:{id, user, display, text, ts, badges}}`.
   `auth.events = [{name:"chat"}, {name:"error"}]`. Handler unregistered on disconnect.
   Kira-side IRC reader removal is outside this repo.
2. **say plays hub audio.** `say {audio: base64, mime: "audio/ogg"|"audio/wav", text?}` →
   played through an `<audio>` element, clips queued (never overlap). Result returns once
   playback starts. On failure: result `ok:false` + event `error {cmd, cid, reason, message}`,
   reason ∈ `autoplay` (no user gesture yet), `decode` (unsupported/corrupt), `playback`.
   No audio → text goes to the browser voice (kept fallback). Dead `tts_url` path removed
   (`/api/tts` never existed). Certificate problems break the link itself, so they can't
   travel as an event — they show in the UI status instead.
3. **Status in UI.** Always-visible line under the module header: 🟢/🔴 link, last event
   (direction, name, time), last error. The control panel's Link row goes live (it was
   frozen at render time).
4. Docs: `modules/glados-link/SPEC.md` (wire messages, for the hub side), MEMO.md, TODO.md.
   Check: existing tests pass; manual run against the hub if Kira/Vany can trigger commands.
