/**
 * Tests for utils.js — run with `node --test` (or `make test`).
 *
 * Uses only `node:test` + `node:assert`, so this stays true to the repo's
 * zero-dependency, no-build-step rule (see the lore-ok[704edc91] note in
 * README.md about there deliberately being no package.json).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { detectLanguage, pickVoice } from "./utils.js";

/** Minimal stand-in for a SpeechSynthesisVoice. */
const V = (name, lang) => ({ name, lang });

/** Install a voice list for the duration of one call. */
const withVoices = (voices, fn) => {
  globalThis.speechSynthesis = { getVoices: () => voices };
  try {
    return fn();
  } finally {
    delete globalThis.speechSynthesis;
  }
};

// ── detectLanguage ──────────────────────────────────────────────────────

test("detectLanguage routes by dominant script", () => {
  assert.equal(detectLanguage("Привет мир"), "ru");
  assert.equal(detectLanguage("Hello world"), "en");
  assert.equal(detectLanguage("123 !@#"), "unknown");
});

test("detectLanguage picks the majority script in mixed text", () => {
  assert.equal(detectLanguage("Привет world"), "ru"); // 6 cyrillic vs 5 latin
  assert.equal(detectLanguage("Hi мир"), "ru"); //       2 latin    vs 3 cyrillic
  assert.equal(detectLanguage("ab бв"), "unknown"); //   a tie is neither
});

// ── pickVoice ───────────────────────────────────────────────────────────
//
// The bug this guards: an exact `v.lang === "ru-RU"` match found nothing when
// the installed voice was tagged "ru" or "ru_RU", and a missing voice used to
// mean the utterance was spoken in English.

test("pickVoice matches Chrome-style region tags", () => {
  const voices = [V("Google US English", "en-US"), V("Google русский", "ru-RU")];
  assert.equal(withVoices(voices, () => pickVoice("ru-RU")).name, "Google русский");
  assert.equal(withVoices(voices, () => pickVoice("en-US")).name, "Google US English");
});

test("pickVoice matches the underscore separator form", () => {
  const voices = [V("Alex", "en_US"), V("Milena", "ru_RU")];
  assert.equal(withVoices(voices, () => pickVoice("ru-RU")).name, "Milena");
});

test("pickVoice matches region-less tags", () => {
  const voices = [V("English", "en"), V("Russian", "ru")];
  assert.equal(withVoices(voices, () => pickVoice("ru-RU")).name, "Russian");
});

test("pickVoice prefers an exact region over a same-language sibling", () => {
  const voices = [V("Portuguese BR", "pt-BR"), V("Portuguese PT", "pt-PT")];
  assert.equal(withVoices(voices, () => pickVoice("pt-PT")).name, "Portuguese PT");
});

test("pickVoice returns null rather than a wrong-language voice", () => {
  // Callers must treat null as "let the engine choose from utterance.lang",
  // NOT as a reason to fall back to whatever voice happens to be first.
  assert.equal(withVoices([V("Alex", "en-US")], () => pickVoice("ru-RU")), null);
});

test("pickVoice returns null when the voice list has not loaded yet", () => {
  // getVoices() is empty until the engine fires `voiceschanged`, which is well
  // after page load — every early utterance takes this path.
  assert.equal(withVoices([], () => pickVoice("ru-RU")), null);
});

test("pickVoice honours a name hint inside the language", () => {
  const voices = [V("Yuri male", "ru-RU"), V("Milena female", "ru-RU"), V("Daniel male", "en-GB")];
  assert.equal(withVoices(voices, () => pickVoice("ru-RU", "male")).name, "Yuri male");
});

test("pickVoice falls back within the language when the hint misses", () => {
  const voices = [V("Yuri male", "ru-RU"), V("Milena female", "ru-RU")];
  assert.equal(withVoices(voices, () => pickVoice("ru-RU", "robot")).name, "Yuri male");
});

test("pickVoice never lets a name hint cross into another language", () => {
  const voices = [V("Milena female", "ru-RU"), V("Daniel male", "en-GB")];
  assert.equal(withVoices(voices, () => pickVoice("en-GB", "female")).name, "Daniel male");
});
