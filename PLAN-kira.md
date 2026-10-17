# PLAN — Kira PNG-tuber overlay (2026-10-17)

Brief: ~/kira/briefs/teammater-pngtuber.md. Branch `kira/pngtuber` off master. Vany merges.
No server change: the /obs bus already relays unknown message types (bus.rs `_ =>` arm),
so nothing needs a restart. Pages reload live.
(MemeAlerts plan is parked on branch `kira/memealerts`.)

1. **Measure where the audio plays (index.html, glados-link).** `_play()` routes the clip's
   `<audio>` through one shared AudioContext: MediaElementSource → AnalyserNode → destination.
   Every 50 ms while it plays, it sends the RMS level as `{type:"kira_level", level}` on the
   bus, and `level:0` when the clip ends. It uses a timer, not rAF: rAF stops in a hidden tab,
   while an audible tab's timers are not throttled.
   If the AudioContext can't run (no user gesture yet), the clip plays directly, without
   analysis. A suspended graph would silence the clip, and silence is worse than a still avatar.
2. **Overlay page `kira.html` + `kira.js`.** It's a separate OBS browser source, so position
   and size are set in OBS like any source, and the background is transparent. It shows the idle
   frame. While the level is above the threshold it shows the speaking frame plus a scale and
   lift that follow the level. After 200 ms of quiet it goes back to idle.
   URL params: `threshold` (default 0.02), `shape=circle|card` (default circle).
   It doesn't touch `obs.html`/`obs.js`: that overlay is live, so its bus client is copied
   (~30 lines) rather than refactored now.
3. **Assets.** `kira-warm.png` (idle) and `kira-grin.png` (speaking) are downscaled to 512 px
   JPEG in `assets/kira/`. The sources are 3 MB RGB with a room background and no alpha, so
   the avatar is a framed portrait (circle crop on the face), not a cut-out. The two frames
   are posed differently; per-frame crop offsets line the faces up.
4. Tests for the pure parts (RMS, speaking state machine); docs in MEMO/TODO.
   Later, not now: VRM via three-vrm.
