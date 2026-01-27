# Teammater - Twitch Stream Bot

Advanced modular Twitch streaming assistant with AI-powered chat monitoring, Minecraft integration, channel point rewards, automated moderation, and music control.

**Quick Start:** Authenticate once and the bot connects to your own channel automatically. No configuration needed.

## Features

### AI-Powered Chat Monitoring (NEW)
- **LLM Integration**: Local Ollama LLM monitors chat and responds naturally
- **Smart Decision Making**: LLM decides when to respond, remember, or moderate
- **Configurable Actions**: LLM can trigger custom actions (mute, voice TTS, etc.)
- **Context-Aware**: Understands chat history and broadcaster context
- **Privacy-First**: Runs locally on your machine, no cloud API calls

### Stream Management
- **Preset System**: Quick-switch stream configurations (title, category, tags, pinned messages)
- **Channel Point Rewards**: 7 interactive rewards with automatic redemption handling
- **Automatic Pinned Messages**: Context-aware chat pins for different stream types
- **Real-time Status**: Visual indicators for all 8 independent modules

### Chat Moderation
- **Pattern-Based Actions**: Configurable regex rules with AND/OR logic
- **Three Action Types**: Ban, timeout (mute), or delete messages
- **LLM-Assisted Moderation**: AI can request moderator actions when needed
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

### Required
- Modern web browser (Chrome, Firefox, Edge)
- Twitch account with **moderator or broadcaster** status on your channel
- Caddy or similar web server for HTTPS serving (localhost:8443 by default)

