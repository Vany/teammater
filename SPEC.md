# Teammater Specification

## Project Overview

Teammater is a Twitch streaming bot with a modular architecture that integrates:
- Twitch IRC chat (WebSocket)
- Twitch EventSub (channel point redemptions)
- Twitch Helix API (stream management, moderation)
- Minecraft server integration via WebSocket (Minaret)
- Yandex Music queue system (cross-tab communication via UserScript)
- Local LLM integration (Ollama) for AI-powered chat features

The bot connects to a Twitch channel (default: authenticated user's own channel, or specify `?channel=name` in URL) and provides interactive features through channel point rewards, chat commands, and automated moderation.

## Architecture

### Modular Architecture

The application uses a clean modular architecture with six independent modules:

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

**Modules (`modules/`):**

1. **LLM Module** (`modules/llm/module.js`)
   - Ollama LLM integration for chat monitoring and responses
   - Dynamic model selection with auto-fetch from Ollama API
   - Configurable: base URL, model, system prompt, temperature, max tokens
   - Two-stage decision process for chat responses

2. **Music Queue Module** (`modules/music-queue/module.js`)
   - Cross-tab Yandex Music control via UserScript
   - Queue management with PersistentDeck (localStorage)
   - Vote skip system, auto-play on empty queue
   - Control modal with queue display and management buttons
   - Syncs current song name from music player

3. **Minecraft Module** (`modules/minecraft/module.js`)
   - WebSocket integration with Minecraft server (Minaret plugin)
   - Send chat messages and execute game commands
   - Auto-reconnection with configurable delay

4. **Twitch Chat Module** (`modules/twitch-chat/module.js`)
   - IRC WebSocket connection to Twitch chat
   - Message parsing with tags (user-id, message-id)
   - Chat history buffer for LLM monitoring
   - Configurable: IRC URL, reconnect delay, nickname, username
   - Includes Twitch Client ID configuration

5. **Twitch EventSub Module** (`modules/twitch-eventsub/module.js`)
   - WebSocket connection for channel point redemptions
   - Reward management with TEST buttons
   - Redemption status updates (FULFILLED/CANCELED)
   - Rewards list display in config panel

6. **Twitch Stream Module** (`modules/twitch-stream/module.js`)
   - Stream metadata management (title, game, tags)
   - Preset system for quick stream setup
   - Auto-enables/disables rewards based on preset
   - Pinned message management
   - Preset info display in config panel

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
- [x] Chat command processing (!hello, !reset, !voice, !chat, !announce, !me, etc.)
- [x] Multiple message types:
  - Regular chat messages
  - Private whispers (via API)
  - Public mentions (@username)
  - Action messages (/me format, grayed/italicized)
  - Colored announcements (official Twitch announcements)
- [x] User ID caching system for efficient API calls
- [x] Chat history buffer for LLM monitoring
- [x] IRC tags parsing for user-id and message-id extraction

### Channel Point Rewards System
- [x] Custom Reward Creation: Automated setup of default interactive rewards
- [x] Default Rewards:
  - Lightning Strike (500 points): Minecraft lightning + sound
  - Heal Streamer (200 points): Health boost + confirmation
  - Song Request (300 points): Yandex Music URL + queue
  - Robot Voice (150 points): TTS with robotic voice
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

**Minecraft (Minaret WebSocket):**
- [x] WebSocket connection to localhost:8765
- [x] Send chat messages to Minecraft
- [x] Execute game commands (lightning, heal, etc.)
- [x] Auto-reconnection with configurable delay

**Yandex Music (UserScript):**
- [x] Cross-tab communication between Teammater and Yandex Music
- [x] Queue management with localStorage persistence
- [x] Automatic track playback from URLs
- [x] Track end detection and queue advancement
- [x] Vote skip system
- [x] Current song name synchronization
- [x] Master/client architecture for cross-tab communication

**LLM (Ollama):**
- [x] HTTP connection to localhost:11434
- [x] Chat monitoring and response system
- [x] Dynamic model selection
- [x] Two-stage decision process (should respond? what to say?)
- [x] Configurable system prompt, temperature, max tokens
- [x] Integration with channel point rewards (Ask Neuro)

### Moderator Rights Enforcement
- [x] Automatic detection when connected to non-default channel (via `?channel=name`)
- [x] Checks moderator status via Twitch API `/helix/moderation/moderators`
- [x] EventSub connection disabled if no moderator rights
- [x] Minecraft connector disabled if no moderator rights
- [x] Warning messages logged when connecting without permissions
- [x] Always allows EventSub and Minecraft for authenticated user's own channel

### Audio & TTS
- [x] Audio playback for sound effects (MP3 files)
- [x] Speech synthesis API integration
- [x] Configurable voice selection (Russian/English)
- [x] Language detection for automatic voice selection
- [x] Volume control ("loud" checkbox)

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
Actions use closure pattern:
```javascript
export function actionName(configParam) {
  return (context, user, message) => {
    const { log, send_twitch, ws, llm, minecraft } = context;
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
- `getConfigValue(key)` - Schema-aware localStorage read
- `setConfigValue(key, value)` - Schema-aware localStorage write
- All config fields auto-persist on change

### Cross-Module Communication
Modules access each other via `this.moduleManager`:
```javascript
const chatModule = this.moduleManager.get('twitch-chat');
if (chatModule?.isConnected()) {
  chatModule.sendMessage('Hello');
}
```

## Data Flows

### Application Startup
1. `initialize()` - Cache DOM, create managers
2. `registerModules()` - Register all 6 modules
3. `moduleManager.initializeAll()` - Render all module UIs
4. `setupAuthentication()` - Check/request Twitch OAuth token
5. `connectModules()` - Connect enabled modules based on permissions
6. `setupActions()` - Configure chat actions and reward actions
7. `initializeRewards()` - Create/fetch channel point rewards

### Chat Message Processing
1. IRC WebSocket receives PRIVMSG
2. TwitchChatModule parses tags and message
3. Message added to chat history buffer
4. ActionRegistry checks CHAT_ACTIONS rules
5. If match: execute action closure with context
6. If no match: forward to Minecraft and play sound effect
7. LLM module monitors chat history and responds when appropriate

### Channel Point Redemption
1. EventSub WebSocket receives redemption notification
2. TwitchEventSubModule looks up reward in customRewards map
3. Extract action closure from reward config
4. Build context with contextBuilder
5. Execute action: `await actionClosure(context, userName, userInput)`
6. Update redemption status: FULFILLED or CANCELED

### Preset Application
1. User selects preset from TwitchStreamModule dropdown
2. `applyPreset()` updates stream metadata (title, game, tags)
3. `_applyRewardConfig()` enables/disables rewards based on preset
4. Each reward updated via Twitch API
5. TwitchEventSubModule refreshes rewards list display
6. Preset info display updated

### Music Queue Flow
1. User adds song via Music Queue module
2. Module calls `sendCommandToOtherTabs('song', url)`
3. UserScript in Yandex Music tab receives command
4. Music player starts playing the song
5. Player broadcasts `music_start` event with track info
6. Music Queue module updates current song name

## UserScript Integration

**Teammater UserScript** (`teammater.js`):
- Matches: `https://music.yandex.ru/**` and `https://localhost:8443/**`
- Master tab detection: `window.i_am_a_master = true`
- Functions exposed:
  - `sendCommandToOtherTabs(command, data)` - Send commands to music tab
  - `registerReplyListener(eventName, callback)` - Listen for events
- Events:
  - `music_start` - Track info when song starts
  - `music_done` - URL of finished track
  - `status_reply` - Current player status
  - `song` - Play specific URL

## Environment & Requirements

### Technical Requirements
- Web-based client-side application
- Served via Caddy on localhost:8443 with TLS
- WebSocket connections:
  - Twitch IRC (wss://irc-ws.chat.twitch.tv:443)
  - Twitch EventSub (wss://eventsub.wss.twitch.tv/ws)
  - Minecraft/Minaret (ws://localhost:8765)
- HTTP connections:
  - Ollama LLM server (http://localhost:11434)
  - Twitch Helix API (https://api.twitch.tv/helix)
- Audio support for MP3 files
- Speech synthesis API integration
- UserScript manager (Tampermonkey/Greasemonkey) for Yandex Music

### Optional Services
- Minecraft server with Minaret plugin (localhost:8765)
- Ollama LLM server (localhost:11434)

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
    .status-indicator (colored dot)
    h3 (module title)
    .control-toggle (if hasControlPanel(), music note icon)
    .config-toggle (gear icon)
  .config-panel (collapsible)
    [auto-generated config fields from schema]
    [custom content from module's initialize()]
```

### State Management

**Global State:**
- `moduleManager` - Module registry and lifecycle
- `actionRegistry` - Chat/reward actions
- `contextBuilder` - Action execution context
- `currentUserId` - Authenticated user's Twitch ID
- `CHANNEL` - Target channel name
- `customRewards` - Reward map with actions and keys

**Persistent State (localStorage):**
- `twitch_token` - OAuth access token
- `twitch_client_id` - Twitch Client ID
- `${moduleId}_enabled` - Module enable state
- All config fields with `stored_as`
- `toplay` - Music queue (PersistentDeck)

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

### Chat Actions
Defined in `config.js` `CHAT_ACTIONS`:
```javascript
[
  [action(), /pattern1/, /pattern2/], // All patterns must match (AND)
  [action(), /pattern/], // Single pattern
  // Rules are OR-combined (any matching rule triggers)
]
```

### Channel Point Rewards
Defined in `config.js` `getDefaultRewards()`:
```javascript
{
  reward_key: {
    title: "Reward Title",
    cost: 100,
    prompt: "What this reward does",
    background_color: "#FF6B6B",
    is_enabled: true,
    is_user_input_required: false,
    action: actionClosure(), // From actions.js
  }
}
```

## Feature Checklist

### Core Features
- [x] Modular architecture with 6 independent modules
- [x] OAuth2 authentication and token management
- [x] Twitch IRC chat integration
- [x] Channel point rewards system with auto-creation
- [x] Stream preset management with auto-apply
- [x] Reward enable/disable based on preset
- [x] Message moderation with configurable rules
- [x] Multiple message types (chat, whisper, action, announcement)
- [x] Minecraft server integration
- [x] Yandex Music queue with cross-tab control
- [x] LLM chat monitoring and responses
- [x] Audio playback and TTS
- [x] Moderator rights enforcement
- [x] UI auto-generation from config schemas
- [x] Persistent configuration via localStorage
- [x] Cross-module communication
- [x] Test buttons for rewards and actions

### UI Features
- [x] Module enable/disable checkboxes
- [x] Collapsible config panels (gear icon)
- [x] Control modals for complex UIs (music queue)
- [x] Status indicators (colored dots)
- [x] Preset info display
- [x] Rewards list with TEST buttons
- [x] Dynamic content updates (song names, queue)
- [x] No scrollbars in config panels (use main scroll)
- [x] Compact module headers
- [x] Left-aligned checkboxes

### Integration Features
- [x] UserScript for Yandex Music control
- [x] Master tab detection for cross-tab communication
- [x] Music queue persistence with localStorage
- [x] Current song synchronization from player
- [x] Auto-play when queue is empty
- [x] Vote skip system
- [x] LLM dynamic model selection
- [x] Minecraft auto-reconnection
- [x] IRC tags parsing for message IDs
- [x] User ID caching

### Developer Features
- [x] Easy module creation (extend BaseModule)
- [x] Schema-based config generation
- [x] Action closure pattern
- [x] Context builder for actions
- [x] Module manager for lifecycle
- [x] Cross-module access via manager
- [x] Comprehensive logging
- [x] Error handling and fallbacks
- [x] Test mode for rewards
