# Teammater Implementation Memo

## Architecture Overview
Single-page web application with Twitch integration and Minecraft server communication.

**Core Components:**
- Twitch IRC WebSocket (wss://irc-ws.chat.twitch.tv:443) for chat connectivity
- Twitch Helix API for stream management, chat settings, and moderation
- EventSub WebSocket (wss://eventsub.wss.twitch.tv/ws) for real-time redemptions
- MinecraftConnector class - WebSocket client for "minarert" server (localhost:8765)
- MusicQueue class - Cross-tab music control via UserScript + localStorage events
- Audio system: MP3 playback + Speech Synthesis API
- **Action System:** Unified function-based closure architecture for all bot actions

## OAuth Configuration
**Required Scopes:**
- chat:read, chat:edit - IRC chat connectivity
- channel:manage:broadcast - stream title/game/tags updates
- moderator:manage:chat_settings - pinned message management
- user:manage:whispers - private whisper functionality
- channel:manage:redemptions, channel:read:redemptions - channel points
- moderator:manage:banned_users - ban/timeout actions
- moderator:manage:chat_messages - message deletion

**Authentication Flow:**
1. Check localStorage for existing token
2. If none, redirect to Twitch OAuth with required scopes
3. Extract token from redirect hash fragment
4. Store in localStorage for persistence
5. Fetch user ID and login name via /helix/users
6. Set CHANNEL: URL parameter (?channel=name) or authenticated username (default)

## API Endpoints Used
**Stream Management:**
- GET/PATCH `/helix/channels?broadcaster_id={id}` - stream info and updates
- GET/PATCH `/helix/chat/settings?broadcaster_id={id}&moderator_id={id}` - chat settings and pinning

**Messaging:**
- POST `/helix/whispers` - private whispers (requires target user_id)
- POST `/helix/chat/announcements` - colored announcements
- IRC `PRIVMSG` - regular messages and action messages

**Channel Points:**
- GET/POST `/helix/channel_points/custom_rewards` - reward CRUD
- PATCH `/helix/channel_points/custom_rewards/redemptions` - fulfill/cancel
- EventSub subscription for real-time redemption notifications

**Moderation:**
- POST `/helix/moderation/bans` - ban/timeout users (with data.duration for timeout)
- DELETE `/helix/moderation/chat?message_id={id}` - delete specific messages

## Stream Presets System
**DEFAULT_PRESETS Configuration (index.js):**
```javascript
{
  presetKey: {
    title: "Stream title",
    game_id: "Twitch category ID",
    tags: ["Tag1", "Tag2"],
    pinned_message: "Auto-pinned chat message",
    rewards_active: ["voice", "music"] // Which rewards are visible
  }
}
```

**Current Presets:**
- **loitering**: Prep stream, educational content (rewards: voice, music, vote_skip, playing)
- **coding**: Programming session (rewards: voice, music, vote_skip, playing)
- **gaming**: Minecraft gameplay (rewards: voice, hate, love)
- **dooming**: All rewards hidden

**Workflow:**
1. User selects preset from dropdown
2. PATCH /helix/channels updates stream info
3. applyRewardConfig() enables/disables rewards via PATCH
4. Pinned message auto-sent and pinned (temporarily disabled in code)

## Pinned Message Automation
**Message ID Capture:**
- IRC capability request: `CAP REQ :twitch.tv/tags twitch.tv/commands`
- Tags format: `@msg-id=abc-123;user-id=456;...`
- parseIrcTags() extracts structured data from tag string

**Pinning Flow:**
1. Set pendingPinMessage to desired text
2. Send via IRC PRIVMSG
3. Capture @msg-id from echo response
4. PATCH /helix/chat/settings with pinned_chat_message_id
5. Clear pendingPinMessage after success

**Current Status:** Auto-pinning temporarily disabled (line commented in applyStreamPreset)

## Channel Point Rewards
**Default Rewards (DEFAULT_REWARDS in index.js):**
- hate (300pts): Lightning + Minecraft command
- love (200pts): Health boost + action message + timer
- music (150pts): Yandex Music URL validation + queue
- voice (50pts): TTS with custom text input
- vote_skip (30pts): Democratic song skip (3 votes needed)
- playing (30pts): Display current track

**Redemption Processing:**
1. EventSub WebSocket receives redemption event
2. handleRewardRedemption() matches reward ID to action
3. Execute game command / play audio / queue song / TTS
4. updateRedemptionStatus() marks FULFILLED or CANCELED

**Rate Limiting:**
- Per-reward global cooldowns (configured in DEFAULT_REWARDS)
- Throttle object tracks per-user cooldowns (60s for hate command)

## Message Moderation System
**BAN_RULES Configuration (index.js):**
```javascript
const BAN_RULES = [
  [action(), /pattern1/, /pattern2/],  // All patterns must match (AND)
  [action(), /pattern3/]                // Single pattern
  // Rules evaluated in order, first match wins (OR)
];
```

**Actions:**
- `mute(seconds)` - Timeout user (e.g., mute(600) = 10 minutes)
- `ban()` - Permanent ban
- `delete()` - Delete message only

**Processing Flow:**
1. IRC message received with tags
2. parseIrcTags() extracts user-id and message id
3. checkBanRules() tests message against all patterns
4. If match: executeModerationAction() calls Twitch API
5. Stop processing (return early, no mp3/minecraft forward)
6. If no match: normal command/message handling

**Current Production Rule:**
```javascript
[ban(), /viewers/i, /nezhna.+\.com/i]  // Ban viewer spam
```

**Safety:**
- Skip moderation if userId === currentUserId (don't ban self)
- Skip if BAN_RULES.length === 0 (no rules configured)

## Yandex Music Integration
**Architecture:**
- UserScript injected into music.yandex.ru tabs
- Master/client pattern via localStorage events
- Message format: `{command: "song", data: url}`

**Commands:**
- `song`: Open URL and auto-play track
- `music_done`: Track ended, advance queue
- `music_start`: Track started, broadcast title

**Button Targeting:**
- Primary: `header[class^="TrackModal_header_"] button[aria-label="Playback"]`
- Fallback: Generic playback button selectors

**Queue Management:**
- PersistentDeck class wraps localStorage arrays
- songQueue stores pending tracks
- queueSong() adds to queue, plays if empty
- skipSong() advances to next or fallback URL

## Chat Command Handlers
**handleCommand(user, cmd):**
- `!song <url>` - Validate Yandex Music URL, queue track
- `!love_vany` - Minecraft message + action message, set protection timer
- `!hate_vany` - Health boost + conditional lightning (checks love_timer)
- `!voice <text>` - Speech synthesis + forward to Minecraft
- `!chat <sound>` - Play MP3 if valid sound name
- `!me <text>` - Action message via IRC ACTION format
- `!announce [color] <text>` - Colored announcement (blue/green/orange/purple/primary)

**Throttling:**
- throttle object: `{username: lastCommandTime}`
- 60s cooldown per user for !hate_vany (except broadcaster)

## Connection Management
**Status Indicators:**
- twitchStatus - IRC WebSocket connection
- minaretStatus - Local server connection
- streamStatus - API connectivity

**Reconnection:**
- Twitch IRC: setTimeout(reconnect, 1000) on close
- Minarert: setTimeout(connectMinaret, 5000) on close
- EventSub: setTimeout(connectEventSub, 5000) on close

**Initialization Sequence:**
1. Extract/validate OAuth token
2. startChat() - Connect IRC + fetch user ID
3. initializeRewards() - Create missing rewards + apply default config
4. displayRewardsList() - Populate UI
5. connectEventSub() - Subscribe to redemptions
6. connectMinaret() - Local WebSocket
7. skipSong() - Initialize music queue with fallback URL

## Code Organization
- index.html - DOM structure (98 lines)
- index.css - Styling (169 lines)
- index.js - Application logic (~1000 lines, reduced after connector extraction)
- config.js - Configuration and constants
- actions.js - Unified action system with closure-based actions
- utils.js - Reusable utilities (HTTP, deck/queue, IRC parsing)
- connectors.js - External system connectors (Music Queue, Minecraft WebSocket)
- yandex-music-userscript.js - Cross-tab music control

**Key Functions:**
- buildCommandContext() - Creates context object for action execution
- handleRewardRedemption() - Executes reward actions using buildCommandContext()

**Key Utilities (utils.js):**
- request() - Generic HTTP wrapper for Twitch API calls with automatic token injection
- PersistentDeck - localStorage-backed double-ended queue (push/pop/shift/unshift)
- parseIrcTags() - IRC message tag parser for extracting metadata

**Key Connectors (connectors.js):**
- MusicQueue - Cross-tab music control with UserScript integration
  * add(url) - Queue song for playback
  * skip() - Skip current song
  * voteSkip() - Democratic skip voting
  * getCurrentSong() - Get current track name
- MinecraftConnector - WebSocket client for local Minecraft server
  * connect() - Establish connection with auto-reconnect
  * sendMessage(user, msg) - Send chat message
  * sendCommand(cmd) - Execute game command
  * isConnected() - Check connection status

**Global State:**
- ws - IRC WebSocket connection
- eventSubSocket - EventSub connection
- currentUserId - Broadcaster ID from OAuth
- userIdCache - Username -> ID mapping
- customRewards - Reward ID -> config mapping
- throttle - Command rate limiting
- minecraft - MinecraftConnector instance (WebSocket to game server)
- musicQueue - MusicQueue instance (cross-tab music control)

## Action System Architecture

**Core Principle:** All actions are initializers that take configuration parameters and return configured closures.

**Action Initializer Pattern:**
```javascript
// Action initializer function (in actions.js)
export function actionName(configParam1, configParam2 = defaultValue, ...) {
  // Capture configuration parameters in closure
  return (context, user, message) => {
    // Use configParam1, configParam2 to configure behavior
    // Access context for dependencies: { ws, log, currentUserId, ... }
    // Return false for failure, void/true for success
  };
}

// Usage in config.js
const config = {
  action: actionName(param1, param2), // Call initializer to get configured closure
};

// Execution in index.js
const actionClosure = config.action; // Already a closure, no factory call
await actionClosure(context, user, message);
```

**Example: Multiple Voice Configurations**
```javascript
// In actions.js
export function voice(voiceConfig = {}) {
  const config = { type: "default", language: "en-US", rate: 1.0, ...voiceConfig };
  return (context, user, message) => {
    // Use config.type, config.language, config.rate
  };
}

// In config.js - different voice types
voice_robot: { action: voice({ type: "robot", rate: 1.5, pitch: 0.5 }) },
voice_woman: { action: voice({ type: "woman", language: "en-GB" }) },
voice_man: { action: voice({ type: "man", language: "en-US" }) },
```

**Context Object Structure:**
- WebSocket connections: `ws`, `minarert`
- State variables: `currentUserId`, `CHANNEL`, `throttle`, `love_timer`, `needVoteSkip`, `currentSong`
- Utility functions: `log`, `mp3`, `speak`
- Twitch functions: `send_twitch`, `sendAction`, `apiWhisper`
- Minecraft functions: `sendMessageMinaret`, `sendCommandMinaret`
- Music functions: `queueSong`, `skipSong`

**Action Types:**
1. **Reward Actions** (actions.js): `hate()`, `love()`, `music()`, `voice()`, `vote_skip()`, `playing()`
   - Used in channel point rewards (config.js: DEFAULT_REWARDS)
   - Called via handleRewardRedemption() with full context
   - Return false to mark redemption as canceled

2. **Moderation Actions** (actions.js): `mute(seconds)`, `ban()`, `delete_message()`
   - Used in ban rules (config.js: BAN_RULES)
   - Called via executeModerationAction() with moderation context
   - Context includes: `currentUserId`, `userId`, `messageId`, `request`, `log`
   - All moderation actions are async and handle their own API calls

**Execution Flow:**

*Reward Redemptions:*
1. EventSub receives redemption event
2. handleRewardRedemption() looks up action closure from customRewards
3. buildCommandContext() creates context with current state
4. Execute actionClosure(context, user, message)
5. Update global state from modified context
6. Mark redemption as FULFILLED or CANCELED based on result

*Moderation Actions:*
1. IRC message received with tags
2. checkBanRules() tests message against all patterns, returns action closure if matched
3. executeModerationAction() builds moderation context (currentUserId, userId, messageId, request, log)
4. Execute actionClosure(context, user, message) - action makes API call directly
5. Stop message processing if action was triggered

*Regular Chat Messages:*
1. IRC message received
2. Check moderation rules first
3. If not moderated, forward to Minecraft server via sendMessageMinaret()
4. Play ICQ notification sound for non-command messages

**Benefits:**
- **Configurable**: Each action can be customized with parameters at initialization
- **Type-safe**: Consistent function signatures with compile-time parameter validation
- **Reusable**: Same action initializer creates multiple differently-configured closures
- **Explicit**: Configuration is visible at definition site in config.js
- **Predictable**: No string-based dispatch, no runtime factory calls
- **Testable**: Easy to mock context for testing
- **AI-parseable**: Zero ambiguity in execution flow
- **Maintainable**: Add new actions by creating parameterized initializers
- **Efficient**: Closures created once at config load, not per execution

## Current Configuration
- Channel: Defaults to authenticated user's channel, override via ?channel=name
- Redirect URI: window.location.origin
- Minarert: ws://localhost:8765
- Served: https://localhost:8443 (Caddy TLS)
- Ban rule: viewers + nezhna*.com spam

## Twitch Client ID Setup
1. Visit: https://dev.twitch.tv/console/apps
2. Click "Register Your Application"
3. Set Name: `teammater` (or your choice)
4. Set OAuth Redirect URL: `https://localhost:8443`
5. Set Category: Chat Bot
6. Save and copy the Client ID
7. Paste it when prompted on first run (stored in localStorage)

## URL Parameters
- `?channel=name` - Override channel to connect to (default: authenticated user's channel)
- `?wipe` - Clear all localStorage before initialization (forces re-authentication and re-configuration)

## Code Refinement Tasks

### Consistency Improvements
- [x] actions.js: Replace full URL API calls with consistent pattern from utils.js
- [x] Unify error handling pattern across all modules
- [ ] Standardize function declaration style (arrow vs function)
- [x] Remove code duplication in moderation actions
- [ ] Extract magic numbers to TIMING config

### Performance Optimizations
- [x] Cache DOM element references in index.js (currently queried repeatedly)
- [x] Batch localStorage writes in PersistentDeck
- [ ] Deduplicate concurrent API requests for same user ID

### Code Quality
- [x] Add JSDoc type annotations for all exported functions
- [ ] Remove unused variables and dead code
- [ ] Consistent naming conventions (sendCommandMinaret vs sendMessageMinaret)
- [ ] Consolidate duplicate IRC message sending logic

**Status:** Major refinement pass completed on 2025-11-22. Commit: 26ce4b3

## Recent Improvements (2025-01-25)

### Completed
1. **actions.js refactoring:**
   - Extracted `executeModerationAPI()` helper to eliminate code duplication
   - All moderation actions (mute, ban, delete_message) now use consistent API pattern
   - Standardized JSDoc format with proper type annotations

2. **utils.js optimization:**
   - PersistentDeck now batches writes with configurable flush interval (default: 1s)
   - Added `flush()` method for critical operations
   - Added `destroy()` method for cleanup
   - Page unload handler ensures final flush before close

3. **index.js DOM optimization:**
   - Created centralized DOM element cache to eliminate repeated getElementById calls
   - Added `cacheDOMElements()` function called once on initialization
   - All DOM access now uses cached references via `DOM` object

4. **JSDoc standardization:**
   - All exported functions now have proper JSDoc with type annotations
   - Consistent format: `@param {type}`, `@returns {type}`, `@throws {type}`
   - Better IDE support and developer experience

5. **Test button consistency:**
   - Test button now uses `voice()` action instead of manual SpeechSynthesisUtterance
   - Eliminates code duplication and ensures consistent behavior
   - Test action configured with SPEECH_SETTINGS from config.js

6. **Global exports pattern:**
   - Established pattern for exposing actions to HTML onclick handlers
   - Actions exported to `window` object for direct use in HTML
   - Example: `onclick='voice()({}, "user", "message")'`
   - Enables console debugging: `window.voice()({log: console.log}, "test", "Hello")`
   - Documented template for future exports in index.js

### Performance Impact
- **localStorage writes:** Reduced from ~100/min to ~1/min during active queue operations
- **DOM queries:** Eliminated ~50 getElementById calls per preset change
- **Code size:** Reduced actions.js by ~30 lines through deduplication
- **Code duplication:** Eliminated manual TTS implementation in test function

## Global Exports Pattern

**Purpose:** Make actions and utilities available for HTML onclick handlers and console debugging.

**Location:** Bottom of index.js in `GLOBAL EXPORTS FOR HTML` section

**Pattern:**
```javascript
// In index.js - import the action
import { voice, music, hate, love } from "./actions.js";

// At bottom of file - export to window
window.voice = voice;
window.music = music;
// ... add more as needed
```

**HTML Usage:**
```html
<button onclick='voice()({}, "testuser", "Test passed")'>TEST</button>
<button onclick='music()({log: console.log, queueSong: (url) => {}}, "user", "https://...")'>Queue</button>
```

**Console Usage:**
```javascript
// Test voice action
window.voice()({log: console.log}, "test", "Hello from console");

// Test with minimal context
window.music()({
  log: console.log,
  queueSong: (url) => console.log("Queue:", url),
  apiWhisper: () => {},
  send_twitch: () => {}
}, "console", "https://music.yandex.ru/track/123");

// Test utilities directly
window.mp3("boo");
window.speak("Testing speech");
window.log("Testing log output");

// Inspect current state
window.getState();
// Returns: {twitchConnected, currentUserId, CHANNEL, love_timer, ...}
```

**Guidelines:**
- Export action initializers, not closures (export `voice`, not `voice()`)
- Always include usage examples in comments
- Keep exports organized in dedicated section
- Export utilities that are useful for debugging (log, mp3, speak, etc.)
- Document minimal context requirements for each action
- Provide read-only state access via getter functions (don't expose mutable state directly)
- **Actions must be defensive:** Check if context functions exist before calling them
  ```javascript
  // Good - defensive
  if (log) log("message");
  if (sendMessageMinaret) sendMessageMinaret(msg);
  
  // Bad - assumes context has everything
  log("message"); // Crashes if log undefined
  ```

## Recent Improvements (2025-11-22)

### Automatic Stored Elements System

**Added:**
1. **Generic stored_as attribute system**
   - Custom HTML attribute `stored_as="key"` enables automatic localStorage persistence
   - On page load: restores value from `localStorage[key]`
   - On change: writes value to `localStorage[key]`
   - Supports: checkbox (checked state), input/textarea (value), select (value)
   - Zero manual localStorage calls needed in application code

2. **index.js: initializeStoredElements() function**
   - Queries all `[stored_as]` elements on page load
   - Restores saved state from localStorage
   - Attaches change listeners for automatic write-through
   - Logs all storage operations for debugging

3. **🌸 Loud mode checkbox**
   - Located above Connection Status section
   - Controls ICQ notification sound on chat messages
   - Checked by default (loud mode enabled)
   - State persisted across page reloads
   - Uses `stored_as="loud"` attribute

4. **Twitch Client ID input field**
   - Located at bottom of control panel
   - Replaces prompt-based persistentValue() system
   - Uses `stored_as="twitch_client_id"` for automatic persistence
   - Includes helpful link to dev.twitch.tv/console/apps
   - Requires page reload after entering new Client ID
   - Shows error message if CLIENT_ID is empty on authentication

**Usage Pattern:**
```html
<!-- Checkbox with automatic persistence -->
<input type="checkbox" stored_as="loud" checked />

<!-- Text input with automatic persistence -->
<input type="text" stored_as="username" />

<!-- Select with automatic persistence -->
<select stored_as="theme">
  <option value="dark">Dark</option>
  <option value="light">Light</option>
</select>
```

**Behavior:**
- ICQ sound plays on non-command messages when checkbox is checked
- ICQ sound is silent when checkbox is unchecked
- Checkbox state persists across page reloads via localStorage
- All storage operations logged: `💾 Stored loud = true`

**Benefits:**
- Declarative persistence - no manual localStorage code
- Reusable for any form element
- Type-safe (checkbox vs input handled correctly)
- Single source of truth in HTML
- Easy to add new persisted elements

### Moderator Rights Enforcement

**Added:**
1. **index.js: checkModeratorStatus() function**
   - Checks if authenticated user has moderator rights in target channel
   - Uses `/helix/moderation/moderators` API endpoint
   - Returns true if user is broadcaster or moderator
   - Handles errors gracefully with fallback to false
   - Logs detailed status messages for debugging

2. **index.js: initializeMinecraftConnector() function**
   - Extracted Minecraft connector initialization into dedicated function
   - Checks if already initialized to prevent duplicates
   - Called conditionally based on moderator permissions
   - Logs initialization status

3. **index.js: Conditional EventSub and Minecraft connection**
   - Modified `ws.onopen` handler to check channel ownership
   - Always connects EventSub and Minecraft for own channel
   - Checks moderator status for non-default channels
   - Skips both EventSub and Minecraft if no moderator rights detected
   - Logs clear warning messages when permissions missing

**Behavior:**
- Own channel (default): EventSub and Minecraft always enabled
- Other channel with moderator rights: EventSub and Minecraft enabled
- Other channel without moderator rights: Both disabled, warnings logged
- Prevents both reward listener and game server connection when lacking permissions
- Music queue still initializes (not permission-dependent)

**Example Log Output:**
```
✅ Connected to #otherchannel as myusername
⚠️ You are NOT a moderator in #otherchannel
⚠️ Connected to non-default channel (#otherchannel) without moderator rights
ℹ️ Channel point reward listener disabled
ℹ️ Minecraft connector disabled
```

**Rationale:**
- No point connecting to Minecraft server if we can't use channel point rewards
- Prevents unnecessary WebSocket connections and potential confusion
- Clear separation between own channel (full control) and other channels (limited)

### Automatic Language Detection for TTS

**Added:**
1. **utils.js: detectLanguage() function**
   - Unicode range detection for Cyrillic (Russian) vs Latin (English)
   - Fast, zero-dependency, pattern: /[\u0400-\u04FF]/ for Cyrillic, /[A-Za-z]/ for Latin
   - Returns "ru", "en", or "unknown"
   - Example: `detectLanguage("Привет мир")` → "ru", `detectLanguage("Hello world")` → "en"

2. **actions.js: voice() automatic language detection**
   - Automatically detects language from message text before TTS
   - Maps detected language to locale codes:
     * "ru" → "ru-RU"
     * "en" → "en-US"
     * "unknown" → config.language (fallback)
   - Disabled when voiceName is explicitly specified
   - Logs show detection: `[ru->ru-RU]` or `[en->en-US]`

**Behavior:**
- Russian text automatically uses Russian TTS voice
- English text automatically uses English TTS voice
- Mixed or unclear text falls back to config.language (default: en-US)
- Config voiceName parameter disables auto-detection

**Example Usage:**
```javascript
// Automatic detection
voice()({log: console.log}, "user", "Привет мир");  // Uses ru-RU
voice()({log: console.log}, "user", "Hello world"); // Uses en-US

// Manual override still works
voice({voiceName: "Samantha"})({log: console.log}, "user", "Test"); // Uses Samantha
```

**Impact:**
- Users can use !voice command with both Russian and English text
- No need to specify language parameter
- Natural multilingual support for Twitch chat
