# Teammater Implementation Memo

## Architecture Overview
Single-page web application with Twitch integration and Minecraft server communication.

**Core Components:**
- Twitch IRC WebSocket (wss://irc-ws.chat.twitch.tv:443) for chat connectivity
- Twitch Helix API for stream management, chat settings, and moderation
- EventSub WebSocket (wss://eventsub.wss.twitch.tv/ws) for real-time redemptions
- Local WebSocket server (localhost:8765) for Minecraft "minarert" integration
- Audio system: MP3 playback + Speech Synthesis API
- Cross-tab communication for Yandex Music control via UserScript

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
- index.js - Application logic (1400+ lines)
- yandex-music-userscript.js - Cross-tab music control

**Key Classes:**
- PersistentDeck - localStorage-backed queue/stack

**Global State:**
- ws - IRC WebSocket connection
- minarert - Local WebSocket connection
- eventSubSocket - EventSub connection
- currentUserId - Broadcaster ID from OAuth
- userIdCache - Username -> ID mapping
- customRewards - Reward ID -> config mapping
- songQueue - PersistentDeck for music
- throttle - Command rate limiting

## Current Configuration
- Channel: Configurable via URL parameter (?channel=name, default: vanyserezhkin)
- Redirect URI: window.location.origin
- Minarert: ws://localhost:8765
- Served: https://localhost:8443 (Caddy TLS)
- Ban rule: viewers + nezhna*.com spam
