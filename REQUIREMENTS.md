# Teammater Requirements

## Core Functionality
- [x] Twitch chat integration via IRC WebSocket
- [x] OAuth2 authentication with Twitch
- [x] Chat command processing (!hello, !reset, !voice, !chat, !announce, !me, etc.)
- [x] Local WebSocket connection to "minarert" server (localhost:8765)
- [x] Audio playback for various sound effects
- [x] Speech synthesis for !voice commands
- [x] Minecraft server integration via commands
- [x] Cross-tab communication for music control
- [x] Multiple message types: regular chat, private whispers, action messages, announcements
- [x] Automated message moderation with configurable pattern matching

## Control Panel Extension
- [x] Right-side control panel with stream management tools
- [x] Combobox for stream presets (title, category, tags)
- [x] Stream information update functionality via Twitch API
- [x] Built-in preset system (no localStorage storage)

## Pinned Message Management
- [x] Fully automatic pinned message management on login 
- [x] Preset-specific pinned messages for different stream types
- [x] Default fallback pinned message when no preset active
- [x] UI display of pinned message content in preset info
- [x] IRC tags integration for message ID capture and automatic pinning

## Channel Point Rewards System
- [x] Custom Reward Creation: Automated setup of 6 default interactive rewards
- [x] Lightning Strike (500 points): Summons lightning bolt in Minecraft + sound effect
- [x] Heal Streamer (200 points): Gives health boost + confirmation message
- [x] Song Request (300 points): User input for Yandex Music URLs + queue integration
- [x] Robot Voice (150 points): Text-to-speech with robotic voice effect
- [x] Vote Skip (30 points): Vote to skip current song
- [x] What's Playing (30 points): Display current track information
- [x] Reward Management UI: Automatic initialization and display on websocket connection
- [x] Automatic Redemption Handling: Real-time execution of reward actions
- [x] Status Management: Automatic fulfillment/cancellation of redemptions
- [x] Error Handling: Comprehensive validation and fallback mechanisms
- [x] Rate Limiting: Per-user limits and global cooldowns for each reward
- [x] Integration: Seamless connection with existing Minecraft and audio systems
- [x] Preset-Based Reward Control: Automatic enable/disable rewards based on stream preset
  * Loitering/Coding presets: voice, music, vote_skip, playing enabled (visible)
  * Gaming preset: voice, hate, love enabled (visible)
  * Dooming preset: all rewards disabled (hidden)
  * Default state (no preset): all rewards disabled (hidden)
  * Uses `is_enabled` flag for complete visibility control (hidden when disabled)

## Enhanced Messaging System
- [x] Action Messages (!me command): Grayed/italicized messages using IRC ACTION format
- [x] Colored Announcements (!announce command): Official Twitch announcements with color options
- [x] Private Whispers (apiWhisper): True private messages via Twitch API with fallback
- [x] Public Mentions (whisper): @username format for public notifications
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
- IRC tags capability for message ID capture and user ID extraction
- Audio support for MP3 files
- Speech synthesis API integration
- Responsive UI layout with control panel
- Built-in preset configuration (modify DEFAULT_PRESETS in source)
- Twitch messaging: send_twitch(), whisper() (public mentions), and apiWhisper() (private) functions
- Fully automatic pinned message system with API integration
- Channel Point Rewards system with automatic redemption handling
- Message moderation system with configurable ban rules (BAN_RULES)

## Environment
- Web-based client-side application
- Served via Caddy on localhost:8443 with TLS
- Connects to localhost:8765 WebSocket server
- Channel configurable via URL parameter (?channel=name, default: vanyserezhkin)
- Twitch API integration for stream management and chat settings
- Fully automatic pinned message workflow with IRC tags
- UserScript manager required (Tampermonkey/Greasemonkey) for Yandex Music integration
- EventSub WebSocket for real-time channel point redemptions
