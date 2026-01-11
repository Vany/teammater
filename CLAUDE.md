# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

### Key Design Patterns

1. **BaseModule Pattern** - All modules extend `BaseModule`:
   ```javascript
   export class MyModule extends BaseModule {
     getDisplayName() { return '🎯 Module Name'; }
     getConfig() { return { /* config schema */ }; }
     async doConnect() { /* connection logic */ }
     async doDisconnect() { /* cleanup */ }
     getContextContribution() { return { /* context for actions */ }; }
   }
   ```

2. **Config Schema Auto-Generation** - Modules define config schemas, UI auto-generates:
   ```javascript
   getConfig() {
     return {
       section_name: {
         field_name: {
           type: 'text'|'number'|'checkbox'|'select'|'range'|'textarea',
           label: 'Field Label',
           default: 'default_value',
           stored_as: 'localStorage_key', // optional, defaults to moduleId_fieldName
           options: [...], // for select
           min/max/step: ... // for range/number
         }
       }
     };
   }
   ```

3. **Action Closure System** - Actions use closure pattern:
   ```javascript
   export function actionName(configParam) {
     return (context, user, message) => {
       const { log, send_twitch, ws, llm, minecraft } = context;
       // Implementation using config and context
     };
   }
   ```

4. **Module Lifecycle**:
   - `register()` - Add module to manager, set moduleId, logger, moduleManager reference
   - `initialize()` - Render UI (header, checkbox, config panel, control modal)
   - `connect()` - Establish connections, start services
   - `disconnect()` - Cleanup, close connections
   - `buildActionContext()` - Provide context for action execution

5. **Persistence System** - All config fields with `stored_as` auto-persist:
   - Module enable/disable checkboxes: `${moduleId}_enabled`
   - Config fields: custom `stored_as` or `${moduleId}_${fieldName}`
   - `getConfigValue(key)` reads from localStorage with schema-aware key resolution
   - `setConfigValue(key, value)` writes to localStorage

6. **Cross-Module Communication** - Modules access each other via `this.moduleManager`:
   ```javascript
   const chatModule = this.moduleManager.get('twitch-chat');
   if (chatModule?.isConnected()) {
     chatModule.sendMessage('Hello');
   }
   ```

### Data Flow

**Application Startup:**
1. `initialize()` - Cache DOM, create managers (ModuleManager, ActionRegistry, ContextBuilder)
2. `registerModules()` - Register all 6 modules with manager
3. `moduleManager.initializeAll()` - Render all module UIs
4. `setupAuthentication()` - Check/request Twitch OAuth token
5. `connectModules()` - Connect enabled modules based on permissions
6. `setupActions()` - Configure chat actions and reward actions
7. `initializeRewards()` - Create/fetch channel point rewards

**Module Connection Flow:**
1. Check if module is enabled (checkbox state in localStorage)
2. Call `module.connect()` which calls `doConnect()`
3. Module updates status indicator (green = connected, red = disconnected)
4. Module contributes context to `ContextBuilder` via `getContextContribution()`

**Chat Message Processing:**
1. IRC WebSocket receives PRIVMSG
2. TwitchChatModule parses tags and message
3. Message added to chat history buffer
4. ActionRegistry checks CHAT_ACTIONS rules (moderation + commands)
5. If match: execute action closure with context
6. If no match: forward to Minecraft and play sound effect
7. LLM module monitors chat history and responds when appropriate

**Channel Point Redemption Flow:**
1. EventSub WebSocket receives redemption notification
2. TwitchEventSubModule looks up reward in `customRewards` map
3. Extract action closure from reward config
4. Build context with `contextBuilder.build()`
5. Execute action: `await actionClosure(context, userName, userInput)`
6. Update redemption status: FULFILLED or CANCELED

**Preset Application Flow:**
1. User selects preset from TwitchStreamModule dropdown
2. `applyPreset()` updates stream metadata (title, game, tags)
3. `_applyRewardConfig()` enables/disables rewards based on `preset.rewards_active`
4. Each reward updated via Twitch API
5. TwitchEventSubModule refreshes rewards list display
6. Preset info display updated

### State Management

**Global State (index.js):**
- `moduleManager` - Central module registry and lifecycle manager
- `actionRegistry` - Chat actions and reward actions registry
- `contextBuilder` - Builds unified context for action execution
- `currentUserId` - Authenticated user's Twitch ID
- `CHANNEL` - Target channel name
- `throttle` - Per-user cooldown timestamps
- `love_timer` - Love protection activation timestamp
- `customRewards` - Map of reward_id → {reward data, action closure, key}
- `llmProcessing` - Flag preventing concurrent LLM processing

