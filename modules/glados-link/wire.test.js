import { test } from "node:test";
import assert from "node:assert/strict";
import { chatEvent, playFailure, audioBlob } from "./wire.js";

test("chatEvent maps IRC tags to the chat event", () => {
  const e = chatEvent({
    username: "SomeOne",
    message: "hi",
    messageId: "m1",
    tags: { "display-name": "SomeOne", "tmi-sent-ts": "1700000000000", badges: "broadcaster/1,subscriber/12" },
  });
  assert.deepEqual(e, { id: "m1", user: "someone", display: "SomeOne", text: "hi", ts: 1700000000000, badges: ["broadcaster", "subscriber"] });
});

test("chatEvent survives a message with no tags (echowire injection)", () => {
  const e = chatEvent({ username: "vany", message: "kira hello" });
  assert.equal(e.user, "vany");
  assert.equal(e.display, "vany");
  assert.deepEqual(e.badges, []);
  assert.ok(e.ts > 0);
});

test("playFailure classifies play() rejections", () => {
  assert.equal(playFailure({ name: "NotAllowedError" }), "autoplay");
  assert.equal(playFailure({ name: "NotSupportedError" }), "decode");
  assert.equal(playFailure(new Error("x")), "playback");
});

test("audioBlob decodes base64 and rejects bad input as decode failures", async () => {
  const b = audioBlob(btoa("OggS"), "audio/ogg");
  assert.equal(b.type, "audio/ogg");
  assert.equal(await b.text(), "OggS");
  for (const [data, mime] of [["", "audio/ogg"], ["T2dnUw==", "text/plain"], ["!!!", "audio/wav"]]) {
    assert.throws(() => audioBlob(data, mime), (e) => playFailure(e) === "decode");
  }
});
