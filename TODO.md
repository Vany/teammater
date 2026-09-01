# TODO — Codebase Simplification

Tracked improvements to reduce duplication, dead code, and structural complexity.
Estimated reduction: ~950 lines (from ~4500 to ~3500 LOC), zero functionality loss.


## BUG

- [x] **Russian TTS spoken by an English voice** — fixed `9b9cbe4`. Both TTS
      call sites assigned `utterance.language`; the Web Speech API property is
      `lang`, so the utterance carried no language at all. Only visible when the
      explicit voice lookup ALSO missed, which it does until the engine's async
      `voiceschanged` populates `getVoices()` — hence "sometimes".

- [ ] **OBS crash when scene changed — NOT REPRODUCING, and the old note was
      wrong.** Checked against `~/Library/Application Support/obs-studio/logs/`
      on 2026-09-01 (10 retained sessions, 2026-07-12 → 2026-08-28):
      - obs-websocket is **5.7.4 in every retained log**, including the crashed
        one. The "5.7.2 `strlen(NULL)`" attribution was never true here.
      - Exactly ONE session ever ended abnormally: `2026-08-14 19-31-03.txt`,
        which stops mid-log with no shutdown block, and there is no crash
        report in `~/Library/Logs/DiagnosticReports/`.
      - All 8 sessions since ended cleanly, across 29 scene switches.
      - The correlation in the data is reconnect churn, not scene count: the
        crashed session is the only one with 4 obs-websocket client connects
        (clean sessions have 1, two have 3), and it died one second after a
        reconnect — not on a scene switch.
      Acted on what is ours: the server now closes the OBS WebSocket with a
      Close frame instead of dropping it (`38d5bb4`) — every disconnect used to
      reach OBS as an abrupt `1006 End of File`. Correctness, not a proven fix.
      If it recurs: capture the OBS log tail and the server log for the same
      minute, and check the reconnect count first.

- [x] **Twitch EventSub subscription failure — FIXED and CONFIRMED live
      (2026-09-01).** Console on the confirming connect:
      ```
      ✅ EventSub session: <session-id>
      🧹 Cleared 3/3 stale EventSub subscription(s)
      ✅ Subscribed: channel.channel_points_custom_reward_redemption.add
      ✅ Subscribed: channel.raid
      ✅ Subscribed: stream.online
      ```
      **3/3** is the proof, not just a green light: exactly one previous
      session's worth of subscriptions was still holding exactly the three
      type+condition slots the new ones needed. That is the 409 collision
      caught in the act, and with them cleared all three subscribed first try.
      Cause: Twitch answers a duplicate subscription (same type
      + condition) with `409 subscription already exists`, and a WebSocket
      session's subscriptions are only *disabled* when its socket dies — they
      keep the slot. Every reload/drop/recheck therefore poisoned the next
      connect, and all three subscriptions failed together. That fits every
      observed detail: raid and stream.online need no scope, so a scope problem
      could never explain them failing too, and reloading never helped because
      reloading is what armed it. `_pruneStaleSubscriptions()` now clears them
      before subscribing (`0aa0391`).
      If it ever regresses, `🧹 Cleared N/M` is the line to read: N < M means
      deletes are being refused, and a `❌ Subscribe failed:` line now carries
      Twitch's real status and body.


## From the 2026-08-14 lore review (see MEMO.md)

- [ ] **Prevent the recurring context-shape bug.** Four findings were the same
      defect: `actions.js` calling something the modular rewrite deleted
      (`llm.chat`, `apiWhisper`, `obs._sendRequest`, `obs._waitForReconnect`).
      All current call sites resolve, but nothing stops the next one. Needs a
      rule, a lint, or a context assertion — not another manual fix.
- [ ] Decide on `pinMessageById()`: wire it up, or delete it and the
      `pinned_message` preset field. Currently justified as a documented gap.
- [ ] Consider a dev-only `package.json` so lore's tsc/eslint tiers can run.
      They would have caught `llm.chat()` and `apiWhisper()` for free.
      Currently justified as deliberate (`lore-ok[704edc91]`). Confirmed
      still blocking coverage in the 2026-08-21 round too.
- [ ] Report the lore schema bug upstream: T1 emitting `severity: "critical"`
      silently drops real HIGH findings from the review. 2026-08-21 round hit
      the same class again: a t3 finding dropped for unparseable JSON.

## From the 2026-08-21 lore review continuation (see MEMO.md)