**Module State** - Each module maintains its own state:
- `this.connected` - Connection status
- `this.enabled` - Enable/disable state (from checkbox)
- `this.ui` - UI element references (container, statusIndicator, configPanel, etc.)
- Module-specific state (e.g., `chatHistory`, `queue`, `currentSongName`)

**Persistent State (localStorage):**
- `twitch_token` - OAuth access token
- `twitch_client_id` - Twitch application Client ID
- `${moduleId}_enabled` - Module enable/disable state
- All config fields with `stored_as` attribute
- `toplay` - Music queue (PersistentDeck)

### UserScript Integration

**Teammater UserScript** (`teammater.js`):
- Matches: `https://music.yandex.ru/**` and `https://localhost:8443/**`
- Provides cross-tab communication between Teammater and Yandex Music
- Master tab detection: `window.i_am_a_master = true` (set in index.js)
- Functions exposed to master tab:
  - `sendCommandToOtherTabs(command, data)` - Send commands to music tab
  - `registerReplyListener(eventName, callback)` - Listen for events from music tab
- Events:
  - `music_start` - Track info when song starts (includes artist/title)
  - `music_done` - URL of finished track
  - `status_reply` - Current player status (trackInfo, etc.)
  - `song` - Play specific URL

**Music Queue Cross-Tab Flow:**
1. User adds song via Music Queue module
2. Module calls `sendCommandToOtherTabs('song', url)`
3. UserScript in Yandex Music tab receives command
4. Music player starts playing the song
5. Player broadcasts `music_start` event with track info
6. Music Queue module receives event and updates current song name

## Development Commands

### Running the Application

**Prerequisites:**
- Caddy web server (or similar) for HTTPS on localhost:8443
- Twitch Developer Application registered at dev.twitch.tv/console
- Optional: Ollama running on localhost:11434 for LLM features
- Optional: Minecraft server with Minaret plugin on localhost:8765
- UserScript manager (Tampermonkey/Greasemonkey) with `teammater.js` installed

**Start Caddy:**
```bash
caddy run
```

**Access Application:**
```
https://localhost:8443/
```

**Connect to Another Channel (as moderator):**
```
https://localhost:8443/?channel=channelname
```

**Wipe localStorage (reset all state):**
```
https://localhost:8443/?wipe
```

### Adding a New Module

1. **Create module file** `modules/my-module/module.js`:
```javascript
import { BaseModule } from '../base-module.js';

export class MyModule extends BaseModule {
  constructor() {
    super();
    // Initialize module-specific state
  }

  getDisplayName() {
    return '🎯 My Module';
  }

  getConfig() {
    return {
      connection: {
        url: {
          type: 'text',
          label: 'Connection URL',
          default: 'ws://localhost:8080',
          stored_as: 'my_module_url',
        },
      },
    };
  }

  async doConnect() {
    const url = this.getConfigValue('url', 'ws://localhost:8080');
    // Connection logic
    this.updateStatus(true);
  }

  async doDisconnect() {
    // Cleanup logic
    this.updateStatus(false);
  }

  getContextContribution() {
    return {
      myModule: {
        doSomething: this.doSomething.bind(this),
      },
    };
  }
}
```

2. **Register module** in `index.js`:
```javascript
import { MyModule } from './modules/my-module/module.js';

function registerModules() {
  // ... existing modules
  moduleManager.register('my-module', new MyModule());
}
```

3. **Optionally add control panel** (modal):
```javascript
hasControlPanel() {
  return true;
}

renderControlPanel() {
  const container = document.createElement('div');
  // Build modal content
  return container;
}
```

### Configuration Changes

**Adding a New Channel Point Reward:**

1. Add reward config to `config.js` in `getDefaultRewards()`:
```javascript
export function getDefaultRewards() {
  const NICK_NAME = getNickName();
  
  return {
    my_reward: {
      title: "🎯 Reward Title",
      cost: 100,
      prompt: "What this reward does",
      background_color: "#FF6B6B",
      is_enabled: true,
      is_user_input_required: false,
      action: myAction(),
    },
  };
}
```

2. Create action in `actions.js`:
```javascript
export function myAction(configParam = "default") {
  return (context, user, message) => {
    const { log, send_twitch } = context;
    log(`✅ My action executed by ${user}`);
    return true; // Return false to CANCEL redemption
  };
}
```

**Adding a Chat Action:**

Add to `CHAT_ACTIONS` in `config.js`:
```javascript
export const CHAT_ACTIONS = [
  [ban(), /spam/i, /badword/i], // Ban if BOTH patterns match
  [myAction(), /^!mycommand\s+(.+)/i], // Custom command
];
```

