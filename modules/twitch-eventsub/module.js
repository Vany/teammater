/**
 * Twitch EventSub Module
 *
 * WebSocket connection for Twitch EventSub (channel point redemptions, etc.)
 *
 * Features:
 * - EventSub WebSocket connection
 * - Session management
 * - Subscription to channel point redemptions
 * - Redemption event handling
 * - Reward status updates (FULFILLED/CANCELED)
 *
 * Based on connectEventSub() from index.js
 */

import { BaseModule } from "../base-module.js";
import { request } from "../../utils.js";

export class TwitchEventSubModule extends BaseModule {
  constructor() {
    super();
    this.ws = null;
    this.sessionId = null;
    this.currentUserId = null;
    this.customRewards = {}; // Map of reward_id -> reward_data
    this.redemptionHandlers = []; // Array of handler functions
    this.reconnectTimer = null;
  }

  /**
   * Module display name
   */
  getDisplayName() {
    return "🎯 Twitch EventSub";
  }

  /**
   * Module configuration schema
   */
  getConfig() {
    return {
      connection: {
        eventsub_url: {
          type: "text",
          label: "EventSub WebSocket URL",
          default: "wss://eventsub.wss.twitch.tv/ws",
          stored_as: "twitch_eventsub_url",
        },
        reconnect_delay: {
          type: "number",
          label: "Reconnect Delay (ms)",
          default: 5000,
          min: 1000,
          max: 60000,
          step: 1000,
        },
      },
    };
  }

  /**
   * Initialize module with custom rewards list display
   */
  async initialize(container) {
    // Call parent initialization
    await super.initialize(container);

    // Add rewards list display after config panel
    this._createRewardsListDisplay();
  }

  /**
   * Create rewards list display section
   * @private
   */
  _createRewardsListDisplay() {
    const rewardsDiv = document.createElement("div");
    rewardsDiv.className = "rewards-list collapsed";
    rewardsDiv.style.marginTop = "10px";
    rewardsDiv.style.padding = "10px";
    rewardsDiv.style.backgroundColor = "rgba(255, 255, 255, 0.05)";
    rewardsDiv.style.borderRadius = "4px";
    rewardsDiv.style.fontSize = "12px";

    const header = document.createElement("h4");
    header.textContent = "Channel Point Rewards";
    header.style.marginTop = "0";
    header.style.marginBottom = "10px";
    header.style.fontSize = "14px";

    rewardsDiv.appendChild(header);

    const listContainer = document.createElement("div");
    listContainer.className = "rewards-items";
    rewardsDiv.appendChild(listContainer);

    this.ui.rewardsList = rewardsDiv;
    this.ui.rewardsItems = listContainer;
    // Add to config panel instead of container
    this.ui.configPanel.appendChild(rewardsDiv);
  }

  /**
   * Set user ID (required for subscriptions)
   * Must be called before connect()
   */
  setUserId(userId) {
    this.currentUserId = userId;
  }

  /**
   * Set custom rewards map
   */
  setCustomRewards(rewards) {
    this.customRewards = rewards;
    this._updateRewardsList();
  }

