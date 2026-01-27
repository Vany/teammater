# Teammater Specification

## Project Overview

Teammater is a Twitch streaming bot with a modular architecture that integrates:
- Twitch IRC chat (WebSocket)
- Twitch EventSub (channel point redemptions)
- Twitch Helix API (stream management, moderation)
- Minecraft server integration via WebSocket (Minaret)
- Yandex Music queue system (cross-tab communication via UserScript)
- Local LLM integration (Ollama) for AI-powered chat features
- OBS Studio WebSocket for stream monitoring
- Android STT (Speech-to-Text) via Echowire WebSocket

The bot connects to a Twitch channel (default: authenticated user's own channel, or specify `?channel=name` in URL) and provides interactive features through channel point rewards, chat commands, and automated moderation.

## Architecture

### Modular Architecture

The application uses a clean modular architecture with **8 independent modules**:

**Core System Files:**
- `index.html` - Main UI with modules container and global controls
- `index.js` - Application entry point, authentication, module orchestration
- `config.js` - Centralized configuration: presets, rewards, chat actions, API settings
- `actions.js` - Reusable action closures for rewards and chat commands
- `utils.js` - Shared utilities: HTTP requests, PersistentDeck, IRC parsing, language detection

**Core Module System (`core/`):**
- `module-manager.js` - Module lifecycle management (register, initialize, connect, disconnect)
- `ui-builder.js` - Auto-generates UI from config schemas (forms, inputs, panels)
- `action-registry.js` - Centralized action management (chat actions, reward actions)
- `context-builder.js` - Builds unified execution context for actions
- `base-module.js` - Base class for all modules with common lifecycle and UI logic

**Modules (`modules/`):**

1. **Echowire Module** (`modules/echowire/module.js`)
   - WebSocket connector for Android STT (Speech-to-Text) service
   - Receives real-time speech recognition from mobile device
   - Voice command integration: "работай"/"роботай" prefix triggers chat injection
   - Messages injected as trusted superuser into Twitch chat system
   - Protocol: Incremental transcription with diff-based partials
   - Reference: `wsformat.md`
   - Auto-reconnection with configurable delay

2. **LLM Module** (`modules/llm/module.js`)
   - Ollama LLM integration for chat monitoring and responses
   - Dynamic model selection with auto-fetch from Ollama API
   - Configurable: base URL, model, system prompt, temperature, max tokens
   - Four-stage decision process: nothing, remember, respond, silence_user
   - "Remember" action: stores internal notes in chat history silently (not sent to Twitch)
   - Enable Echowire checkbox: controls voice command integration
   - Chat monitoring with configurable batch processing

3. **Music Queue Module** (`modules/music-queue/module.js`)
   - Cross-tab Yandex Music control via UserScript
   - Queue management with PersistentDeck (localStorage)
   - Vote skip system with configurable threshold
   - Smart queueing: plays immediately if queue empty, otherwise queues
   - Native Yandex Music "next" button integration when queue empty
   - Control modal with queue display and management buttons
   - Syncs current song name from music player
   - Commands: song, pause, resume, next, query_status
   - Callback system: onSongStart for integration

4. **Minecraft Module** (`modules/minecraft/module.js`)
   - WebSocket integration with Minecraft server (Minaret plugin)
   - Send chat messages and execute game commands
   - Auto-reconnection with configurable delay
   - Context contribution: sendMessageMinaret, sendCommandMinaret

5. **OBS Module** (`modules/obs/module.js`)
   - WebSocket integration with OBS Studio (obs-websocket plugin v5.x)
   - Connection status with custom indicators
   - Streaming status with dropped frames monitoring
   - Recording status with pause indicator
   - Frame drop alerts with cooldown (10s)
   - Auto-reconnection with configurable delay
   - Poll-based status updates (configurable interval)
   - Control API: start/stop/toggle stream/record

6. **Twitch Chat Module** (`modules/twitch-chat/module.js`)
   - IRC WebSocket connection to Twitch chat
   - Message parsing with tags (user-id, message-id)
   - Chat history buffer for LLM monitoring
   - Message handler system for plugins (priority-based)
   - Multiple message types: chat, whisper, action, announcement
   - Configurable: IRC URL, reconnect delay, nickname, username
   - Includes Twitch Client ID configuration
   - Internal methods: _addToChatHistory, _notifyMessageHandlers

7. **Twitch EventSub Module** (`modules/twitch-eventsub/module.js`)
   - WebSocket connection for channel point redemptions
   - Reward management with TEST buttons
   - Redemption status updates (FULFILLED/CANCELED)
   - Rewards list display in config panel
   - Session management with keep-alive pings
   - Auto-reconnection on session timeout

8. **Twitch Stream Module** (`modules/twitch-stream/module.js`)
   - Stream metadata management (title, game, tags)
   - Preset system for quick stream setup
   - Auto-enables/disables rewards based on preset
   - Pinned message management
   - Preset info display in config panel
   - Preset application with reward config sync

## Core Functionality

### Twitch Integration
- [x] OAuth2 authentication with Twitch
- [x] IRC WebSocket connection for chat
- [x] EventSub WebSocket for channel point redemptions
- [x] Twitch Helix API for stream management and moderation
- [x] OAuth scopes required:
  - `chat:read`, `chat:edit` - Chat messaging
  - `channel:manage:broadcast` - Stream metadata updates
  - `moderator:manage:chat_settings` - Chat moderation
  - `user:manage:whispers` - Private messages
  - `channel:manage:redemptions`, `channel:read:redemptions` - Channel points
  - `moderator:manage:banned_users`, `moderator:manage:chat_messages` - Moderation actions

### Chat Features
- [x] Chat command processing via action registry pattern
- [x] Multiple message types:
  - Regular chat messages
  - Private whispers (via API)
  - Public mentions (@username)
  - Action messages (/me format, grayed/italicized)
  - Colored announcements (official Twitch announcements)
- [x] User ID caching system for efficient API calls
- [x] Chat history buffer for LLM monitoring
- [x] IRC tags parsing for user-id and message-id extraction
- [x] Chat marker position tracking for LLM processing

### Channel Point Rewards System
- [x] Custom Reward Creation: Automated setup of default interactive rewards
- [x] Default Rewards:
  - Hate Streamer (300 points): Minecraft lightning (with love protection)
  - Love Streamer (200 points): Protection from hate for 60 seconds
  - Song Request (150 points): Yandex Music URL + queue
  - Voice Message (50 points): TTS with automatic language detection
  - Ask Neuro (100 points): LLM response in chat
  - Vote Skip (30 points): Vote to skip current song
  - What's Playing (30 points): Display current track info
- [x] Reward Management UI with TEST buttons
- [x] Automatic redemption handling and status updates
- [x] Rate limiting per-user and global cooldowns
- [x] Preset-Based Reward Control:
  - Automatically enable/disable rewards based on stream preset
  - Uses `rewards_active` array in preset configuration
  - Updates reward `is_enabled` flag via Twitch API

### Message Moderation System
- [x] Configurable ban rules via CHAT_ACTIONS constant
- [x] Rule-based pattern matching with AND/OR logic:
  - Outer array: rules combined by OR (any rule triggers action)
  - Inner array: first element is action, rest are regexes combined by AND (all must match)
- [x] Three moderation actions:
  - `mute(seconds)`: Timeout user for specified duration
  - `ban()`: Permanently ban user and delete all messages
  - `delete_()`: Delete only the matched message
- [x] Skip moderation for bot's own messages and broadcaster
- [x] Stops message processing after moderation action

### Stream Management
- [x] Stream preset system with title, game, tags
- [x] Automatic preset application on connection
- [x] Preset info display (title, game, tags, pinned message)
- [x] Pinned message management:
  - Preset-specific pinned messages
  - Default fallback pinned message
  - IRC tags integration for message ID capture
  - Automatic pinning on stream start

### External Integrations

**Echowire (Android STT):**
- [x] WebSocket connection to wss://localhost:8443/echowire
- [x] Real-time speech recognition from mobile device
- [x] Voice command prefix detection: "работай"/"роботай"
- [x] Automatic injection into Twitch chat as trusted superuser
- [x] Incremental transcription with diff-based partials
- [x] Final result with confidence scores and language detection
- [x] Auto-reconnection with configurable delay
- [x] Protocol v1: hello, partial_result, final_result, recognition_error

**Minecraft (Minaret WebSocket):**
- [x] WebSocket connection to localhost:8765
- [x] Send chat messages to Minecraft
- [x] Execute game commands (lightning, heal, etc.)
- [x] Auto-reconnection with configurable delay
- [x] Dynamic command generation based on localStorage username

**Yandex Music (UserScript):**
- [x] Cross-tab communication between Teammater and Yandex Music
- [x] Queue management with localStorage persistence
- [x] Automatic track playback from URLs
- [x] Track end detection and queue advancement
- [x] Vote skip system with native "next" button integration
- [x] Skip from queue when songs queued, or native skip when queue empty
- [x] Current song name synchronization
- [x] Master/client architecture for cross-tab communication
- [x] Commands: song, pause, resume, next, query_status
- [x] Smart queueing: play immediately if empty, queue otherwise

**LLM (Ollama):**
- [x] HTTP connection to localhost:11434
- [x] Chat monitoring and response system
- [x] Dynamic model selection
- [x] Four-action decision process: nothing, remember, respond, silence_user
- [x] "Remember" action for internal memory (stored in chat history, not sent to Twitch)
- [x] Configurable system prompt, temperature, max tokens
- [x] Integration with channel point rewards (Ask Neuro)
- [x] Echowire voice command integration
- [x] Two-stage LLM workflow: decision → action execution

**OBS Studio (obs-websocket):**
- [x] WebSocket connection to ws://localhost:4455
- [x] OBS WebSocket 5.x protocol support
- [x] Authentication with SHA-256 hash
- [x] Streaming status monitoring
- [x] Recording status with pause detection
- [x] Dropped frames tracking and alerts
- [x] Custom UI indicators: connection, streaming, recording
- [x] Auto-reconnection with configurable delay
- [x] Poll-based status updates (2s default)
- [x] Frame drop alerts with 10s cooldown
- [x] Control API: start/stop/toggle/pause operations

### Moderator Rights Enforcement
- [x] Automatic detection when connected to non-default channel (via `?channel=name`)
- [x] Checks moderator status via Twitch API `/helix/moderation/moderators`
- [x] EventSub connection disabled if no moderator rights
- [x] Minecraft connector disabled if no moderator rights
- [x] Warning messages logged when connecting without permissions
- [x] Always allows EventSub and Minecraft for authenticated user's own channel

### Audio & TTS
- [x] Audio playback for sound effects (MP3 files)
- [x] Volume control parameter in mp3() function
- [x] Speech synthesis API integration
- [x] Configurable voice selection (Russian/English)
- [x] Language detection for automatic voice selection (Cyrillic vs Latin)
- [x] Volume control ("loud" checkbox)
- [x] Voice types: default, custom voice names

## Key Design Patterns

### BaseModule Pattern
All modules extend `BaseModule`:
```javascript
export class MyModule extends BaseModule {
  getDisplayName() { return '🎯 Module Name'; }
  getConfig() { return { /* config schema */ }; }
  async doConnect() { /* connection logic */ }
  async doDisconnect() { /* cleanup */ }
  getContextContribution() { return { /* context for actions */ }; }
}
```

### Config Schema Auto-Generation
Modules define config schemas, UI auto-generates:
```javascript
getConfig() {
  return {
    section_name: {
      field_name: {
        type: 'text'|'number'|'checkbox'|'select'|'range'|'textarea',
        label: 'Field Label',
        default: 'default_value',
        stored_as: 'localStorage_key', // optional
        options: [...], // for select
        min/max/step: ... // for range/number
      }
    }
  };
}
```

### Action Closure System
Actions use closure pattern with configuration parameters:
```javascript
export function actionName(configParam) {
  return (context, user, message) => {
    const { log, send_twitch, ws, llm, minecraft, obs } = context;
    // Implementation using config and context
  };
}
```

### Module Lifecycle
1. `register()` - Add module to manager
2. `initialize()` - Render UI (header, checkbox, config panel)
3. `connect()` - Establish connections, start services
4. `disconnect()` - Cleanup, close connections
5. `buildActionContext()` - Provide context for actions

### Persistence System
- Module enable/disable: `${moduleId}_enabled` in localStorage
- Config fields: Custom `stored_as` or `${moduleId}_${fieldName}`
- `getConfigValue(key, default)` - Schema-aware localStorage read
- `setConfigValue(key, value)` - Schema-aware localStorage write
- All config fields auto-persist on change
- Stored elements system: `[stored_as]` attribute in HTML

### Cross-Module Communication
Modules access each other via `this.moduleManager`:
```javascript
const chatModule = this.moduleManager.get('twitch-chat');
if (chatModule?.isConnected()) {
  chatModule.sendMessage('Hello');
}
```

### Context Building
- `ContextBuilder` creates unified context for actions
- Merges global state, helpers, and module contributions
- Actions always receive full context regardless of module state
- Modules handle disconnected state gracefully in their functions

## Data Flows

### Application Startup
1. `initialize()` - Cache DOM, create managers
2. `registerModules()` - Register all 8 modules
3. `moduleManager.initializeAll()` - Render all module UIs
4. `setupAuthentication()` - Check/request Twitch OAuth token
5. `connectModules()` - Connect enabled modules based on permissions
6. `setupActions()` - Configure chat actions via ActionRegistry
7. `initializeRewards()` - Create/fetch channel point rewards

### Chat Message Processing
1. IRC WebSocket receives PRIVMSG
2. TwitchChatModule parses tags and message
3. Message added to chat history buffer
4. ActionRegistry checks CHAT_ACTIONS rules (AND/OR logic)
5. If match: execute action closure with context, stop processing
6. If no match: forward to Minecraft (if connected) and play sound effect
7. LLM module monitors chat history and processes batch when threshold reached

### Channel Point Redemption
1. EventSub WebSocket receives redemption notification
2. TwitchEventSubModule looks up reward in customRewards map
3. Extract action closure from reward config
4. Build context with contextBuilder
5. Execute action: `await actionClosure(context, userName, userInput)`
6. Update redemption status: FULFILLED or CANCELED via API

### Preset Application
1. User selects preset from TwitchStreamModule dropdown
2. `applyPreset()` updates stream metadata (title, game, tags) via API
3. `_applyRewardConfig()` enables/disables rewards based on `rewards_active` array
4. Each reward updated via Twitch API PATCH request
5. TwitchEventSubModule refreshes rewards list display
6. Preset info display updated in UI

### Music Queue Flow
1. User adds song via reward or command
2. Module calls `musicQueue.smartAdd(url)`
3. Smart add logic: play immediately if queue empty, otherwise enqueue
4. Module sends command to Yandex Music tab via `sendCommandToOtherTabs('song', url)`
5. UserScript in Yandex Music tab receives command
6. Music player starts playing or queues the song
7. Player broadcasts `music_start` event with track info
8. Music Queue module receives event, updates current song name
9. On track end: `music_done` event triggers next song from queue

### LLM Chat Monitoring
1. Chat messages accumulate in buffer (last 50 messages)
2. Chat marker position tracks last processed message
3. When new messages arrive and LLM monitoring enabled:
4. LLM processing flag set (prevent concurrent processing)
5. Stage 1: "Should respond?" prompt sent to LLM with chat history
6. LLM returns decision: nothing, remember, respond, or silence_user
7. Stage 2 (if not "nothing"): Execute action based on decision
   - "remember": Add internal note to chat history (not sent to Twitch)
   - "respond": Generate response and send to Twitch chat
   - "silence_user": Request moderator action
8. Chat marker updated to current position
9. LLM processing flag cleared

### Echowire Voice Command Flow
1. Android device sends speech recognition via WebSocket
2. Echowire module receives incremental partials (diff-based)
3. Accumulates text until final_result message
4. Checks for trigger prefix: "работай" or "роботай"
5. If triggered: extract command text after prefix
6. Forward to Twitch Chat module as trusted superuser
7. Inject into chat history with special user-id: "echowire-superuser"
8. Notify message handlers (triggers actions, LLM monitoring)
9. LLM processes as normal chat message with elevated trust

### OBS Monitoring Flow
1. OBS module connects via WebSocket, authenticates with SHA-256
2. Receives Hello message, sends Identify with auth
3. On Identified: requests initial status (GetStreamStatus, GetRecordStatus)
4. Starts polling timer (default 2s interval)
5. Each poll: requests current status
6. On RequestResponse: updates internal state (streaming, recording, frames)
7. Checks for new dropped frames since last poll
8. If new drops detected and cooldown passed: triggers alert (sound + log)
9. Updates custom UI indicators (streaming icon, recording icon)
10. On events (StreamStateChanged, RecordStateChanged): updates state immediately

## UserScript Integration

**Teammater UserScript** (`teammater.js`):
- Matches: `https://music.yandex.ru/**` and `https://localhost:8443/**`
- Master tab detection: `window.i_am_a_master = true`
- Functions exposed:
  - `sendCommandToOtherTabs(command, data)` - Send commands to music tab
  - `registerReplyListener(eventName, callback)` - Listen for events
- Events:
  - `music_start` - Track info when song starts (contains track name)
  - `music_done` - URL of finished track
  - `status_reply` - Current player status
  - `song` - Play specific URL
  - `pause`, `resume`, `next` - Playback controls
  - `query_status` - Request current status
- Auto-play detection: automatically plays tracks when URL loaded directly
- Hook system: intercepts HTMLMediaElement.play() for event tracking

## Additional Files

### BRB Screen (`neco.html`)
Countdown timer overlay for streaming (OBS Browser Source compatible):
- **Background**: Selectable Neko Arc images via query param `?n=1` (eat) or `?n=2` (WC)
- **Timer**: Configurable via `?t=<seconds>` (default: 600s / 10 minutes)
- **Sound**: Random Neko Arc voice line on timer completion (3 OGG files)
- **Audio unlock**: Requires user interaction (click/key/touch) before sound plays
- **Assets**: `nekoarc/` directory contains images and sounds
- **Size**: ~1.5KB (minified), loads external assets
- **Usage**: `neco.html?n=2&t=300` → WC background, 5 minute timer

### WebSocket Format Documentation (`wsformat.md`)
Protocol specification for Echowire STT service communication:
- Message types: hello, partial_result, final_result, recognition_error
- Incremental partials: only new words sent (diff-based)
- Confidence scores and alternatives in final results
- Language detection (en-US, ru-RU)
- Timing metadata: session start/duration, speech start/duration
- Error code filtering: NO_MATCH (code 7) suppressed

## Environment & Requirements

### Technical Requirements
- Web-based client-side application
- Served via Caddy on localhost:8443 with TLS
- WebSocket connections:
  - Twitch IRC (wss://irc-ws.chat.twitch.tv:443)
  - Twitch EventSub (wss://eventsub.wss.twitch.tv/ws)
  - Minecraft/Minaret (ws://localhost:8765)
  - Echowire (wss://localhost:8443/echowire)
  - OBS Studio (ws://localhost:4455)
- HTTP connections:
  - Ollama LLM server (http://localhost:11434)
  - Twitch Helix API (https://api.twitch.tv/helix)
- Audio support for MP3 files
- Speech synthesis API integration
- UserScript manager (Tampermonkey/Greasemonkey) for Yandex Music
- Web Crypto API for OBS authentication

### Optional Services
- Minecraft server with Minaret plugin (localhost:8765)
- Ollama LLM server (localhost:11434)
- OBS Studio with obs-websocket plugin v5.x (localhost:4455)
- Android STT service via Echowire (localhost:8443/echowire)

### URL Parameters
- Default: Connects to authenticated user's channel
- `?channel=name` - Connect to specified channel (requires moderator rights)
- `?wipe` - Clear all localStorage (reset all settings)

### Module UI Structure
Each module's UI is auto-generated:
```
.module (container)
  .module-header
    .module-enable-checkbox (leftmost)
    .status-indicator (colored dot: green=connected, red=disconnected, gray=disabled)
    h3 (module title with emoji)
    .control-toggle (if hasControlPanel(), music note icon)
    .config-toggle (gear icon)
  .config-panel (collapsible)
    [auto-generated config fields from schema]
    [custom content from module's initialize()]
  .control-panel (if hasControlPanel(), modal or inline panel)
```

### State Management

**Global State:**
- `moduleManager` - Module registry and lifecycle
- `actionRegistry` - Chat/reward actions
- `contextBuilder` - Action execution context
- `currentUserId` - Authenticated user's Twitch ID
- `CHANNEL` - Target channel name
- `customRewards` - Reward map with actions and keys
- `throttle` - Per-user cooldown tracking for hate command
- `love_timer` - Love protection timer
- `llmProcessing` - LLM processing lock flag

**Persistent State (localStorage):**
- `twitch_token` - OAuth access token
- `twitch_client_id` - Twitch Client ID
- `${moduleId}_enabled` - Module enable state
- All config fields with `stored_as`
- `toplay` - Music queue (PersistentDeck)
- `nick_name` - Display name for rewards
- `twitch_username` - Twitch username
- `minecraft_username` - Minecraft username

## Configuration

### Stream Presets
Defined in `config.js` `DEFAULT_PRESETS`:
```javascript
{
  preset_name: {
    title: "Stream Title",
    game_id: "Twitch Category ID",
    tags: ["Tag1", "Tag2"],
    pinned_message: "Welcome message",
    rewards_active: ["reward_key1", "reward_key2"], // Rewards to enable
  }
}
```

Available presets:
- `loitering` - Pre-stream idle (509658 = Just Chatting)
- `coding` - Programming streams (1469308723 = Science & Technology)
- `gaming` - Minecraft gaming (27471 = Minecraft)
- `social` - Social streams with viewers
- `dooming` - DOOM gameplay (584 = DOOM)
- `talking` - Podcast mode (417752 = Talk Shows & Podcasts)

### Chat Actions
Defined in `config.js` `CHAT_ACTIONS`:
```javascript
[
  [action(), /pattern1/, /pattern2/], // All patterns must match (AND)
  [action(), /pattern/], // Single pattern
  // Rules are OR-combined (any matching rule triggers)
]
```

Example:
```javascript
[
  [ban(), /viewers/i, /nezhna.+\.com/i], // Ban spam with "viewers" + domain
  [mute(30), /zhopa/i, /spam/i],        // 30s timeout for profanity
  [voice(), /^!voice\s+(.+)/i],         // TTS command
]
```

### Channel Point Rewards
Defined in `config.js` `getDefaultRewards()` (dynamic based on nickname):
```javascript
{
  reward_key: {
    title: "Reward Title",
    cost: 100,
    prompt: "What this reward does",
    background_color: "#FF6B6B",
    is_enabled: true,
    is_user_input_required: false,
    is_global_cooldown_enabled: true,
    global_cooldown_seconds: 60,
    action: actionClosure(), // From actions.js
  }
}
```

Available rewards:
- `hate` - Lightning strike (300 pts, 30s cooldown)
- `love` - Protection from hate (200 pts)
- `music` - Song request (150 pts, requires URL)
- `vote_skip` - Vote skip song (30 pts)
- `playing` - Show current song (30 pts)
- `voice` - TTS message (50 pts, 60s cooldown, requires text)
- `neuro` - Ask LLM (100 pts, 45s cooldown, requires text)

## Feature Checklist

### Core Features
- [x] Modular architecture with 8 independent modules
- [x] OAuth2 authentication and token management
- [x] Twitch IRC chat integration
- [x] Channel point rewards system with auto-creation
- [x] Stream preset management with auto-apply
- [x] Reward enable/disable based on preset
- [x] Message moderation with configurable rules (AND/OR logic)
- [x] Multiple message types (chat, whisper, action, announcement)
- [x] Minecraft server integration
- [x] Yandex Music queue with cross-tab control
- [x] LLM chat monitoring and responses
- [x] OBS Studio integration with stream monitoring
- [x] Android STT via Echowire WebSocket
- [x] Audio playback and TTS with language detection
- [x] Moderator rights enforcement
- [x] UI auto-generation from config schemas
- [x] Persistent configuration via localStorage
- [x] Cross-module communication
- [x] Test buttons for rewards and actions
- [x] Volume control for audio playback

### UI Features
- [x] Module enable/disable checkboxes
- [x] Collapsible config panels (gear icon)
- [x] Control modals for complex UIs (music queue)
- [x] Status indicators (colored dots: green/red/gray)
- [x] Custom indicators for OBS (streaming/recording status)
- [x] Preset info display
- [x] Rewards list with TEST buttons
- [x] Dynamic content updates (song names, queue, OBS stats)
- [x] No scrollbars in config panels (use main scroll)
- [x] Compact module headers
- [x] Left-aligned checkboxes
- [x] Stored elements system with defaults

### Integration Features
- [x] UserScript for Yandex Music control
- [x] Master tab detection for cross-tab communication
- [x] Music queue persistence with localStorage
- [x] Current song synchronization from player
- [x] Smart queueing: play immediately or enqueue
- [x] Vote skip system
- [x] LLM dynamic model selection
- [x] LLM two-stage workflow (decision + action)
- [x] LLM internal memory system ("remember" action)
- [x] Minecraft auto-reconnection
- [x] IRC tags parsing for message IDs
- [x] User ID caching
- [x] Echowire voice command injection
- [x] OBS frame drop monitoring and alerts
- [x] OBS WebSocket 5.x authentication

### Developer Features
- [x] Easy module creation (extend BaseModule)
- [x] Schema-based config generation
- [x] Action closure pattern with configuration
- [x] Context builder for actions
- [x] Module manager for lifecycle
- [x] Cross-module access via manager
- [x] Comprehensive logging (log vs systemLog)
- [x] Error handling and fallbacks
- [x] Test mode for rewards
- [x] Graceful handling of disconnected modules
- [x] Auto-reconnection patterns
- [x] WebSocket event-driven architecture

## Recent Changes (from git log)

Recent commits show focus on:
1. **Auth error handling improvements** - Better OAuth error handling
2. **Volume control** - Added volume parameter to mp3() function
3. **Module logging** - systemLog for module-level messages
4. **OBS frame drop alerts** - Monitoring stream health
5. **Hate/love logic fixes** - Protection timer logic corrected
6. **Minaret context fixes** - sendCommandMinaret context bug resolved
7. **Documentation** - Comprehensive CLAUDE.md and SPEC.md creation
8. **Architecture refactor** - Complete modular architecture implementation

## Development Notes

### Adding New Modules
1. Create `modules/<name>/module.js` extending `BaseModule`
2. Implement required methods: `getDisplayName()`, `getConfig()`, `doConnect()`, `doDisconnect()`
3. Optionally implement: `getContextContribution()`, `hasControlPanel()`, custom UI in `initialize()`
4. Register in `index.js` `registerModules()` function
5. Add to module count in documentation

### Action Development
1. Define action in `actions.js` using closure pattern
2. Accept configuration parameters in outer function
3. Return closure with signature: `(context, user, message) => result`
4. Use context for dependencies (ws, llm, obs, etc.)
5. Handle disconnected state gracefully
6. Return false on failure, true/void on success

### Configuration Management
- Use `stored_as` for custom localStorage keys
- Provide `default` values in config schema
- Use `getConfigValue(key, default)` for reads
- Use `setConfigValue(key, value)` for writes
- Auto-persistence on UI change events

### Cross-Module Dependencies
- Always check module connection state: `module?.isConnected()`
- Use optional chaining: `moduleManager.get('module-id')?.method()`
- Provide fallback behavior when modules unavailable
- Context includes all enabled modules regardless of connection state
- Functions should handle disconnected state internally
