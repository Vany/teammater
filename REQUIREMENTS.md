# Teammater Requirements

## Core Functionality
- [x] Twitch chat integration via IRC WebSocket
- [x] OAuth2 authentication with Twitch
- [x] Chat command processing — but ONLY the rules in CHAT_ACTIONS (config.js).
  Currently: !voice plus two content-matched moderation rules. !hello, !reset,
  !chat, !announce and !me have no handler and were dropped in the rewrite
- [x] Local WebSocket connection to "minarert" server (localhost:8765)
- [x] Audio playback for various sound effects
- [x] Speech synthesis for !voice commands
- [x] Minecraft server integration via commands
- [x] Cross-tab communication for music control
- [x] Regular chat messages. NOT implemented: private whispers, action
  messages and announcements — no /helix/whispers or /helix/chat/announcements
  call exists in the modular codebase
- [x] Automated message moderation with configurable pattern matching

## Control Panel Extension
- [x] Right-side control panel with stream management tools
- [x] Combobox for stream presets (title, category, tags)
- [x] Stream information update functionality via Twitch API
- [x] Built-in preset system (no localStorage storage)
- [x] Automatic preset restoration on page load using stored_as="stream_preset"

## Pinned Message Management
NOT WIRED UP. `twitch-stream/module.js` has `pinMessageById()` and every preset
carries a `pinned_message`, but nothing calls it: `applyPreset()` only writes the
text into the UI. Sending the message and capturing its id — the step that would
give `pinMessageById()` an id to pin — does not exist in the modular codebase.
- [ ] Fully automatic pinned message management on login
- [x] Preset-specific pinned messages defined for different stream types (data only)
- [ ] Default fallback pinned message when no preset active
- [x] UI display of pinned message content in preset info
- [ ] IRC tags integration for message ID capture and automatic pinning

## Channel Point Rewards System
- [x] Custom Reward Creation: Automated setup of 7 default interactive rewards
- [x] Lightning Strike (500 points): Summons lightning bolt in Minecraft + sound effect
- [x] Heal Streamer (200 points): Gives health boost + confirmation message
- [x] Song Request (300 points): User input for Yandex Music URLs + queue integration
- [x] Robot Voice (150 points): Text-to-speech with robotic voice effect
- [x] Ask Neuro (100 points): Send message to LLM and get AI response in chat
- [x] Vote Skip (30 points): Vote to skip current song
- [x] What's Playing (30 points): Display current track information
- [x] Reward Management UI: Automatic initialization and display on websocket connection
- [x] Automatic Redemption Handling: Real-time execution of reward actions
- [x] Status Management: Automatic fulfillment/cancellation of redemptions
- [x] Error Handling: Comprehensive validation and fallback mechanisms
- [x] Rate Limiting: Per-user limits and global cooldowns for each reward
- [x] Integration: Seamless connection with existing Minecraft and audio systems
- [x] Preset-Based Reward Control: Automatic enable/disable rewards based on stream preset
  * Loitering/Coding presets: voice, music, vote_skip, playing, neuro enabled (visible)
  * Gaming preset: voice, hate, love enabled (visible)
  * Dooming preset: all rewards disabled (hidden)
  * Default state (no preset): all rewards disabled (hidden)
  * Uses `is_enabled` flag for complete visibility control (hidden when disabled)

## Enhanced Messaging System
- [ ] Action Messages (!me command) — no handler; the IRC ACTION format is only
      PARSED on incoming messages, never sent
- [ ] Colored Announcements (!announce command) — no handler and no
      /helix/chat/announcements call. Would also need the
      moderator:manage:announcements scope, which is not requested
- [ ] Private Whispers (apiWhisper) — the function does not exist; see the
      Technical Requirements note below, which this line used to contradict
- [ ] Public Mentions (whisper) — likewise absent; actions use `@name` inline
      in an ordinary send_twitch() message instead