  /**
   * Update rewards list display
   * @private
   */
  _updateRewardsList() {
    if (!this.ui.rewardsItems) return;

    const rewards = Object.values(this.customRewards);

    if (rewards.length === 0) {
      this.ui.rewardsItems.innerHTML =
        '<div style="color: #888;">No rewards found</div>';
      return;
    }

    this.ui.rewardsItems.innerHTML = rewards
      .map(
        (reward) => `
      <div class="reward-item" style="margin-bottom: 10px; padding: 8px; background: rgba(0,0,0,0.2); border-radius: 3px;">
        <div style="margin-bottom: 5px;">
          <strong>${reward.title}</strong>
        </div>
        <div style="color: #888; font-size: 11px;">
          Cost: ${reward.cost} points | Enabled: ${reward.is_enabled ? "✅" : "❌"}
        </div>
        <button
          class="reward-test-btn"
          data-reward-id="${reward.id}"
          style="margin-top: 5px; padding: 3px 8px; font-size: 11px; cursor: pointer; background: #9147ff; color: white; border: none; border-radius: 3px;"
        >
          TEST
        </button>
      </div>
    `,
      )
      .join("");

    // Add click handlers for test buttons
    this.ui.rewardsItems.querySelectorAll(".reward-test-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const rewardId = btn.getAttribute("data-reward-id");
        this._testReward(rewardId);
      });
    });

    // Show the rewards list
    this.ui.rewardsList.classList.remove("collapsed");
  }

  /**
   * Test a reward (simulate redemption)
   * @private
   */
  async _testReward(rewardId) {
    const reward = this.customRewards[rewardId];
    if (!reward) {
      this.log(`❌ Reward not found: ${rewardId}`);
      return;
    }

    this.log(`🧪 Testing reward: ${reward.title}`);

    // Simulate redemption event
    const mockRedemption = {
      id: `test-${Date.now()}`,
      user_name: "TestUser",
      user_input: reward.is_user_input_required ? "Test input" : "",
      reward: reward,
    };

    // Call redemption handlers
    for (const handler of this.redemptionHandlers) {
      try {
        await handler(mockRedemption);
      } catch (error) {
        this.log(`❌ Test failed: ${error.message}`);
      }
    }
  }

  /**
   * Connect to EventSub
   */
  async doConnect() {
    if (!this.currentUserId) {
      throw new Error("User ID required. Call setUserId() first.");
    }

    const eventsubUrl = this.getConfigValue(
      "eventsub_url",
      "wss://eventsub.wss.twitch.tv/ws",
    );

    this.log(`🎯 Connecting to EventSub at ${eventsubUrl}...`);

    this.ws = new WebSocket(eventsubUrl);

    this.ws.onopen = () => {
      this.log("✅ EventSub connected");
    };

    this.ws.onclose = () => {
      this.log("❌ EventSub disconnected");
      this.updateStatus(false);
      this.sessionId = null;

      const reconnectDelay = parseInt(
        this.getConfigValue("reconnect_delay", "5000"),
      );
      this.reconnectTimer = setTimeout(() => {
        this.connect().catch((err) => {
          this.log(`💥 Reconnect failed: ${err.message}`);
        });
      }, reconnectDelay);
    };

    this.ws.onmessage = async (event) => {
      await this._handleEventSubMessage(event.data);
    };

    // Wait for session_welcome
    await this._waitForSession();
  }

  /**
   * Disconnect from EventSub
   */
  async doDisconnect() {
    this.log("🔌 Disconnecting from EventSub...");

    // Clear reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.sessionId = null;
    this.log("✅ Disconnected from EventSub");
  }

  /**
   * Wait for session_welcome message
   */
  _waitForSession() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Session welcome timeout"));
      }, 10000);

      const originalOnMessage = this.ws.onmessage;
      this.ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);
        const type = msg.metadata?.message_type;

        if (type === "session_welcome") {
          clearTimeout(timeout);
          this.ws.onmessage = originalOnMessage; // Restore handler
          resolve();
        }

        // Also call original handler
        await originalOnMessage(event);
      };
    });
  }

  /**
   * Handle EventSub message
   */
  async _handleEventSubMessage(data) {
    const msg = JSON.parse(data);
    const type = msg.metadata?.message_type;

    if (type === "session_welcome") {
      this.sessionId = msg.payload.session.id;
      this.log(`✅ EventSub session: ${this.sessionId}`);
      this.updateStatus(true);

      // Subscribe to redemptions
      await this._subscribeToRedemptions();
    }

    if (type === "notification") {
      const redemption = msg.payload.event;
      this.log(
        `🎯 Redemption: ${redemption.reward.title} by ${redemption.user_name}`,
      );

      // Notify redemption handlers
      this._notifyRedemptionHandlers(redemption);
    }
  }

  /**
   * Subscribe to channel point redemptions
   */
  async _subscribeToRedemptions() {
    try {
      await request("https://api.twitch.tv/helix/eventsub/subscriptions", {
        method: "POST",
        body: JSON.stringify({
          type: "channel.channel_points_custom_reward_redemption.add",
          version: "1",
          condition: { broadcaster_user_id: this.currentUserId },
          transport: { method: "websocket", session_id: this.sessionId },
        }),
      });

      this.log("✅ Subscribed to redemption events");
    } catch (error) {
      this.log(`❌ Subscription failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Register a redemption handler
   * @param {Function} handler - Function(redemptionData) to handle redemptions
   */
  registerRedemptionHandler(handler) {
    this.redemptionHandlers.push(handler);
  }

  /**
   * Unregister a redemption handler
   */
  unregisterRedemptionHandler(handler) {
    this.redemptionHandlers = this.redemptionHandlers.filter(
      (h) => h !== handler,
    );
  }

  /**
   * Notify all redemption handlers
   */
  _notifyRedemptionHandlers(redemption) {
    for (const handler of this.redemptionHandlers) {
      try {
        handler(redemption);
      } catch (error) {
        this.log(`💥 Redemption handler error: ${error.message}`);
      }
    }
  }

  /**
   * Update redemption status (FULFILLED/CANCELED)
   */
  async updateRedemptionStatus(rewardId, redemptionId, status) {
    if (!this.currentUserId) {
      this.log("❌ No user ID available");
      return false;
    }

    try {
      await request(
        `https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?broadcaster_id=${this.currentUserId}&reward_id=${rewardId}&id=${redemptionId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ status: status }),
        },
      );

      this.log(
        `✅ Redemption ${status.toLowerCase()}: ${rewardId} ${redemptionId}`,
      );
      return true;
    } catch (error) {
      this.log(`❌ Error updating redemption: ${error.message}`);
      return false;
    }
  }

  /**
   * Provide context for actions
   */
  getContextContribution() {
    if (!this.isConnected()) {
      return {
        eventSubSocket: null,
        sessionId: null,
        customRewards: {},
        updateRedemptionStatus: null,
      };
    }

    return {
      eventSubSocket: this.ws,
      sessionId: this.sessionId,
      customRewards: this.customRewards,
      updateRedemptionStatus: this.updateRedemptionStatus.bind(this),
    };
  }
}
