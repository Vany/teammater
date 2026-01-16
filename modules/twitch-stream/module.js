/**
 * Twitch Stream Module
 *
 * Stream metadata management and preset system.
 *
 * Features:
 * - Stream metadata updates (title, game, tags)
 * - Preset system for quick stream setup
 * - Stream info fetching
 * - Pinned message management
 *
 * Based on stream management functions from index.js
 */

import { BaseModule } from "../base-module.js";
import { request } from "../../utils.js";

export class TwitchStreamModule extends BaseModule {
  constructor() {
    super();
    this.currentUserId = null;
    this.presets = {};
    this.currentPreset = null;
  }

  /**
   * Module display name
   */
  getDisplayName() {
    return "📺 Twitch Stream";
  }

  /**
   * Module configuration schema
   */
  getConfig() {
    return {
      presets: {
        current_preset: {
          type: "select",
          label: "Active Preset",
          default: "",
          options: [], // Populated dynamically
          stored_as: "stream_preset",
        },
      },
    };
  }

  /**
   * Initialize module with custom preset info display
   */
  async initialize(container) {
    // Call parent initialization
    await super.initialize(container);

    // Add preset info display after config panel
    this._createPresetInfoDisplay();
  }

  /**
   * Create preset info display section
   * @private
   */
  _createPresetInfoDisplay() {
    const infoDiv = document.createElement("div");
    infoDiv.className = "preset-info collapsed";
    infoDiv.style.marginTop = "10px";
    infoDiv.style.padding = "10px";
    infoDiv.style.backgroundColor = "rgba(255, 255, 255, 0.05)";
    infoDiv.style.borderRadius = "4px";
    infoDiv.style.fontSize = "12px";

    infoDiv.innerHTML = `
      <div class="field" style="margin-bottom: 5px;">
        <span style="color: #888;">Title:</span>
        <span class="preset-title" style="margin-left: 5px;">-</span>
      </div>
      <div class="field" style="margin-bottom: 5px;">
        <span style="color: #888;">Game:</span>
        <span class="preset-game" style="margin-left: 5px;">-</span>
      </div>
      <div class="field" style="margin-bottom: 5px;">
        <span style="color: #888;">Tags:</span>
        <span class="preset-tags" style="margin-left: 5px;">-</span>
      </div>
      <div class="field">
        <span style="color: #888;">Pin:</span>
        <span class="preset-pin" style="margin-left: 5px;">-</span>
      </div>
    `;

    this.ui.presetInfo = infoDiv;
    // Add to config panel instead of container
    this.ui.configPanel.appendChild(infoDiv);
  }

  /**
   * Update preset info display
   * @private
   */
  _updatePresetInfoDisplay(preset) {
    if (!this.ui.presetInfo) return;

    const titleEl = this.ui.presetInfo.querySelector(".preset-title");
    const gameEl = this.ui.presetInfo.querySelector(".preset-game");
    const tagsEl = this.ui.presetInfo.querySelector(".preset-tags");
    const pinEl = this.ui.presetInfo.querySelector(".preset-pin");

    if (titleEl) titleEl.textContent = preset.title || "-";
    if (gameEl) gameEl.textContent = preset.game_id || "-";
    if (tagsEl) tagsEl.textContent = preset.tags ? preset.tags.join(", ") : "-";
    if (pinEl) pinEl.textContent = preset.pinned_message || "-";

    // Show the info panel
    this.ui.presetInfo.classList.remove("collapsed");
  }

  /**
   * Set user ID (required for API calls)
   * If module is enabled, will automatically connect
   */
  async setUserId(userId) {
    this.currentUserId = userId;

    // If module is enabled, connect now that we have user ID
    if (this.enabled && !this.connected) {
      this.log("🔑 User ID set, connecting...");
      await this.connect();
    }
  }

  /**
   * Set available presets
   */
  setPresets(presets) {
    this.presets = presets;

    // Update preset selector options in config panel
    this._updatePresetSelector();
  }