**Adding a Stream Preset:**

Add to `DEFAULT_PRESETS` in `config.js`:
```javascript
export const DEFAULT_PRESETS = {
  my_preset: {
    title: "Stream Title",
    game_id: "509658", // Twitch category ID
    tags: ["English", "Educational"],
    pinned_message: "Welcome message",
    rewards_active: ["voice", "music"], // Reward keys to enable
  },
};
```

## Important Implementation Notes

### Module Manager Reference

All modules have access to the ModuleManager via `this.moduleManager`. This allows:
- Getting other modules: `this.moduleManager.get('module-id')`
- Checking module status: `otherModule?.isConnected()`
- Calling module methods: `otherModule.doSomething()`

This is set during module registration in `ModuleManager.register()`.

### Config Value Resolution

The `getConfigValue(key, defaultValue)` method is schema-aware:
1. Searches config schema for field with name `key`
2. If field has `stored_as` property, uses that as localStorage key
3. Otherwise uses `${moduleId}_${key}` pattern
4. Falls back to `defaultValue` if no stored value

This allows custom localStorage keys while maintaining consistent API.

### Preset-Reward Integration

When a preset is applied via TwitchStreamModule:
1. Stream metadata updated (title, game, tags)
2. `_applyRewardConfig(preset.rewards_active)` called
3. Gets TwitchEventSubModule reference via `this.moduleManager.get('twitch-eventsub')`
4. Iterates through `customRewards` map
5. Each reward has a `key` property (e.g., "voice", "music")
6. If key is in `preset.rewards_active`, enable reward via API
7. Otherwise, disable reward
8. Refresh rewards list display

### Music Queue-UserScript Sync

Music Queue module syncs song names via UserScript:
1. On connect, sends `query_status` command to request current song
2. Listens for `status_reply` event with current track info
3. Listens for `music_start` event when new song starts
4. Updates `this.currentSongName` and refreshes control panel display
5. Control panel finds status display by `id="musicQueueStatus"` for updates

### IRC Message ID Capture for Pinning

Pinning messages requires capturing message ID from IRC echo:
1. Bot sends message via TwitchChatModule
2. IRC server echoes message back with `@msg-id=...` tag
3. Extract message ID from tags
4. Call TwitchStreamModule's `pinMessageById(messageId)`

### Action Context Building

Actions receive context built by ContextBuilder:
```javascript
const context = {
  // From modules (via getContextContribution)
  llm, minecraft, musicQueue, streamModule, // etc.
  
  // From global state
  currentUserId, CHANNEL, throttle, love_timer,
  
  // Helper functions
  log, send_twitch, apiWhisper, speak, mp3,
};
```

When adding new global state or helpers, update `setupContextBuilder()` in index.js.

### Module UI Structure

Each module's UI is auto-generated:
```
.module (container)
  .module-header
    .module-enable-checkbox (order: -1, appears first)
    .status-indicator (colored dot)
    h3 (module title)
    .control-toggle (if hasControlPanel(), appears before gear)
    .config-toggle (gear button)
  .config-panel (collapsible)
    [auto-generated config fields from schema]
    [custom content from module's initialize()]
```

Control modals are appended to `document.body` and shown/hidden with display property.

## Common Gotchas

1. **Module not connecting**: Check if module is enabled (checkbox) and has required permissions (moderator/broadcaster).

2. **Config values not persisting**: Ensure field has `stored_as` attribute in schema, or rely on auto-generated key.

3. **Actions can't access module**: Modules must provide methods via `getContextContribution()` to make them available in action context.

4. **Preset not changing rewards**: Check that reward `key` property matches value in `preset.rewards_active` array. Keys are set during reward initialization.

5. **Music controls not working**: Verify UserScript is installed and loaded on both tabs (check console for "✅ yandexmusic nexter loaded"). Master tab should show "⛑️ MASTER".

6. **Module methods failing**: Always check module connection status before calling methods: `if (module?.isConnected()) { ... }`

7. **UI not updating**: For dynamic content (like rewards list, song name), modules must manually update DOM elements. Store references during `initialize()` and update them when data changes.

8. **Cross-module calls undefined**: Ensure target module is registered and initialized before trying to access it. Use optional chaining: `this.moduleManager.get('module')?.method()`.

9. **Stored elements not restoring**: The `initializeStoredElements()` function only runs on elements present at page load. Dynamically created elements need manual localStorage handling.

10. **Action closures losing context**: Always use arrow functions or `.bind(this)` when passing module methods to action registry or context builder.
