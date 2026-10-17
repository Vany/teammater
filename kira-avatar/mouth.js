/**
 * Kira's mouth from loudness alone (vany 2026-10-17: no phonemes yet) — pure, node-tested.
 */

/**
 * Speaking while the level is above `threshold`, and for `holdMs` after it drops: the gaps
 * between words are shorter than that, so the mouth doesn't flap on every syllable.
 * Returns (level, now) → boolean.
 */
export function createMouth({ threshold = 0.02, holdMs = 200 } = {}) {
  let lastLoud = -Infinity;
  return (level, now) => {
    if (level > threshold) lastLoud = now;
    return now - lastLoud < holdMs;
  };
}

/**
 * How far to bounce for a level, 0…1: 0 at the threshold, 1 at loud speech (+0.25 above it).
 * The caller turns it into scale and lift.
 */
export function bounce(level, threshold = 0.02) {
  return Math.min(1, Math.max(0, (level - threshold) / 0.25));
}
