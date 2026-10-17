/**
 * Which frame Kira shows: emotion tags from `say`, talking, and the idle yawn. Pure and
 * node-tested; avatar.js only renders what frame() returns.
 *
 * vany 2026-10-17 18:50Z: wire the emotion frames, triggered by [tags] in say's text; after
 * ~5 min with no say, show sleepy now and then (a yawn).
 */

/**
 * [tag] → frame (kira-avatar/frames/<frame>.webp). Includes vany's names (sleepy, happy,
 * thinking, surprised, sympathetic, playful, annoyed) and the emotion tags `say` already
 * carries for the browser-voice fallback (glados-link MOOD: sarcastic, sad, angry, …).
 * Tags with no fitting frame (calm, whispers, slowly, …) map to nothing, so the plain talk
 * frame is used.
 */
export const TAG_FRAME = {
  happy: "happy", excited: "happy", laughs: "happy", joyful: "happy",
  sleepy: "sleepy", tired: "sleepy", yawns: "sleepy", bored: "sleepy",
  thinking: "thoughtful", thoughtful: "thoughtful", curious: "thoughtful", hmm: "thoughtful",
  surprised: "surprised", shocked: "surprised", scared: "surprised", gasps: "surprised",
  sympathetic: "tender", tender: "tender", sad: "tender", soft: "tender",
  playful: "wink", wink: "wink", teasing: "wink", sarcastic: "wink",
  annoyed: "pouty", angry: "pouty", pouty: "pouty", grumpy: "pouty", deadpan: "pouty",
};

/** The first [tag] in `text` that has a frame, or null. Case-insensitive, like the TTS tags. */
export function emotionOf(text) {
  if (typeof text !== "string") return null;
  for (const m of text.matchAll(/\[([a-z ]+)\]/gi)) {
    const frame = TAG_FRAME[m[1].trim().toLowerCase()];
    if (frame) return frame;
  }
  return null;
}

/**
 * Frame state machine. Times are ms on one clock (performance.now() in the page).
 * - emotion(e, now): a clip with emotion e started. Shown for at least `minMs`, and for
 *   `holdMs` after the last loud moment, so it outlasts the clip a little.
 * - frame(now, speaking): speaking → emotion or "talk"; else a live emotion; else, after
 *   `sleepyAfterMs` with no voice, "sleepy" for `yawnMs` every `yawnGapMs` (random in range);
 *   else "idle". `speaking` also counts as activity, which wakes her and postpones yawns.
 * `random` is injectable so tests are deterministic.
 */
export function createMood({
  minMs = 4000,
  holdMs = 3000,
  sleepyAfterMs = 5 * 60_000,
  yawnMs = 3500,
  yawnGapMs = [60_000, 180_000],
  random = Math.random,
  now0 = 0,
} = {}) {
  let emotion = null;
  let emotionUntil = 0;
  let nextYawnAt = now0 + sleepyAfterMs;
  let yawnUntil = 0;

  const wake = (now) => {
    nextYawnAt = now + sleepyAfterMs;
    yawnUntil = 0;
  };

  return {
    emotion(e, now) {
      emotion = e;
      emotionUntil = now + minMs;
      wake(now);
    },
    frame(now, speaking) {
      if (speaking) {
        wake(now);
        if (emotion) emotionUntil = Math.max(emotionUntil, now + holdMs);
        return emotion ?? "talk";
      }
      if (emotion && now < emotionUntil) return emotion;
      emotion = null;
      if (now < yawnUntil) return "sleepy";
      if (now >= nextYawnAt) {
        yawnUntil = now + yawnMs;
        nextYawnAt = now + yawnGapMs[0] + random() * (yawnGapMs[1] - yawnGapMs[0]);
        return "sleepy";
      }
      return "idle";
    },
  };
}
