# TODO — Codebase Simplification

Tracked improvements to reduce duplication, dead code, and structural complexity.
Estimated reduction: ~950 lines (from ~4500 to ~3500 LOC), zero functionality loss.

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

| Phase | Description | Lines Saved |
|-------|-------------|-------------|
| 1 | Dead code removal | ~560 |
| 2 | BaseModule deduplication | ~180 |
| 3 | Core architecture simplification | ~100 |
| 4 | LLM monitoring cleanup | ~120 reorganized |
| **Total** | **All phases complete** | **~840 lines** |

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
