/**
 * Tests for ActionRegistry's two decision rules — run with `node --test`
 * (or `make test` from the repo root).
 *
 * Why these two specifically:
 *
 * checkChatActions is the entire chat command dispatcher. `config.js` records
 * that its input data once shipped as `/^!voice\s$/i`, which can match nothing
 * — the documented command had never fired since the rewrite, and no gate in
 * this repo noticed. A regex that stops capturing looks identical to one that
 * works: the app loads, the count line prints, the command is simply dead.
 *
 * executeRewardAction decides whether a viewer's points are refunded. It has
 * THREE outcomes and conflating any two spends or destroys real money: it once
 * returned the same `false` for "not our reward" and "our reward failed", so
 * rewards the streamer created by hand were cancelled and refunded by us.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ActionRegistry } from "./action-registry.js";

/** Registry with logging silenced. */
const registry = () => {
  const r = new ActionRegistry();
  r.setLogger(() => {});
  return r;
};

const noop = () => {};

// ── checkChatActions ────────────────────────────────────────────────────

test("matches a single pattern and passes the whole message", () => {
  const r = registry();
  r.setChatActions([[noop, /badword/i]]);
  const hit = r.checkChatActions("a message with BADWORD in it");
  assert.equal(hit.action, noop);
  assert.equal(hit.message, "a message with BADWORD in it");
});

test("requires ALL patterns to match (AND, not OR)", () => {
  const r = registry();
  r.setChatActions([[noop, /viewers/i, /nezhna.+\.com/i]]);
  assert.equal(r.checkChatActions("buy viewers now"), null);
  assert.ok(r.checkChatActions("cheap viewers at nezhna-shop.com"));
});

test("extracts the first capture group as the action payload", () => {
  const r = registry();
  r.setChatActions([[noop, /^!voice\s+(.+)/i]]);
  assert.equal(r.checkChatActions("!voice hello world").message, "hello world");
});

test("a command regex that can match nothing is simply dead", () => {
  // The shipped-broken form from config.js's own note: \s with no quantifier
  // and an end anchor means "!voice " followed by nothing at all.
  const r = registry();
  r.setChatActions([[noop, /^!voice\s$/i]]);
  assert.equal(r.checkChatActions("!voice hello"), null);
  // The working form, for contrast — this is the assertion that fails if the
  // anchored-wrong version is ever reintroduced.
  const fixed = registry();
  fixed.setChatActions([[noop, /^!voice\s+(.+)/i]]);
  assert.ok(fixed.checkChatActions("!voice hello"));
});

test("first matching rule wins, in declaration order", () => {
  const first = () => "first";
  const second = () => "second";
  const r = registry();
  r.setChatActions([[first, /hello/i], [second, /hello/i]]);
  assert.equal(r.checkChatActions("hello").action, first);
});

test("rules with no patterns can never fire and are skipped", () => {
  const r = registry();
  r.setChatActions([[noop], [], [noop, /hit/i]]);
  assert.equal(r.checkChatActions("nothing here"), null);
  assert.ok(r.checkChatActions("hit"));
});

test("no rules configured matches nothing rather than throwing", () => {
  assert.equal(registry().checkChatActions("anything"), null);
});

// ── executeRewardAction ─────────────────────────────────────────────────

test("an unregistered reward is UNOWNED, never CANCELED", () => {
  // The distinction that matters: EventSub delivers every redemption on the
  // channel, so treating "not ours" as failure refunds and kills rewards the
  // streamer created by hand.
  return registry()
    .executeRewardAction("someone-elses-reward", "viewer", "", {})
    .then((outcome) => assert.equal(outcome, "UNOWNED"));
});

test("an empty registry does not cancel our own rewards either", async () => {
  // initializeRewards() failure is swallowed as a warning, so this state is
  // reachable for a whole session.
  const r = registry();
  r.setRewardActions({});
  assert.equal(await r.executeRewardAction("hate", "viewer", "", {}), "UNOWNED");
});

test("returning false is the only failure signal", async () => {
  const r = registry();
  r.setRewardActions({ fails: { action: () => false } });
  assert.equal(await r.executeRewardAction("fails", "viewer", "", {}), "CANCELED");
});

test("undefined is success by contract, not failure", async () => {
  const r = registry();
  r.setRewardActions({ quiet: { action: () => undefined } });
  assert.equal(await r.executeRewardAction("quiet", "viewer", "", {}), "FULFILLED");
});

test("a throwing action cancels rather than escaping", async () => {
  const r = registry();
  r.setRewardActions({ boom: { action: () => { throw new Error("nope"); } } });
  assert.equal(await r.executeRewardAction("boom", "viewer", "", {}), "CANCELED");
});

test("an async action is awaited before its outcome is read", async () => {
  const r = registry();
  r.setRewardActions({ slow: { action: async () => false } });
  assert.equal(await r.executeRewardAction("slow", "viewer", "", {}), "CANCELED");
});

test("the action receives context, user and input", async () => {
  const seen = [];
  const r = registry();
  r.setRewardActions({ echo: { action: (ctx, user, input) => { seen.push(ctx, user, input); } } });
  await r.executeRewardAction("echo", "vany", "a song url", { marker: 1 });
  assert.deepEqual(seen, [{ marker: 1 }, "vany", "a song url"]);
});