- [ ] **Two recurring defect classes, per lore's own derived rule — need a
      structural fix, not the Nth manual patch:**
      - CWE-1051 (doc goes stale after code changes): 5 occurrences across
        SPEC.md, RUST_SERVER.md, README.md. Some kind of "docs touched in the
        same commit as the code they describe" habit or check.
      - CWE-754 (missing check on an exceptional condition): 7 occurrences —
        NaN from unchecked parseInt/parseFloat, `undefined` read as reward
        success. The NaN half now has a shared fix (`getConfigInt`/
        `getConfigFloat`); the undefined-as-success half doesn't — reward
        actions returning `false` on failure is still a convention each
        closure has to remember, not something the type/contract enforces.
- [ ] **Verify `num_ctx` empirically once Ollama is running.**
      `modules/llm/module.js` sends `options: { num_ctx }` to Ollama's
      OpenAI-compat endpoint (`/v1/chat/completions`), which doesn't document
      support for that field. Vany's call (2026-08-21): leave as-is, test for
      real next time Ollama is up rather than guess. If confirmed inert,
      decide then whether to move this module to Ollama's native `/api/chat`
      (fixes num_ctx, but loses generic OpenAI-compat — see
      `lore-ok[c7c48941]`/`[da167b0a]` in the code for the full tradeoff).



---

## Phase 1: Dead Code Removal ✅ COMPLETED

### 1.1 Delete `connectors.js` ✅

- [x] Verified no imports reference `connectors.js` (grep for `from "./connectors"` / `from '../connectors'`)
- [x] Deleted `connectors.js` and `test-llm.html`
- ~500 lines removed. `MusicQueue`, `MinecraftConnector`, `LLMConnector` were fully reimplemented inside modules.

### 1.2 Delete empty `core/base-module.js` ✅

- [x] Confirmed file didn't exist (already removed)
- All modules import from `modules/base-module.js`. No duplicate found.

### 1.3 Clean unused exports from `config.js` ✅

- [x] Removed `MUSIC_URL_PATTERN`, `EMPTY_MUSIC_URL`, `INITIAL_SONG_NAME`, `VOTE_SKIP_THRESHOLD`
- [x] Removed `AUDIO_DIRECTORY`, `VALID_SOUND_EFFECTS`, `SPEECH_SETTINGS`
- [x] Removed `WEBSOCKET_URLS` object
- [x] Removed `TIMING.RECONNECT_DELAY_MS`, `TIMING.MINARET_RECONNECT_DELAY_MS`
- [x] Removed `CHAT_HISTORY_SIZE`
- [x] Kept: `CHAT_ACTIONS`, `DEFAULT_PRESETS`, `getDefaultRewards`, `TWITCH_CLIENT_ID_KEY`, `TWITCH_SCOPES`, `getNickName`, `getTwitchUsername`, `getBroadcasterUsername`, `getMinecraftUsername`, `getMinecraftCommands`, timing constants, `DEFAULT_PINNED_MESSAGE`
- ~60 lines removed.

**Phase 1 Total: ~560 lines removed**

---

## Phase 2: BaseModule Deduplication ✅ COMPLETED

### 2.1 Extract `_waitForWebSocket(ws, timeoutMs)` into `BaseModule` ✅

- [x] Added shared method to `modules/base-module.js`:
  - `_waitForWebSocket(ws, timeoutMs = 10000)` — polls ws.readyState, resolves on OPEN, rejects on CLOSED/timeout
- [x] Replaced identical implementations in:
  - `modules/twitch-chat/module.js` (`_waitForConnection`)
  - `modules/minecraft/module.js` (`_waitForConnection`)
  - `modules/echowire/module.js` (`_waitForConnection`)
  - `modules/obs/module.js` (`_waitForConnection`)
- Note: `modules/twitch-eventsub/module.js` (`_waitForSession`) kept as-is due to custom session logic
- ~80 lines deduped (4 copies → 1 shared).

### 2.2 Extract WebSocket reconnect pattern into `BaseModule` ✅

- [x] Added to `BaseModule`:
  - `this.ws`, `this.shouldReconnect`, `this.reconnectTimer` fields
  - `_scheduleReconnect(delayConfigKey, defaultDelay)` method
  - `_cleanupReconnect()` method (clear timer, close ws, set flags)
- [x] Refactored WS modules to use shared reconnect:
  - `modules/twitch-chat/module.js`
  - `modules/twitch-eventsub/module.js`
  - `modules/minecraft/module.js`
  - `modules/echowire/module.js`
  - `modules/obs/module.js`
- Each module keeps its own `doConnect()` / `doDisconnect()` but delegates boilerplate.
- ~100 lines deduped (5 copies → shared base).

