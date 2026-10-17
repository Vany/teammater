/**
 * Loudness of Kira's voice clips, measured where they play — feeds the PNG-tuber overlay
 * (kira-avatar/) over the /obs bus. vany 2026-10-17: "mouth = loudness, no phonemes yet".
 */

/** Root-mean-square of one block of samples in [-1, 1]: 0 is silence, speech is ~0.05–0.3. */
export function rms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return buf.length ? Math.sqrt(sum / buf.length) : 0;
}

/**
 * Route `el` through an AnalyserNode on `ctx` and report its level every `everyMs`.
 * A timer, not requestAnimationFrame: rAF stops in a hidden tab, and teammater's tab is
 * usually hidden behind OBS, while an audible tab's timers are not throttled.
 * Returns stop(), which reports a final 0 so the avatar never sticks mid-word.
 * The caller must pass a RUNNING context: a suspended one would silence the clip.
 */
export function meter(ctx, el, onLevel, everyMs = 50) {
  const src = ctx.createMediaElementSource(el);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  analyser.connect(ctx.destination);
  const buf = new Float32Array(analyser.fftSize);
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    onLevel(Math.round(rms(buf) * 1000) / 1000);
  }, everyMs);
  return () => {
    clearInterval(timer);
    src.disconnect();
    analyser.disconnect();
    onLevel(0);
  };
}
