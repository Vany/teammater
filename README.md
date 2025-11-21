# Teammater - Twitch Stream Bot

Advanced Twitch streaming assistant with Minecraft integration, channel point rewards, automated moderation, and music control.

## Features

### Stream Management
- **Preset System**: Quick-switch stream configurations (title, category, tags, pinned messages)
- **Channel Point Rewards**: 6 interactive rewards with automatic redemption handling
- **Automatic Pinned Messages**: Context-aware chat pins for different stream types
- **Real-time Status**: Visual indicators for all connections

### Chat Moderation
- **Pattern-Based Banning**: Configurable regex rules with AND/OR logic
- **Three Action Types**: Ban, timeout (mute), or delete messages
- **Automatic Execution**: Real-time moderation via Twitch API
- **Smart Filtering**: Skips bot's own messages, comprehensive logging

### Minecraft Integration
- **Bidirectional Communication**: WebSocket connection to Minecraft server
- **Channel Point Actions**: Lightning strikes, health boosts triggered by viewers
- **Chat Bridge**: Forward messages between Twitch and Minecraft
- **Command Execution**: Direct server commands from Twitch chat

### Music Control
- **Yandex Music Integration**: Queue-based song requests via channel points
- **Cross-Tab Control**: UserScript manages playback across browser tabs
- **Vote Skip System**: Democratic song skipping (3 votes required)
- **Now Playing**: Display current track on demand

### Enhanced Messaging
- **Private Whispers**: True private messages via Twitch API
- **Action Messages**: /me style grayed messages
- **Colored Announcements**: Official Twitch announcement boxes
- **Public Mentions**: @username fallback for compatibility

## Prerequisites

