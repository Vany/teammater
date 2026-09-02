/**
 * Tests for BaseModule's config coercion helpers — run with `node --test`
 * (or `make test` from the repo root).
 *
 * These three exist because localStorage only stores STRINGS, and every one of
 * them was added after the untyped read had already shipped a bug:
 *
 *   getConfigInt/Float — a cleared number input stores "" (it is not removed),
 *     so parseInt gives NaN. NaN then broke five different ways depending on
 *     where it flowed: setTimeout(fn, NaN) clamps to 0 and hammers a server,
 *     `n < 1` is always false so a threshold can never trigger, and
 *     JSON.stringify turns NaN into null inside an API body.
 *
 *   getConfigBool — an UNCHECKED checkbox comes back as the string "false",
 *     and `!"false"` is false. An off switch that reads as on. That shipped
 *     twice: the "Enable Echowire" toggle was a no-op for months, and
 *     index.html's announce hook broke the same way.
 *
 * The point of testing them is that they are the single chokepoint: every
 * module reads config through these, so one correct implementation replaces a
 * convention that each call site had to remember.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { BaseModule } from "./base-module.js";

/**
 * A BaseModule with the storage layer stubbed, so these tests exercise the
 * coercion rules and nothing else.
 */
const withConfig = (values) => {
  const m = Object.create(BaseModule.prototype);
  m.getConfigValue = (key, dflt) => (key in values ? values[key] : dflt);
  return m;
};

// ── getConfigBool ───────────────────────────────────────────────────────

test('the string "false" is false, not truthy', () => {
  // The whole reason this helper exists.
  assert.equal(withConfig({ flag: "false" }).getConfigBool("flag", true), false);
});

test('the string "true" is true', () => {
  assert.equal(withConfig({ flag: "true" }).getConfigBool("flag", false), true);
});

test("real booleans pass through unchanged", () => {
  assert.equal(withConfig({ flag: true }).getConfigBool("flag", false), true);
  assert.equal(withConfig({ flag: false }).getConfigBool("flag", true), false);
});

test("an unset field falls back to the default, either way round", () => {
  assert.equal(withConfig({}).getConfigBool("missing", true), true);
  assert.equal(withConfig({}).getConfigBool("missing", false), false);
});

test("an empty string falls back rather than reading as false", () => {
  // A field that was never written is not a field set to OFF — defaulting a
  // default-on toggle to off would silently disable it on first run.
  assert.equal(withConfig({ flag: "" }).getConfigBool("flag", true), true);
});

test("junk falls back to the default instead of guessing", () => {
  assert.equal(withConfig({ flag: "yes" }).getConfigBool("flag", false), false);
  assert.equal(withConfig({ flag: "1" }).getConfigBool("flag", true), true);
});

// ── getConfigInt / getConfigFloat ───────────────────────────────────────

test("numeric strings parse", () => {
  assert.equal(withConfig({ n: "42" }).getConfigInt("n", 7), 42);
  assert.equal(withConfig({ n: "0.5" }).getConfigFloat("n", 1), 0.5);
});

test("a cleared number input falls back instead of yielding NaN", () => {
  // localStorage holds "" for a cleared field — the exact shape that produced
  // zero-delay reconnect loops and never-triggering thresholds.
  assert.equal(withConfig({ n: "" }).getConfigInt("n", 5000), 5000);
  assert.equal(withConfig({ n: "" }).getConfigFloat("n", 0.7), 0.7);
});

test("non-numeric junk falls back", () => {
  assert.equal(withConfig({ n: "abc" }).getConfigInt("n", 30000), 30000);
  assert.equal(withConfig({ n: "abc" }).getConfigFloat("n", 0.7), 0.7);
});

test("zero is a real value, not a missing one", () => {
  // `|| default` would silently replace a deliberate 0 — e.g. a health-check
  // interval of 0, which means "disabled".
  assert.equal(withConfig({ n: "0" }).getConfigInt("n", 30000), 0);
  assert.equal(withConfig({ n: "0" }).getConfigFloat("n", 0.7), 0);
});
