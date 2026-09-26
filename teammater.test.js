/**
 * Tests for the two pure, DOM-free functions in the MusicBridge UserScript —
 * run with `node --test` (or `make test` from the repo root).
 *
 * teammater.js is a Tampermonkey script: one IIFE, GM_* globals, no exports,
 * and it must stay that way to be installable. So these tests EXTRACT the two
 * functions from the real source text and evaluate them in isolation. That is
 * deliberately not a copy of the logic — a copy would pass forever while the
 * shipped file rotted. If the extraction stops matching, these tests fail
 * loudly, which is the correct signal to come and look.
 *
 * Why these two are worth pinning: `lore-ok[db5df4c7]` in the source records
 * that MUSIC_RE shipped with no word boundaries, so 'ost' matched inside
 * "most" and 'ep' inside "episode" — the category gate passed essentially every
 * video, and nothing failed until non-music played on stream.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "teammater.js"),
  "utf8",
);

/** Pull `function name(...) { ... }` out of the source by brace matching. */
function extractFunction(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found in teammater.js`);
  let depth = 0;
  let i = SRC.indexOf("{", start);
  const bodyStart = i;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  assert.ok(i < SRC.length, `unbalanced braces extracting ${name}`);
  const src = SRC.slice(start, i + 1);
  // eslint-disable-next-line no-new-func
  return new Function(`${src}; return ${name};`)();
}

const cleanYoutubeUrl = extractFunction("cleanYoutubeUrl");

/** Pull the `const MUSIC_RE = new RegExp( ... );` expression out and build it. */
function extractMusicRe() {
  const start = SRC.indexOf("const MUSIC_RE = new RegExp(");
  assert.notEqual(start, -1, "MUSIC_RE not found in teammater.js");
  let depth = 0;
  let i = SRC.indexOf("(", start);
  for (; i < SRC.length; i++) {
    if (SRC[i] === "(") depth++;
    else if (SRC[i] === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  assert.ok(i < SRC.length, "unbalanced parens extracting MUSIC_RE");
  const expr = SRC.slice(start + "const MUSIC_RE = ".length, i + 1);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${expr};`)();
}

const MUSIC_RE = extractMusicRe();

/** Distinct keyword count, mirroring how looksLikeMusic scores a video. */
const distinctHits = (text) =>
  new Set((text.match(new RegExp(MUSIC_RE.source, "gi")) || []).map((m) => m.toLowerCase())).size;

// ── cleanYoutubeUrl ─────────────────────────────────────────────────────
//
// Its job is to strip everything except v= and t=, because a leftover `list=`
// makes YouTube autoadvance into a playlist and the queue loses control.

test("keeps only v and drops playlist params", () => {
  const out = cleanYoutubeUrl("https://www.youtube.com/watch?v=abc123&list=PL9&index=4");
  assert.equal(out, "https://www.youtube.com/watch?v=abc123");
});

test("preserves a t= timestamp", () => {
  const out = cleanYoutubeUrl("https://www.youtube.com/watch?v=abc123&t=42s&list=PL9");
  assert.ok(out.includes("v=abc123"));
  assert.ok(out.includes("t=42s"));
  assert.ok(!out.includes("list"));
});

test("normalises the youtu.be short form", () => {
  assert.equal(
    cleanYoutubeUrl("https://youtu.be/abc123?si=trackingjunk"),
    "https://www.youtube.com/watch?v=abc123",
  );
});

test("strips tracking params that trigger autoadvance", () => {
  const out = cleanYoutubeUrl("https://www.youtube.com/watch?v=xyz&pp=ygU&ab_channel=Some");
  assert.equal(out, "https://www.youtube.com/watch?v=xyz");
});

test("returns the input unchanged when it is not a URL", () => {
  assert.equal(cleanYoutubeUrl("not a url"), "not a url");
});

// ── MUSIC_RE ────────────────────────────────────────────────────────────

test("word boundaries hold: no matching inside ordinary words", () => {
  // The exact regression lore-ok[db5df4c7] records. Unbounded, 'ost' matched
  // "most", 'ep' matched "episode", 'hit' matched "white" — two hits from a
  // sentence containing no music keyword at all, and the gate passed anything.
  assert.equal(distinctHits("Most epic episode of a white van build"), 0);
});

test("still matches real keywords as whole words", () => {
  assert.ok(MUSIC_RE.test("Official Video"));
  assert.ok(MUSIC_RE.test("a live concert recording"));
  assert.ok(MUSIC_RE.test("OST from the film"));
});

test("multi-word phrases count as ONE keyword, not two", () => {
  // Longest-first sorting is what makes this true; without it 'official' would
  // shadow 'official video' and a single phrase would score two distinct hits,
  // clearing the two-keyword bar on its own.
  assert.equal(distinctHits("Official Video"), 1);
});

test("two genuinely different signals are needed to pass the gate", () => {
  assert.ok(distinctHits("Official Video") < 2);
  assert.ok(distinctHits("Official Video — live acoustic cover") >= 2);
});

test("punctuation-ending entries are matchable", () => {
  // 'feat.' and 'ft.' end in punctuation, where a trailing \b would demand a
  // following word character and never match.
  assert.ok(MUSIC_RE.test("Artist feat. Someone"));
  assert.ok(MUSIC_RE.test("Artist ft. Someone"));
});

test("a plainly non-music upload scores nothing", () => {
  assert.equal(distinctHits("How to replace a kitchen tap in 10 minutes"), 0);
});

// ── isYandexTrack vs the request validator ──────────────────────────────
//
// The validator (actions.js YANDEX_RE) decides whether a music request is
// ACCEPTED; isYandexTrack decides whether the Yandex tab tries to PLAY it. They
// used to disagree on bare `/track/N` links: accepted, points spent, the tab
// navigated, and autoPlay fell through to "no autoplay" — silent, every time.
// Both regexes are read from the real source files, so neither can drift
// without this failing.

const isYandexTrack = extractFunction("isYandexTrack");

const YANDEX_RE = (() => {
  const actions = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "actions.js"),
    "utf8",
  );
  const m = actions.match(/const YANDEX_RE = (\/.+\/[a-z]*);/);
  assert.ok(m, "YANDEX_RE not found in actions.js");
  // eslint-disable-next-line no-new-func
  return new Function(`return ${m[1]};`)();
})();

const SAMPLES = [
  "https://music.yandex.ru/album/15848141/track/83943930",
  "https://music.yandex.ru/album/15848141/track/83943930?utm_source=web&utm_medium=copy_link",
  "https://music.yandex.ru/track/83943930",
  "https://music.yandex.com/album/15848141/track/83943930",
  "https://music.yandex.ru/album/15848141",
  "https://music.yandex.ru/",
  "https://music.yandex.ru/artist/123",
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
];

test("the tab plays exactly what the validator accepts", () => {
  for (const url of SAMPLES) {
    assert.equal(isYandexTrack(url), YANDEX_RE.test(url), `disagreement on ${url}`);
  }
});

test("bare /track/N links are treated as tracks", () => {
  assert.equal(isYandexTrack("https://music.yandex.ru/track/83943930"), true);
});

test("album pages and My Vibes are not tracks", () => {
  assert.equal(isYandexTrack("https://music.yandex.ru/album/15848141"), false);
  assert.equal(isYandexTrack("https://music.yandex.ru/"), false);
});
