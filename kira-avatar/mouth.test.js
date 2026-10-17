import { test } from "node:test";
import assert from "node:assert/strict";
import { createMouth, bounce } from "./mouth.js";
import { rms } from "../modules/glados-link/level-meter.js";

test("mouth opens above the threshold and holds 200 ms after quiet", () => {
  const mouth = createMouth({ threshold: 0.02, holdMs: 200 });
  assert.equal(mouth(0, 0), false);
  assert.equal(mouth(0.1, 100), true);
  assert.equal(mouth(0.01, 250), true); // a gap between words
  assert.equal(mouth(0, 299), true);
  assert.equal(mouth(0, 300), false);
});

test("bounce is 0 at the threshold and saturates at 1", () => {
  assert.equal(bounce(0.02), 0);
  assert.equal(bounce(0), 0);
  assert.equal(bounce(0.27), 1);
  assert.equal(bounce(5), 1);
  assert.ok(bounce(0.1) > 0 && bounce(0.1) < 1);
});

test("rms of silence, a full-scale square wave, and an empty block", () => {
  assert.equal(rms(new Float32Array(64)), 0);
  assert.equal(rms(Float32Array.from({ length: 64 }, (_, i) => (i % 2 ? 1 : -1))), 1);
  assert.equal(rms(new Float32Array(0)), 0);
});
