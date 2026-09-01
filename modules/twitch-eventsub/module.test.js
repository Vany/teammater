/**
 * Tests for the EventSub stale-subscription rule — run with `node --test`
 * (or `make test` from the repo root).
 *
 * Why this rule is worth pinning: Twitch answers a subscription that duplicates
 * an existing one (same type + condition) with `409 subscription already
 * exists`, and a WebSocket session's subscriptions are only *disabled* when its
 * socket dies — they keep the slot. Getting this filter wrong in either
 * direction is silent and expensive: too narrow and every reconnect fails on
 * all subscriptions at once, too wide and it deletes the session it is on.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { selectStaleSubscriptions } from "./module.js";

const CURRENT = "sess-current";

const ws = (id, sessionId) => ({
  id,
  type: "channel.raid",
  transport: { method: "websocket", session_id: sessionId },
});

const webhook = (id) => ({
  id,
  type: "channel.raid",
  transport: { method: "webhook", callback: "https://example.invalid/hook" },
});

const ids = (subs) => subs.map((s) => s.id);

test("keeps the session we are currently on", () => {
  assert.deepEqual(ids(selectStaleSubscriptions([ws("a", CURRENT)], CURRENT)), []);
});

test("selects a subscription from a dead session", () => {
  assert.deepEqual(ids(selectStaleSubscriptions([ws("a", "sess-old")], CURRENT)), ["a"]);
});

test("never selects a webhook subscription", () => {
  // Webhooks are not ours to reap: they outlive any WebSocket session and
  // deleting one would silently break an integration this module knows nothing about.
  assert.deepEqual(ids(selectStaleSubscriptions([webhook("w")], CURRENT)), []);
});

test("separates stale from live on a mixed page", () => {
  const page = [ws("a", CURRENT), ws("b", "old-1"), webhook("w"), ws("c", "old-2")];
  assert.deepEqual(ids(selectStaleSubscriptions(page, CURRENT)), ["b", "c"]);
});

test("tolerates an empty or absent data field", () => {
  // Twitch omits `data` rather than sending [] on some responses.
  assert.deepEqual(selectStaleSubscriptions([], CURRENT), []);
  assert.deepEqual(selectStaleSubscriptions(undefined, CURRENT), []);
  assert.deepEqual(selectStaleSubscriptions(null, CURRENT), []);
});

test("tolerates malformed entries without throwing", () => {
  // A throw here would abort the prune and leave the 409 mines in place.
  assert.deepEqual(ids(selectStaleSubscriptions([{ id: "x" }, null], CURRENT)), []);
});

test("an unset current session id does not sweep the session we are on", () => {
  // Guards the dangerous direction: if sessionId were ever undefined, a
  // careless `!==` would mark every subscription stale, including the live one.
  assert.deepEqual(ids(selectStaleSubscriptions([ws("a", undefined)], undefined)), []);
});
