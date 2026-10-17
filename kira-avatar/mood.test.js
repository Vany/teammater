import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { emotionOf, createMood, TAG_FRAME } from "./mood.js";

test("every mapped frame exists as a file", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "frames");
  const files = new Set(readdirSync(dir));
  for (const f of new Set(Object.values(TAG_FRAME))) assert.ok(files.has(`${f}.webp`), `${f}.webp missing`);
});

test("emotionOf: first tag with a frame wins, case-insensitive; unknown tags are ignored", () => {
  assert.equal(emotionOf("[calm] [Happy] hi [sad]"), "happy");
  assert.equal(emotionOf("[thinking] hmm"), "thoughtful");
  assert.equal(emotionOf("[whispers] psst"), null);
  assert.equal(emotionOf("no tags"), null);
  assert.equal(emotionOf(undefined), null);
});

test("speaking shows the emotion, then it holds 3 s after the last loud moment", () => {
  const m = createMood();
  assert.equal(m.frame(0, true), "talk");
  m.emotion("happy", 1000);
  assert.equal(m.frame(1000, true), "happy");
  assert.equal(m.frame(9000, true), "happy"); // a long clip
  assert.equal(m.frame(11_999, false), "happy");
  assert.equal(m.frame(12_000, false), "idle");
  assert.equal(m.frame(12_001, true), "talk"); // emotion is per clip
});

test("an emotion with no audio (browser voice) still shows for 4 s", () => {
  const m = createMood();
  m.emotion("pouty", 0);
  assert.equal(m.frame(3999, false), "pouty");
  assert.equal(m.frame(4000, false), "idle");
});

test("after 5 min of quiet she yawns for 3.5 s, then every 1–3 min; speaking wakes her", () => {
  const m = createMood({ random: () => 0.5 }); // gap = 60 s + 0.5 * 120 s = 120 s
  assert.equal(m.frame(299_999, false), "idle");
  assert.equal(m.frame(300_000, false), "sleepy");
  assert.equal(m.frame(303_499, false), "sleepy");
  assert.equal(m.frame(303_500, false), "idle");
  assert.equal(m.frame(419_999, false), "idle");
  assert.equal(m.frame(420_000, false), "sleepy");
  assert.equal(m.frame(421_000, true), "talk");
  assert.equal(m.frame(421_001, false), "idle"); // woken: the yawn is cut short
  assert.equal(m.frame(721_000, false), "sleepy"); // 5 min after the last voice
});