### Optional (for enhanced features)
- **[Ollama](https://ollama.ai)** - Local LLM server for AI chat monitoring
  * Download and install Ollama
  * Pull a model: `ollama pull llama3.2` (or any other model)
  * Server runs on localhost:11434 by default
  * Enables AI-powered chat responses and moderation
- **Minecraft server** with WebSocket plugin (for game integration)
  * Recommended: [Minaret](https://github.com/Vany/minaret) - WebSocket bridge for Minecraft server
  * Enables lightning strikes, health boosts, chat bridge
- **UserScript manager** (Tampermonkey/Greasemonkey) for music features
  * Required for Yandex Music integration via included UserScript
  * Enables song requests, vote skip, now playing

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

On first run, you'll be prompted to enter your Twitch Client ID. This is stored in localStorage and persists across sessions.

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

### 6. LLM Integration (Optional)

The bot can use a local LLM for intelligent chat monitoring and responses.

**Setup Ollama:**

1. Install Ollama from https://ollama.ai
2. Pull a model (recommended: llama3.2):
   ```bash
   ollama pull llama3.2
   ```
3. Server runs automatically on localhost:11434
4. Enable in bot UI: Check "🤖 LLM (Ollama)" module
5. Configure system prompt and enable chat monitoring

**Features when connected:**
- Automatic chat monitoring with context awareness
- Natural conversation responses (no command prefix needed)
- Memory system for remembering information
- AI-assisted moderation decisions
- Custom actions via LLM_ACTIONS (mute users, voice TTS, etc.)

**Configuration:**
- Base URL: http://localhost:11434 (default)
- Model: Select from dropdown (populated from Ollama)
- System Prompt: Define bot personality and behavior
- Temperature: 0.7 (default, higher = more creative)
- Max Tokens: 256 (response length limit)

### 7. Music Integration (Optional)

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

### Modular Architecture

The bot uses 8 independent modules with enable/disable checkboxes:

1. **🤖 LLM (Ollama)** - AI chat monitoring and responses
2. **💬 Twitch Chat** - IRC chat connection
3. **🎁 Twitch EventSub** - Channel point redemptions
4. **📺 Twitch Stream** - Stream metadata and presets
5. **🎵 Music Queue** - Yandex Music integration
6. **🎮 Minecraft** - Game server WebSocket
7. **📡 Echowire** - Android STT (Speech-to-Text)
8. **🎬 OBS** - Stream monitoring and control

Each module has its own config panel (gear icon) with schema-based UI generation.

### LLM Actions System

Define custom actions the LLM can trigger in `config.js`:

```javascript
export const LLM_ACTIONS = {
  "mute for 10 minute": mute(10),
  "Say by voice": voice(),
  // Add more actions as needed
};
```

**How it works:**
- LLM receives available actions in its system prompt
- When LLM responds with `action: mute, reason: spamming`, the action executes
- First word matching: "mute" matches "mute for 10 minute"
- Reason is passed as the third parameter to the action

### Stream Presets

Edit `DEFAULT_PRESETS` in `config.js`:

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

### Chat Actions

Define pattern-based actions in `config.js`:

```javascript
export const CHAT_ACTIONS = [
  [ban(), /badword/i, /spam/i],     // Ban if both patterns match
  [mute(30), /profanity/i],         // 30s timeout
  [voice(), /^!voice\s+(.+)/i],     // TTS command (captured text used)
];
```

**Action Types:**
- `ban()` - Permanent ban
- `mute(seconds)` - Temporary timeout
- `delete_()` - Delete message only
- `voice()` - Text-to-speech
- Any action from `actions.js`

### Channel Point Rewards

Edit rewards via `getDefaultRewards()` in `config.js`:

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

**Default Rewards:**
- **⚡ Hate [Streamer]** (300pts) - Lightning strike + sound
- **💚 Love [Streamer]** (200pts) - Health boost + protection
- **🎵 Music Request** (150pts) - Queue Yandex Music song
- **🧠 Ask Neuro** (100pts) - LLM-powered chat response
- **🤖 Voice** (50pts) - Custom TTS message
- **🎵 Skip Song** (30pts) - Vote to skip current track
- **What's Playing** (30pts) - Display current song info

## Usage

### Channel Selection

The bot connects to a channel based on URL parameter or defaults to your own channel:

**Your own channel (default):**
```
https://localhost:8443/
```
Bot connects to the authenticated user's channel automatically.

**Another channel:**
```
https://localhost:8443/?channel=other_channel_name
```
Use this to moderate another channel where you have mod permissions.

The selected channel will be logged on connection:
```
🎯 Connecting to channel: #channelname (authenticated as: your_username)
```

### Starting the Bot

1. Open https://localhost:8443
2. Enter Twitch Client ID (if first run)
3. Authenticate with Twitch (if first run)
4. Enable desired modules via checkboxes
5. Configure each module via gear icon
6. Check connection status indicators (green = connected)

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

All rewards are configured in `config.js` and auto-create on first connection. Rewards auto-enable/disable based on active preset.

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

### Chat Actions Not Triggering

**Check:**
1. CHAT_ACTIONS not empty in `config.js`?
2. Patterns using `/pattern/i` format (with slashes)?
3. Check console for action execution logs
4. Module "💬 Twitch Chat" enabled and connected?

**Test Pattern:**
```javascript
// Test in browser console:
const testMsg = "test message with badword";
const pattern = /badword/i;
console.log(pattern.test(testMsg));  // Should return true
```

### LLM Not Responding

**Check:**
1. Ollama installed and running? Test: `curl http://localhost:11434`
2. Model pulled? Test: `ollama list`
3. "🤖 LLM (Ollama)" module enabled?
4. Chat monitoring checkbox enabled in LLM config panel?
5. System prompt configured?

**Debug:**
- Check browser console for LLM logs: "🤖 LLM processing chat batch..."
- Verify model selected in dropdown
- Test Ollama directly: `ollama run llama3.2 "Hello"`

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Browser UI                         │
│                  (index.html)                        │
└──────────────────────┬──────────────────────────────┘
                       │
         ┌─────────────▼─────────────┐
         │     Module Manager         │
         │  (8 independent modules)   │
         └─────────────┬──────────────┘
                       │
    ┌──────────────────┼──────────────────┐
    │                  │                  │
┌───▼────┐      ┌──────▼──────┐   ┌──────▼──────┐
│  LLM   │      │   Twitch    │   │  Minecraft  │
│ Ollama │      │ IRC/API/ES  │   │   Minaret   │
└────────┘      └─────────────┘   └─────────────┘
localhost       WebSocket+API      WebSocket
:11434          Helix REST API     :8765

┌──────────────────────────────────────────┐
│         Action Registry System            │
├───────────────────────────────────────────┤
│ • CHAT_ACTIONS - Pattern-based triggers  │
│ • LLM_ACTIONS - AI-callable functions    │
│ • Reward Actions - Channel point handlers│
│ • Context Builder - Unified execution    │
└──────────────────────────────────────────┘
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
- Vanilla JavaScript (ES6 modules)
- Modular architecture with BaseModule pattern
- Twitch IRC WebSocket (chat)
- Twitch EventSub WebSocket (redemptions)
- Twitch Helix API (REST)
- Ollama API (local LLM)
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
├── index.html                      # UI layout
├── index.css                       # Styling
├── index.js                        # Application entry point
├── config.js                       # Centralized configuration
├── actions.js                      # Action closures (rewards, chat, LLM)
├── utils.js                        # Shared utilities
├── core/                           # Core system
│   ├── module-manager.js           # Module lifecycle & context
│   ├── action-registry.js          # Action execution system
│   └── ui-builder.js               # Schema-based UI generation
├── modules/                        # 8 independent modules
│   ├── base-module.js              # Base class for all modules
│   ├── llm/module.js               # LLM (Ollama) integration
│   ├── twitch-chat/module.js       # IRC chat connection
│   ├── twitch-eventsub/module.js   # Channel point redemptions
│   ├── twitch-stream/module.js     # Stream metadata & presets
│   ├── music-queue/module.js       # Yandex Music integration
│   ├── minecraft/module.js         # Game server WebSocket
│   ├── echowire/module.js          # Android STT
│   └── obs/module.js               # OBS stream monitoring
├── mp3/                            # Sound effects
│   ├── icq.mp3
│   ├── ahhh.mp3
│   ├── boo.mp3
│   └── ...
├── yandex-music-userscript.js      # Tampermonkey script
├── SPEC.md                         # Complete specification
├── MEMO.md                         # Development notes
├── TODO.md                         # Task tracking
└── README.md                       # This file
```

**External Dependencies:**
- [Minaret](https://github.com/Vany/minaret) - Minecraft WebSocket bridge (optional)
- Tampermonkey/Greasemonkey - For yandex-music-userscript.js (optional)