**Phase 2 Total: ~180 lines deduped**

---

## Phase 3: Core Architecture Simplification ✅ COMPLETED

### 3.1 Merge `ContextBuilder` into `ModuleManager` ✅

- [x] Moved `globalState`, `helpers`, `buildContext()`, `syncStateFromContext()` into `ModuleManager`
- [x] Inlined `_addLegacyHelpers` (now in ModuleManager)
- [x] Updated `index.js`: replaced all `contextBuilder` usage with `moduleManager.buildContext()` and `moduleManager.setGlobalState/setHelpers`
- [x] Deleted `core/context-builder.js`
- ~70 lines removed. One less class, one less file, same behavior.

### 3.2 Simplify `ActionRegistry` ✅ SKIPPED

- Decision: ActionRegistry is already clean at ~150 lines with good separation of concerns
- Provides clear interface between action definitions and execution
- No simplification needed - keeping as-is

### 3.3 Remove duplicate `request()` from `index.js` ✅

- [x] Removed inline `request` function in `setupModuleManagerContext()` (~30 lines)
- [x] Imported `request` from `utils.js` and passed into module manager helpers
- [x] Verified all context consumers receive it correctly
- ~30 lines removed. Single source of truth for API requests.

**Phase 3 Total: ~100 lines removed**

---

## Phase 4: LLM Monitoring Cleanup ✅ COMPLETED

### 4.1 Move `processLLMMonitoring()` into LLM module ✅

- [x] Created `LLMModule.monitorChat(chatHistory, markerPosition, formatFn, sendFn, addToHistoryFn)` method
- [x] Moved the 140-line `processLLMMonitoring()` from `index.js` into LLM module
- [x] Updated `index.js` handler to thin delegation: `llmModule.monitorChat(...)`
- Net ~120 lines moved to proper location (index.js now 20 lines vs 140 lines).

### 4.2 Fix broken `SilenceUser` branch ✅

- [x] Fixed bug: `.startsWith("SilenceUser")` was case-sensitive, changed to `.toLowerCase().startsWith("silence")`
- [x] Fixed typo: "Moders, please silince" → "Moderators, please silence"
- [x] Note: Still sends chat message asking moderators (doesn't call mute API directly) - intentional design
- Fixed in monitorChat() method during Phase 4.1

**Phase 4 Total: ~120 lines reorganized, 2 bugs fixed**

---

## Summary

| Phase     | Description                      | Lines Saved      |
| --------- | -------------------------------- | ---------------- |
| 1         | Dead code removal                | ~560             |
| 2         | BaseModule deduplication         | ~180             |
| 3         | Core architecture simplification | ~100             |
| 4         | LLM monitoring cleanup           | ~120 reorganized |
| **Total** | **All phases complete**          | **~840 lines**   |

### Files Deleted

- ✅ `connectors.js` (500+ lines)
- ✅ `test-llm.html` (300+ lines)
- ✅ `core/context-builder.js` (90 lines)

### Files Modified

- ✅ `config.js` — removed ~60 lines of unused exports
- ✅ `modules/base-module.js` — added ~80 lines of shared helpers
- ✅ `modules/twitch-chat/module.js` — removed ~40 lines of duplicate code
- ✅ `modules/twitch-eventsub/module.js` — removed ~30 lines of duplicate code
- ✅ `modules/minecraft/module.js` — removed ~40 lines of duplicate code
- ✅ `modules/echowire/module.js` — removed ~40 lines of duplicate code
- ✅ `modules/obs/module.js` — removed ~40 lines of duplicate code
- ✅ `modules/llm/module.js` — added ~150 lines (monitorChat method)
- ✅ `core/module-manager.js` — added ~140 lines (context builder functionality)
- ✅ `index.js` — removed ~200 lines, now cleaner and more maintainable

---

## Phase 5: Future Consideration (not blocking)

### 5.1 Unified auth propagation

- Current: `index.js` manually calls `setAuth()` / `setUserId()` per module
- Ideal: `moduleManager.setAuthContext({token, userId, channel})` propagates to all
- Not urgent — current approach works, just verbose.

### 5.2 Move `BaseModule` to `core/`

- Currently lives at `modules/base-module.js`, conceptually belongs in `core/`
- Would require updating imports in all 8 modules
- Cosmetic, do when convenient.

---

## ✅ ALL PRIORITY TASKS COMPLETED

Codebase simplified from ~4500 to ~3660 LOC (~840 lines saved, 18.7% reduction).
Zero functionality loss. All modules tested and working.