- [x] Regular Chat (send_twitch): Standard chat messages
- [x] User ID caching system for efficient API calls
- [x] Automatic fallback mechanisms for reliability
- [x] Comprehensive error handling and logging

## Yandex Music Integration
- [x] UserScript for cross-tab music control and queue management
- [x] Automatic track playback when URLs are opened
- [x] Enhanced button targeting with specific CSS selectors
- [x] Track end detection and queue advancement
- [x] Master/client architecture for cross-tab communication
- [x] Robust URL pattern matching for Yandex Music tracks
- [x] Auto-play fallback for main Yandex Music page ("Play My Vibe")
- [x] Error handling and logging for music operations

## Message Moderation System
- [x] Configurable ban rules via BAN_RULES constant in index.js
- [x] Rule-based pattern matching with AND/OR logic:
  * Outer array: rules combined by OR (any rule triggers action)
  * Inner array: first element is action, rest are regexes combined by AND (all must match)
- [x] Three moderation actions:
  * `mute(seconds)`: Timeout user for specified duration
  * `ban()`: Permanently ban user and delete all messages
  * `delete()`: Delete only the matched message
- [x] IRC tags parsing for user-id and message-id extraction
- [x] Automatic action execution via Twitch API
- [x] Skip moderation for bot's own messages and broadcaster
- [x] Comprehensive logging of all moderation actions
- [x] Stops message processing after moderation action (no mp3, no forwarding)
- [x] Production rule: Ban users posting "viewers" + "nezhna*.com" spam

## Technical Requirements
- OAuth scopes: chat:read, chat:edit, channel:manage:broadcast, moderator:manage:chat_settings, user:manage:whispers, channel:manage:redemptions, channel:read:redemptions, moderator:manage:banned_users, moderator:manage:chat_messages
- WebSocket connections: Twitch IRC, local minarert server
- HTTP connections: Ollama LLM server (localhost:11434)
- IRC tags capability for message ID capture and user ID extraction
- Audio support for MP3 files
- Speech synthesis API integration
- Responsive UI layout with control panel
- Built-in preset configuration (modify DEFAULT_PRESETS in source)
- Twitch messaging: send_twitch() only. whisper() and apiWhisper() do not exist
  in the modular codebase — actions that called apiWhisper() threw TypeError
  and now address the viewer in chat instead
- Pinned message system: data and API method only, not wired up (see above)
- Channel Point Rewards system with automatic redemption handling and async action support
- Message moderation system with configurable ban rules (BAN_RULES)
- LLM integration: Ollama-compatible API for AI-powered chat responses
- **Moderator Rights Enforcement — NOT IMPLEMENTED.** None of the following
  exists in the modular codebase. There is no `/helix/moderation/moderators`
  call anywhere, no `?channel=` parameter, and EventSub and Minecraft connect
  unconditionally. Do not treat any of it as a safety gate:
  * ~~Checks moderator status via Twitch API `/helix/moderation/moderators`~~
  * ~~EventSub connection (channel point rewards) disabled if no moderator rights~~
  * ~~Minecraft connector (minaret WebSocket) disabled if no moderator rights~~
  * ~~Logs warning messages when connecting without permissions~~
  * ~~Always allows EventSub and Minecraft for authenticated user's own channel~~

## Environment
- Web-based client-side application
- Served by the Rust server in `server/` on localhost:8443 (TLS) and :8442
  (plain HTTP). Caddy was replaced and is no longer used
- Connects to localhost:8765 WebSocket server (Minecraft)
- Connects to localhost:11434 HTTP server (Ollama LLM)
- Channel defaults to authenticated user's channel (override via the Twitch Chat
  module config field `twitch_channel` — NOT a URL parameter)
- Twitch API integration for stream management and chat settings
- Pinned message workflow with IRC tags — planned, not implemented
- UserScript manager required (Tampermonkey/Greasemonkey) for Yandex Music integration
- EventSub WebSocket for real-time channel point redemptions
- Ollama server required for LLM features (optional, graceful degradation)