  /**
   * Update preset selector dropdown
   */
  _updatePresetSelector() {
    const selector = this.ui.configPanel?.querySelector(
      'select[stored_as="stream_preset"]',
    );
    if (!selector) return;

    // Clear existing options
    selector.innerHTML = '<option value="">Select preset...</option>';

    // Add preset options
    Object.keys(this.presets).forEach((key) => {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = key.charAt(0).toUpperCase() + key.slice(1);

      // Check if this is the stored preset
      const storedPreset = this.getConfigValue("current_preset", "");
      if (key === storedPreset) {
        option.selected = true;
        this.currentPreset = key;
      }

      selector.appendChild(option);
    });

    // Add change listener to apply preset
    selector.addEventListener("change", async (e) => {
      const presetKey = e.target.value;
      if (presetKey) {
        await this.applyPreset(presetKey);
      }
    });
  }

  /**
   * Connect (verify API access)
   */
  async doConnect() {
    if (!this.currentUserId) {
      // Don't throw error, just log and skip connection
      // This happens when checkbox is restored from localStorage before auth
      this.log("⏳ Waiting for user ID...");
      return;
    }

    this.log("📺 Initializing Twitch Stream module...");

    // Test API access by fetching current stream info
    try {
      await this.getCurrentStreamInfo();
      this.log("✅ Stream module initialized");
      this.updateStatus(true);
    } catch (error) {
      this.log(`⚠️ Stream API access limited: ${error.message}`);
      this.updateStatus(true); // Still mark as connected
    }
  }

  /**
   * Disconnect
   */
  async doDisconnect() {
    this.log("🔌 Disconnecting Stream module...");
    this.updateStatus(false);
  }

  /**
   * Get current stream information
   */
  async getCurrentStreamInfo() {
    if (!this.currentUserId) {
      throw new Error("No user ID available");
    }

    try {
      const response = await request(
        `https://api.twitch.tv/helix/channels?broadcaster_id=${this.currentUserId}`,
      );

      const data = await response.json();
      const channel = data.data[0];

      this.log(
        `📺 Current: "${channel.title}" | Game: ${channel.game_name} | Tags: [${channel.tags.join(", ")}]`,
      );

      return channel;
    } catch (error) {
      this.log(`❌ Error getting stream info: ${error.message}`);
      throw error;
    }
  }

