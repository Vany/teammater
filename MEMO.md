# Teammater Implementation Memo

## Current Analysis
- Single-page web application with Twitch chat integration
- Uses IRC WebSocket for chat connectivity (wss://irc-ws.chat.twitch.tv:443)
- Current OAuth scopes: ["chat:read", "chat:edit", "channel:manage:broadcast", "moderator:manage:chat_settings"] - UPDATED
- Local WebSocket server integration at localhost:8765 for "minarert"
- Audio system with MP3 playback and speech synthesis
- Command system for chat interactions and Minecraft server control
- Cross-tab Yandex Music integration via UserScript with improved targeting

## CURRENT IMPLEMENTATION STATUS ✅

### COMPLETED FEATURES
- ✅ Right-side control panel with dark theme
- ✅ Stream presets combobox with 3 default presets (loitering, coding, gaming)
- ✅ Real-time connection status indicators for Twitch Chat and Minaret server
- ✅ Stream information retrieval and display
- ✅ Stream settings application from presets
- ✅ Built-in preset system (no localStorage storage)
- ✅ Error handling and user feedback via log system
- ✅ Responsive layout maintaining existing functionality
- ✅ Twitch messaging functions: send_twitch() and whisper()
- ✅ **FULLY AUTOMATIC** pinned message system with IRC tags

### PINNED MESSAGE SYSTEM ✅
- [x] Added pinned_message field to all presets:
  * loitering: "🐽 Говорим по русски и по английски! Russian & English welcome! 🧱✨"
  * coding: "🐽 Programming session! Questions welcome! 🧱 Записываемся на YouTube ✨"
  * gaming: "🧱 Minecraft stream! Join the server! 🐽 Chat commands: !hello !voice !song ✨"
- [x] Added DEFAULT_PINNED_MESSAGE: "🐽 Welcome to the stream! 🧱 Russian & English welcome! ✨"
- [x] Updated preset info UI to show pinned messages
- [x] **AUTOMATIC pinning on login** - checks existing pin, auto-pins if none
- [x] **AUTOMATIC preset pinning** when applying presets
- [x] Implemented IRC tags capability for message ID capture
- [x] Full API integration for automatic pinning workflow

## TECHNICAL IMPLEMENTATION NOTES

### **AUTOMATIC** Pinned Message Flow
1. **IRC Tags Enabled**: `CAP REQ :twitch.tv/tags twitch.tv/commands` for message ID capture
2. **On login**: Checks existing pinned message, auto-sends and pins DEFAULT_PINNED_MESSAGE if none
3. **When applying preset**: Auto-sends and pins preset's pinned_message
4. **Message ID Capture**: IRC tags provide `@msg-id=` for our sent messages
5. **Auto-pin**: Uses captured message ID with `/helix/chat/settings` API to pin automatically

### API Endpoints Used
- GET /helix/chat/settings?broadcaster_id={id}&moderator_id={id} - check current pinned messages
- PATCH /helix/chat/settings?broadcaster_id={id}&moderator_id={id} - pin message by ID
- GET /helix/channels?broadcaster_id={id} - get current stream info
- PATCH /helix/channels?broadcaster_id={id} - update stream info

### OAuth Scopes Required
- chat:read - read chat messages
- chat:edit - send chat messages  
- channel:manage:broadcast - update stream information
- moderator:manage:chat_settings - manage chat settings including pinned messages

## CURRENT STATE
All requested functionality is IMPLEMENTED with **FULL AUTOMATION**:
- ✅ **Complete automatic pinned message management**
- ✅ **Auto-pin on login** - checks existing, pins default if none
- ✅ **Auto-pin when applying presets** - pins preset-specific messages
- ✅ **IRC tags integration** for message ID capture
- ✅ **Full Twitch API integration** for automatic pinning workflow
- ✅ UI integration showing pinned message content
- ✅ Complete stream management integration
- ✅ **Message moderation system** with configurable pattern-based rules

## RECENT IMPROVEMENTS ✅

### Yandex Music Integration Enhancements
- [x] **Improved button targeting**: Enhanced CSS selector for playback button:
  * Target: `'header[class^="TrackModal_header_"] button[aria-label="Playback"]'`
  * More specific targeting to avoid clicking wrong elements
- [x] **Fixed URL regex pattern**: Corrected track URL matching for auto-play
- [x] **Enhanced auto-play reliability**: Better timing and fallback mechanisms
- [x] **UI cleanup**: Removed unnecessary "Get Current Info" button for streamlined interface

### Twitch Communication Enhancements
- [x] **Enhanced whisper functionality**: Implemented both private and public messaging
  * `apiWhisper(user, message)` - TRUE private whispers via Twitch API
  * `whisper(user, message)` - Public mentions (@username) as fallback
  * Added `user:manage:whispers` OAuth scope for private whispers
  * User ID caching system for efficient API calls
  * Automatic fallback to public mentions if private whispers fail
  * Old deprecated IRC whispers completely replaced
- [x] **Action Messages**: IRC /me command support for grayed/italicized messages
  * `sendAction(message)` - Sends grayed action messages like "* streamer does something"
  * Uses IRC ACTION format: `\x01ACTION message\x01`
  * Perfect for roleplay and system-like messages
- [x] **Colored Announcements**: Official Twitch announcement system
  * `sendAnnouncement(message, color)` - Sends colored announcement boxes
  * Colors: blue, green, orange, purple, primary
  * Requires moderator permissions, falls back to action messages
  * !announce command with optional color parameter
- [x] **Enhanced Chat Commands**: Added new interactive commands
  * `!me <text>` - Send action message
  * `!announce [color] <message>` - Send colored announcement
  * Updated `!love_vany` to include action message
  * Enhanced test() function to demonstrate all message types

### Channel Point Rewards Implementation
- [x] **Complete Rewards System**: Full Channel Point Rewards integration
  * `createCustomReward(key)` - Creates rewards via Twitch API
  * `getCustomRewards()` - Fetches existing rewards for management
  * `handleRewardRedemption(redemption)` - Processes viewer redemptions
  * `updateRedemptionStatus(id, status)` - Marks redemptions as fulfilled/canceled
  * `initializeRewards()` - Automatic setup of default reward set
- [x] **EventSub WebSocket Integration**: Real-time redemption processing
  * `connectEventSub()` - Connects to wss://eventsub.wss.twitch.tv/ws
  * Automatic session establishment and subscription to redemption events
  * Real-time processing of viewer redemptions as they happen
  * Automatic reconnection handling for reliability
- [x] **Default Reward Suite**: 4 pre-configured interactive rewards
  * **⚡ Lightning Strike** (500 pts): Minecraft lightning + sound + action message
  * **💚 Heal Streamer** (200 pts): Health boost + confirmation + sound
  * **🎵 Song Request** (300 pts): User input validation + queue integration
  * **🤖 Robot Voice** (150 pts): TTS with robotic voice settings
- [x] **Smart Configuration**: Rate limiting, cooldowns, user input validation
  * Per-user stream limits to prevent spam
  * Global cooldowns for balanced gameplay
  * Input validation for song URLs and text content
  * Automatic error handling and user feedback
- [x] **UI Integration**: Control panel section for reward management
  * Initialize Rewards button with loading state
  * List Rewards with status display
  * Test redemption functionality for development
  * Real-time reward status monitoring

### Technical Implementation Updates
- [x] **Cross-tab communication**: Robust UserScript integration with master/client architecture
- [x] **Improved error handling**: Better safeguards for button click failures
- [x] **Audio hooks**: Automatic track end detection for queue management
- [x] **Queue management**: PersistentDeck system for song queue handling
- [x] **Code organization**: Complete separation of concerns with external files
  * CSS extracted into index.css (169 lines)
  * JavaScript extracted into index.js (1334 lines)
  * HTML structure only in index.html (98 lines)
  * Perfect separation following web development best practices

## CURRENT TASK
- [x] Remove Channel Point Rewards control buttons from UI (Initialize Rewards, List Rewards, Test Lightning)
- [x] Automatically initialize and show rewards list on websocket connection
- [x] Update automatic initialization flow to include rewards display

### Channel Point Rewards UI Improvements ✅
- [x] **Removed manual control buttons**: Eliminated Initialize Rewards, List Rewards, and Test Lightning buttons from UI
- [x] **Automatic initialization**: Rewards system now automatically initializes on websocket connection
- [x] **Automatic display**: Rewards list automatically displays in UI after initialization
- [x] **Streamlined workflow**: No manual intervention required - everything happens automatically when connecting to Twitch
- [x] **Event listener cleanup**: Removed unused button event handlers from JavaScript
- [x] **UI simplification**: Channel Point Rewards section now contains only the automatically populated rewards list

## CURRENT TASK - Reward State Management per Preset
- [x] Add rewards_config to DEFAULT_PRESETS defining which rewards are active per preset
  * loitering: voice, music, vote_skip, playing enabled | hate, love disabled
  * coding: voice, music, vote_skip, playing enabled | hate, love disabled
  * gaming: voice, hate, love enabled | music, vote_skip, playing disabled
  * dooming: all rewards disabled
  * default (no preset): all rewards disabled
- [x] Implement updateRewardState(rewardId, isEnabled) to PATCH reward state via API
- [x] Implement applyRewardConfig(presetKey) to update all reward states based on preset
- [x] Call applyRewardConfig() from applyStreamPreset() when preset is applied
- [x] Use is_enabled flag (not is_paused) - rewards are completely hidden when disabled

### Implementation Details
- `updateRewardState(rewardId, isEnabled)`: Updates individual reward enabled state via PATCH API
- `applyRewardConfig(presetKey)`: Applies preset's reward configuration, enabling/disabling all rewards
- Called automatically when preset is applied in `applyStreamPreset()`
- Default state (no preset): all rewards disabled via `applyRewardConfig(null)` on initialization
- Rewards are completely hidden when disabled (is_enabled=false), not just grayed out

## MESSAGE MODERATION SYSTEM IMPLEMENTATION ✅

### Ban Rules Configuration
- [x] BAN_RULES constant in index.js for easy configuration
- [x] Rule structure: `[action, regex1, regex2, ...]`
  * First element: action function (mute(seconds), ban(), delete())
  * Remaining elements: regex patterns (ALL must match - AND logic)
  * Rules processed in order, first match wins (OR logic between rules)
- [x] Example configuration with comments explaining structure

### Action Functions
- [x] `mute(seconds)`: Returns timeout action with duration
- [x] `ban()`: Returns permanent ban action
- [x] `delete()` / `delete_`: Returns message deletion action
- [x] Action objects have type and optional duration fields

### Implementation Functions
- [x] `parseIrcTags(rawMessage)`: Extracts IRC tags from message
  * Parses @tag=value;tag2=value2 format
  * Returns tags object with user-id and message id
- [x] `checkBanRules(message)`: Tests message against all rules
  * Returns action if any rule matches (OR logic)
  * All patterns in rule must match (AND logic)
  * Returns null if no rules match
- [x] `executeModerationAction(action, userId, messageId, username, message)`: Executes moderation
  * POST /helix/moderation/bans for timeout/ban with data.user_id and data.duration
  * DELETE /helix/moderation/chat for message deletion with message_id
  * Comprehensive logging of all actions
  * Error handling with fallback logging

### Message Handler Integration
- [x] Parse IRC tags at message reception
- [x] Extract user-id and message-id from tags
- [x] Check ban rules before processing message
- [x] Skip moderation for bot's own messages (userId === currentUserId)
- [x] Skip moderation if BAN_RULES is empty
- [x] Execute moderation action if rule matches
- [x] Stop message processing after moderation (return early)
- [x] Log all moderation actions with username and message content

### OAuth Scopes Added
- [x] moderator:manage:banned_users - Required for ban/timeout actions
- [x] moderator:manage:chat_messages - Required for message deletion

## CRITICAL NOTES
- **Re-authentication required** due to new OAuth scopes: `moderator:manage:banned_users` and `moderator:manage:chat_messages` for moderation system
- **Fully automatic pinning** - no manual intervention needed
- **Message ID capture via IRC tags** - sophisticated implementation
- All existing functionality preserved and enhanced
- Complete error handling and logging for all operations
- **Production-ready automatic pinning system**
- **Yandex Music integration** requires UserScript manager (Tampermonkey/Greasemonkey)
- **Private whispers** require user verification status on Twitch in some cases
- **Channel Point Rewards** now work with real-time EventSub WebSocket integration ✅
- **EventSub automatically connects** on bot startup and handles reconnections ✅
- **Rewards UI now fully automatic** - no manual buttons needed ✅
- **Message moderation** executes automatically on pattern match, stopping further processing ✅