- Modern web browser (Chrome, Firefox, Edge)
- Twitch account with **moderator or broadcaster** status on your channel
- Caddy or similar web server for HTTPS serving (localhost:8443 by default)
- Minecraft server with WebSocket plugin (optional, for game integration)
  * Recommended: [Minaret](https://github.com/Vany/minaret) - WebSocket bridge for Minecraft server
- UserScript manager (Tampermonkey/Greasemonkey) for music features
  * Required for Yandex Music integration via included UserScript

## Installation

### 1. Register Twitch Application

1. Go to https://dev.twitch.tv/console/apps
2. Click "Register Your Application"
3. Fill in:
   - Name: `teammater` (or your choice)
   - OAuth Redirect URL: `https://localhost:8443`
   - Category: Chat Bot
4. Save and copy the **Client ID**

### 2. Configure Bot

Edit `index.js`:

```javascript
const CLIENT_ID = "your_client_id_here";  // Replace with your Client ID
```

**Note:** Channel is configured via URL parameter (see Usage section).

### 3. Set Up Web Server

Using Caddy (example Caddyfile):

```
localhost:8443 {
    tls internal
    root * /path/to/teammater
    file_server
}
```

Start Caddy:
```bash
caddy run
```

### 4. First Authentication

1. Open https://localhost:8443 in your browser
2. Accept the self-signed certificate warning
3. You'll be prompted for Twitch Client ID (enter once, stored in localStorage)
4. Click "Authenticate with Twitch" (redirects to Twitch)
5. Accept all requested permissions
6. Bot will connect automatically after redirect

### 5. Minecraft Integration (Optional)

The bot can communicate with Minecraft via WebSocket for interactive features.

**Recommended Setup: Minaret**

1. Install [Minaret](https://github.com/Vany/minaret) - a WebSocket bridge for Minecraft
2. Configure it to listen on `ws://localhost:8765`
3. Start your Minecraft server with Minaret plugin
4. Bot will auto-connect and show 🟢 Minaret status

**Features when connected:**
- Lightning strikes from channel points
- Health boosts from channel points
- Chat bridge between Twitch and Minecraft
- Custom commands executed on server

### 6. Music Integration (Optional)

Install UserScript manager:
- Chrome/Edge: Install Tampermonkey extension
- Firefox: Install Greasemonkey or Tampermonkey

Add the included UserScript:
1. Open `yandex-music-userscript.js` from project folder
2. Copy contents
3. Create new script in Tampermonkey
4. Paste and save
5. Navigate to music.yandex.ru (script activates automatically)

**What it does:**
- Cross-tab communication for music queue
- Auto-play songs from channel point requests
- Track end detection for queue advancement
- "Now Playing" and "Vote Skip" functionality

## Configuration

### Stream Presets

Edit `DEFAULT_PRESETS` in `index.js`:

```javascript
const DEFAULT_PRESETS = {
  preset_key: {
    title: "Your stream title",
    game_id: "509658",  // Twitch category ID
    tags: ["English", "Educational"],
    pinned_message: "Welcome message",
    rewards_active: ["voice", "music"]  // Visible rewards
  }
};
```

**Find Category IDs:**
Search at https://www.streamweasels.com/tools/twitch-category-id-finder/

### Channel Point Rewards

Edit `DEFAULT_REWARDS` in `index.js`:

```javascript
const DEFAULT_REWARDS = {
  reward_key: {
    title: "⚡ Reward Name",
    cost: 100,
    prompt: "What this reward does",
    background_color: "#FF6B6B",
    is_enabled: true,
    action: "reward_key"  // Must match key
  }
};
```

Rewards auto-create on first connection.

### Moderation Rules

Edit `BAN_RULES` in `index.js`:

```javascript
const BAN_RULES = [
  [ban(), /badword/i],                      // Ban if contains "badword"
  [mute(600), /spam/i, /link/i],            // 10min timeout if both match
  [delete(), /mild/i],                      // Delete message only
];
```

**Rule Logic:**
- Outer array: OR (any rule triggers)
- Inner array: AND (all patterns must match)
- First element: action (`ban()`, `mute(seconds)`, `delete()`)
- Rest: regex patterns (case-insensitive with `/i` flag)

## Usage

### Channel Selection

The bot connects to a channel specified via URL parameter:

**Default channel (vanyserezhkin):**
```
https://localhost:8443/
```

**Custom channel:**
```
https://localhost:8443/?channel=your_channel_name
```

The selected channel will be logged on connection: `🎯 Connecting to channel: #your_channel_name`

### Starting the Bot

1. Open https://localhost:8443
2. Bot connects automatically if authenticated
3. Check status indicators:
   - 🟢 Twitch Chat - IRC connection
   - 🟢 Minaret - Local server
   - 🟢 Stream API - Twitch API

### Applying Presets

1. Select preset from dropdown in control panel
2. Bot automatically:
   - Updates stream title/category/tags
   - Enables/disables channel point rewards
   - Sends and pins preset message

### Chat Commands

**User Commands:**
- `!voice <text>` - Text-to-speech (if reward redeemed)
- `!song <url>` - Queue Yandex Music track (if reward redeemed)
- Standard messages trigger audio + Minecraft forwarding

**Broadcaster Commands:**
- `!me <text>` - Send action message
- `!announce [color] <message>` - Colored announcement (blue/green/orange/purple/primary)
- `!chat <sound>` - Play sound effect (boo, creeper, tentacle, woop)
- `!love_vany` - Protection mode + action message
- `!hate_vany` - Lightning strike in Minecraft (with cooldown)

### Channel Point Rewards

**Default Rewards:**
- **⚡ Hate Vany** (300pts): Lightning strike + sound
- **💚 Love Vany** (200pts): Health boost + protection
- **🎵 Music Request** (150pts): Queue song from Yandex Music
- **🤖 Voice** (50pts): Custom TTS message
- **🎵 Skip Song** (30pts): Vote to skip (3 votes needed)
- **What's Playing** (30pts): Display current track

Rewards auto-enable/disable based on active preset.

## Troubleshooting

### Re-Authentication Required

**Symptoms:** 401 errors in console, features not working

**Solution:**
1. Open browser console (F12)
2. Run: `localStorage.removeItem('twitch_token')`
3. Refresh page
4. Re-authenticate when prompted

This is required when:
- OAuth scopes changed
- Token expired
- First setup

### Rewards Not Working

**Check:**
1. EventSub connected? (check console logs: "✅ EventSub connected")
2. Rewards created? (check "Channel Point Rewards" section in UI)
3. Correct OAuth scopes? Re-authenticate if recently updated

**Manual Fix:**
1. Go to Twitch Creator Dashboard > Channel Points
2. Verify rewards exist and are enabled
3. Check reward costs match viewer points

### Music Not Playing

**Check:**
1. UserScript installed and enabled in Tampermonkey?
2. Yandex Music tab open in browser?
3. URL format correct? (https://music.yandex.ru/album/*/track/*)

**UserScript Setup:**
- File: `yandex-music-userscript.js` in project root
- Install via Tampermonkey: Dashboard → "+" → Paste script
- Verify it's enabled: Should show green indicator in extension
- Script auto-activates on music.yandex.ru pages

**How it works:**
- Bot sends song URL via localStorage message
- UserScript opens URL in new tab (or navigates existing)
- Auto-clicks play button when track loads
- Detects track end and notifies bot for queue advancement

**Valid URL Example:**
```
https://music.yandex.ru/album/123456/track/789012
```

**Debug:**
- Open browser console on music.yandex.ru
- Should see: "Music control script loaded"
- Check for localStorage events when song queued

### Minecraft Not Responding

**Check:**
1. Minaret WebSocket server running on localhost:8765?
2. "Minaret" status indicator green?
3. Server configured to accept WebSocket connections?

**Setup Minaret:**
1. Download from https://github.com/Vany/minaret
2. Follow installation instructions in Minaret repo
3. Ensure it's configured for `ws://localhost:8765`
4. Check Minaret logs for connection attempts

**Alternative:**
If not using Minaret, ensure your custom WebSocket server:
- Accepts connections on localhost:8765
- Handles JSON messages: `{"command": "...", "message": "...", "user": "..."}`
- Responds to bot messages appropriately

### Moderation Not Triggering

**Check:**
1. BAN_RULES not empty?
2. Patterns using `/pattern/i` format (with slashes)?
3. Check console for "🔨 BANNED" / "⏱️ MUTED" / "🗑️ DELETED" logs

**Test Pattern:**
```javascript
// Test in browser console:
const testMsg = "test message with badword";
const pattern = /badword/i;
console.log(pattern.test(testMsg));  // Should return true
```

## Architecture

```
┌─────────────────┐
│   Browser UI    │
│   (index.html)  │
└────────┬────────┘
         │
    ┌────▼────┐
    │index.js │◄──── OAuth Token (localStorage)
    └────┬────┘
         │
    ┌────▼────────────────────────┐
    │  WebSocket Connections      │
    ├─────────────────────────────┤
    │ IRC: chat.twitch.tv:443     │
    │ EventSub: eventsub.wss...   │
    │ Minaret: localhost:8765     │
    └─────────────────────────────┘
         │
    ┌────▼────────────────────────┐
    │    Twitch Helix API         │
    ├─────────────────────────────┤
    │ /channels - Stream info     │
    │ /chat - Settings & mod      │
    │ /whispers - Private msgs    │
    │ /channel_points - Rewards   │
    │ /moderation - Ban/timeout   │
    └─────────────────────────────┘
```

## API Rate Limits

Twitch API limits (per client ID):
- 800 requests per minute (burst)
- 120 sustained requests per minute

Bot implements:
- User ID caching (reduce API calls)
- Reward caching (no repeated fetches)
- Efficient batch operations

## Security Notes

- OAuth token stored in localStorage (browser-only)
- HTTPS required for OAuth redirect
- Moderator scopes grant powerful permissions
- BAN_RULES processed server-side (Twitch API)
- No token in source code (prompted on first run)

## Support

For issues or questions:
1. Check console logs (F12 → Console tab)
2. Verify authentication (green status indicators)
3. Review configuration in index.js
4. Test patterns in browser console

**External Components:**
- Minecraft integration: See [Minaret documentation](https://github.com/Vany/minaret)
- Music control: Check `yandex-music-userscript.js` comments for technical details
- Tampermonkey setup: https://www.tampermonkey.net/faq.php

## License

This is a personal streaming bot. Modify freely for your own channel.

**Required Attribution:**
- Twitch API - https://dev.twitch.tv
- Yandex Music - https://music.yandex.ru

## Technical Details

**Built with:**
- Vanilla JavaScript (no frameworks)
- Twitch IRC WebSocket (chat)
- Twitch EventSub WebSocket (redemptions)
- Twitch Helix API (REST)
- Web Speech API (TTS)
- HTML5 Audio API (sounds)

**Browser Compatibility:**
- Chrome 90+
- Firefox 88+
- Edge 90+
- Safari 14+ (limited testing)

**File Structure:**
```
teammater/
├── index.html                    # UI layout
├── index.css                     # Styling
├── index.js                      # Core logic
├── yandex-music-userscript.js   # Tampermonkey script for Yandex Music
├── mp3/                         # Sound effects
│   ├── icq.mp3
│   ├── ahhh.mp3
│   ├── boo.mp3
│   └── ...
├── REQUIREMENTS.md              # Feature specs
├── MEMO.md                      # Implementation notes
└── README.md                    # This file
```

**External Dependencies:**
- [Minaret](https://github.com/Vany/minaret) - Minecraft WebSocket bridge (optional)
- Tampermonkey/Greasemonkey - For yandex-music-userscript.js (optional)