  /**
   * Apply a stream preset
   */
  async applyPreset(presetKey) {
    if (!this.currentUserId) {
      this.log("❌ No user ID available for stream update");
      return false;
    }

    const preset = this.presets[presetKey];
    if (!preset) {
      this.log(`❌ Preset not found: ${presetKey}`);
      return false;
    }

    try {
      this.log(`🎯 Applying preset: ${presetKey}`);

      const response = await request(
        `https://api.twitch.tv/helix/channels?broadcaster_id=${this.currentUserId}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            game_id: preset.game_id,
            title: preset.title,
            tags: preset.tags,
          }),
        },
      );

      this.log(`✅ Stream updated with preset: ${presetKey}`);
      this.currentPreset = presetKey;

      // Store preset selection
      this.setConfigValue("current_preset", presetKey);

      // Update preset info display
      this._updatePresetInfoDisplay(preset);

      // Apply reward configuration if rewards_active is defined
      if (preset.rewards_active) {
        await this._applyRewardConfig(preset.rewards_active);
      }

      return true;
    } catch (error) {
      this.log(`❌ Error updating stream: ${error.message}`);
      return false;
    }
  }

  /**
   * Apply reward configuration (enable/disable based on preset)
   * @private
   */
  async _applyRewardConfig(activeRewards) {
    this.log(`🎯 Applying reward config: [${activeRewards.join(", ")}]`);

    // Get EventSub module to access rewards
    const eventSubModule = this.moduleManager?.get?.("twitch-eventsub");
    if (!eventSubModule) {
      this.log(`⚠️ EventSub module not available for reward config`);
      return;
    }

    const customRewards = eventSubModule.customRewards || {};
    const rewards = Object.values(customRewards);

    if (rewards.length === 0) {
      this.log(`⚠️ No rewards found to configure`);
      return;
    }

    // Update each reward's enabled state
    for (const reward of rewards) {
      // Get reward key from stored property
      const rewardKey = reward.key;

      if (!rewardKey) {
        this.log(`⚠️ Reward missing key property: ${reward.title}`);
        continue;
      }

      // Determine if this reward should be enabled
      const shouldBeEnabled = activeRewards.includes(rewardKey);

      // Update the reward state if it changed
      if (reward.is_enabled !== shouldBeEnabled) {
        const success = await this._updateRewardState(
          reward.id,
          shouldBeEnabled,
        );
        if (success) {
          const state = shouldBeEnabled ? "✅ enabled" : "❌ disabled";
          this.log(`${state}: ${reward.title}`);

          // Update local cache
          reward.is_enabled = shouldBeEnabled;
        }
      }
    }

    // Trigger rewards list update in EventSub module
    if (eventSubModule._updateRewardsList) {
      eventSubModule._updateRewardsList();
    }

    this.log("✅ Reward configuration applied");
  }

  /**
   * Update reward enabled state via API
   * @private
   */
  async _updateRewardState(rewardId, enabled) {
    try {
      await request(
        `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${this.currentUserId}&id=${rewardId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ is_enabled: enabled }),
        },
      );
      return true;
    } catch (error) {
      this.log(`❌ Error updating reward ${rewardId}: ${error.message}`);
      return false;
    }
  }

  /**
   * Update stream metadata
   */
  async updateStreamInfo(title, gameId, tags) {
    if (!this.currentUserId) {
      this.log("❌ No user ID available");
      return false;
    }

    try {
      const response = await request(
        `https://api.twitch.tv/helix/channels?broadcaster_id=${this.currentUserId}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            game_id: gameId,
            title: title,
            tags: tags,
          }),
        },
      );

      this.log(`✅ Stream updated: "${title}"`);
      return true;
    } catch (error) {
      this.log(`❌ Error updating stream: ${error.message}`);
      return false;
    }
  }

  /**
   * Get current chat settings
   */
  async getCurrentChatSettings() {
    if (!this.currentUserId) {
      throw new Error("No user ID available");
    }

    try {
      const response = await request(
        `https://api.twitch.tv/helix/chat/settings?broadcaster_id=${this.currentUserId}&moderator_id=${this.currentUserId}`,
      );

      const data = await response.json();
      return data.data[0];
    } catch (error) {
      this.log(`❌ Error getting chat settings: ${error.message}`);
      return null;
    }
  }

  /**
   * Pin a message in chat
   */
  async pinMessageById(messageId, messageText) {
    if (!this.currentUserId || !messageId) {
      this.log("❌ No user ID or message ID for pinning");
      return false;
    }

    try {
      const response = await request(
        `https://api.twitch.tv/helix/chat/settings?broadcaster_id=${this.currentUserId}&moderator_id=${this.currentUserId}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            pinned_chat_message_id: messageId,
          }),
        },
      );

      this.log(`📌 Successfully pinned: "${messageText}"`);
      return true;
    } catch (error) {
      this.log(`❌ Error pinning message: ${error.message}`);
      return false;
    }
  }

  /**
   * Get current preset
   */
  getCurrentPreset() {
    return this.currentPreset;
  }

  /**
   * Get preset data
   */
  getPreset(presetKey) {
    return this.presets[presetKey] || null;
  }

  /**
   * Provide context for actions
   */
  getContextContribution() {
    if (!this.isConnected()) {
      return {
        streamModule: null,
      };
    }

    return {
      streamModule: {
        getCurrentStreamInfo: this.getCurrentStreamInfo.bind(this),
        applyPreset: this.applyPreset.bind(this),
        updateStreamInfo: this.updateStreamInfo.bind(this),
        pinMessageById: this.pinMessageById.bind(this),
        getCurrentPreset: this.getCurrentPreset.bind(this),
        getPreset: this.getPreset.bind(this),
      },
      currentUserId: this.currentUserId,
    };
  }
}
