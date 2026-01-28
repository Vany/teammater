/**
 * LLM Module
 *
 * Integrates local Ollama LLM server for:
 * - Chat companion (monitoring chat and responding)
 * - Channel point reward responses
 * - Action-triggered generation
 *
 * Based on LLMConnector from connectors.js
 */

import { BaseModule } from "../base-module.js";
import { LLM_ACTIONS, getBroadcasterUsername } from "../../config.js";

export class LLMModule extends BaseModule {
  constructor() {
    super();
    this.healthCheckTimer = null;
    this.lastHealthCheck = null;

    // Pre-calculate LLM actions prompt once
    this.llmActionsPrompt =
      Object.keys(LLM_ACTIONS).length > 0
        ? `\n${Object.keys(LLM_ACTIONS)
            .map((action) => `- ${action}`)
            .join("\n")}`
        : "";
  }

  /**
   * Module display name
   */
  getDisplayName() {
    return "🤖 LLM (Ollama)";
  }

  /**
   * Module configuration schema
   */
  getConfig() {
    return {
      connection: {
        base_url: {
          type: "text",
          label: "Ollama Base URL",
          default: "http://localhost:11434",
          stored_as: "llm_base_url",
        },
        health_check_interval: {
          type: "number",
          label: "Health Check Interval (ms)",
          default: 30000,
          min: 5000,
          max: 120000,
          step: 5000,
        },
      },
      model: {
        model_name: {
          type: "select",
          label: "Model",
          default: "llama3.2",
          options: [], // Populated dynamically after connection
          stored_as: "llm_model",
        },
        system_prompt: {
          type: "textarea",
          label: "System Prompt",
          default:
            "You are a helpful Twitch chat companion. Respond naturally and conversationally.",
          stored_as: "llm_system_prompt",
        },
      },
      generation: {
        temperature: {
          type: "range",
          label: "Temperature",
          default: 0.7,
          min: 0,
          max: 1,
          step: 0.1,
          stored_as: "llm_temperature",
        },
        max_tokens: {
          type: "number",
          label: "Max Tokens",
          default: 512,
          min: 1,
          max: 4096,
          step: 1,
          stored_as: "llm_max_tokens",
        },
        timeout: {
          type: "number",
          label: "Request Timeout (ms)",
          default: 30000,
          min: 5000,
          max: 120000,
          step: 5000,
        },
      },
      features: {
        chat_monitoring: {
          type: "checkbox",
          label: "Enable Chat Monitoring",
          default: false,
          stored_as: "llm_chat_monitoring",
        },
        echowire_enabled: {
          type: "checkbox",
          label: "Enable Echowire",
          default: true,
          stored_as: "llm_echowire_enabled",
        },
      },
    };
  }

  /**
   * Connect to Ollama server
   */
  async doConnect() {
    const baseUrl = this.getConfigValue("base_url", "http://localhost:11434");
    const healthCheckInterval = parseInt(
      this.getConfigValue("health_check_interval", "30000"),
    );

    this.log(`🤖 Connecting to Ollama at ${baseUrl}...`);

    try {
      const healthy = await this.checkHealth();

      if (healthy) {
        this.log(`✅ Connected to Ollama at ${baseUrl}`);

        // Start periodic health checks
        if (healthCheckInterval > 0) {
          this._startHealthChecks(healthCheckInterval);
        }

        // Fetch and populate available models
        await this.populateModels();

        return true;
      } else {
        throw new Error(`Ollama server not responding at ${baseUrl}`);
      }
    } catch (error) {
      this.log(`❌ Failed to connect to Ollama: ${error.message}`);
      throw error;
    }
  }

  /**
   * Disconnect from Ollama server
   */
  async doDisconnect() {
    this.log(`🔌 Disconnecting from Ollama...`);
    this._stopHealthChecks();
    this.log(`✅ Disconnected from Ollama`);
  }

  /**
   * Check if Ollama server is healthy
   */
  async checkHealth() {
    const baseUrl = this.getConfigValue("base_url", "http://localhost:11434");

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${baseUrl}/api/tags`, {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      this.lastHealthCheck = Date.now();

      const wasConnected = this.connected;
      const isHealthy = response.ok;

      if (isHealthy !== wasConnected) {
        this.updateStatus(isHealthy);

        if (isHealthy) {
          this.log(`✅ Ollama server is back online`);
        } else {
          this.log(`⚠️ Ollama server stopped responding`);
        }
      }

      return isHealthy;
    } catch (error) {
      const wasConnected = this.connected;

      if (wasConnected) {
        this.updateStatus(false);
        this.log(`⚠️ Health check failed: ${error.message}`);
      }

      return false;
    }
  }

  /**
   * Fetch available models and populate select dropdown
   */
  async populateModels() {
    const baseUrl = this.getConfigValue("base_url", "http://localhost:11434");

    try {
      this.log(`🔍 Fetching available models from Ollama...`);

      const response = await fetch(`${baseUrl}/api/tags`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const models = data.models || [];

      if (models.length === 0) {
        this.log(`⚠️ No models found on Ollama server`);
        return;
      }

      // Update the model select dropdown in config panel
      const modelSelect = this.ui.configPanel?.querySelector(
        'select[stored_as="llm_model"]',
      );
      if (modelSelect) {
        const currentModel = this.getConfigValue("model_name", "llama3.2");

        // Clear existing options
        modelSelect.innerHTML = "";

        // Add model options
        let hasCurrentModel = false;
        models.forEach((model) => {
          const option = document.createElement("option");
          option.value = model.name;
          option.textContent = model.name;

          if (model.name === currentModel) {
            option.selected = true;
            hasCurrentModel = true;
          }

          modelSelect.appendChild(option);
        });

        // If current model not in list, add it as first option
        if (!hasCurrentModel && currentModel) {
          const option = document.createElement("option");
          option.value = currentModel;
          option.textContent = `${currentModel} (not found)`;
          option.selected = true;
          modelSelect.insertBefore(option, modelSelect.firstChild);
        }

        this.log(
          `✅ Loaded ${models.length} models: ${models.map((m) => m.name).join(", ")}`,
        );
      }
    } catch (error) {
      this.log(`💥 Failed to fetch models: ${error.message}`);
    }
  }

  /**
   * Generate text using Ollama chat API
   */
  async chat(messages, options = {}) {
    if (!this.isConnected()) {
      throw new Error("Not connected to Ollama server");
    }

    const baseUrl = this.getConfigValue("base_url", "http://localhost:11434");
    const model = this.getConfigValue("model_name", "llama3.2");
    const temperature = parseFloat(this.getConfigValue("temperature", "0.7"));
    const maxTokens = parseInt(this.getConfigValue("max_tokens", "512"));
    const timeout = parseInt(this.getConfigValue("timeout", "30000"));

    const {
      model: overrideModel,
      temperature: overrideTemp,
      maxTokens: overrideMaxTokens,
    } = options;

    const requestBody = {
      model: overrideModel || model,
      messages,
      temperature: overrideTemp !== undefined ? overrideTemp : temperature,
      max_tokens:
        overrideMaxTokens !== undefined ? overrideMaxTokens : maxTokens,
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return data.choices?.[0]?.message?.content || "";
    } catch (error) {
      this.log(`💥 Chat failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Start periodic health checks
   */
  _startHealthChecks(interval) {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    this.healthCheckTimer = setInterval(() => {
      this.checkHealth();
    }, interval);
  }

  /**
   * Stop periodic health checks
   */
  _stopHealthChecks() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Get time since last successful health check
   */
  getLastHealthCheckAge() {
    if (!this.lastHealthCheck) return null;
    return Date.now() - this.lastHealthCheck;
  }

  /**
   * Monitor chat and decide whether to respond
   * Two-stage LLM decision process:
   * 1. Should respond? (nothing/remember/respond/silence_user)
   * 2. What to say? (generate response)
   *
   * @param {TwitchChatModule} chatModule - Chat module reference
   * @param {Object} context - Execution context for actions (optional)
   * @returns {Promise<void>}
   */
  async monitorChat(chatModule, context = {}) {
    if (!this.isConnected() || !chatModule?.isConnected()) {
      return;
    }

    const chatMonitoring =
      this.getConfigValue("chat_monitoring", "false") === "true";
    if (!chatMonitoring) {
      return;
    }

    // Get chat state from module
    const chatHistory = chatModule.getChatHistory();
    const markerPosition = chatModule.getChatMarkerPosition();

    // Check if there are new messages
    if (markerPosition >= chatHistory.length) {
      return;
    }

    this.log("🤖 LLM processing chat batch...");

    try {
      const systemPrompt = this.getConfigValue("system_prompt", "");
      const chatLog = chatModule.formatChatHistoryForLLM();

      console.log(`>>>>>> ${chatLog}`);

      // Stage 1: Should respond?
      const shouldRespondMessages = [
        {
          role: "system",
          content: `
            ${systemPrompt}
            User ${getBroadcasterUsername()} is chat owner, listen to them.
            Twitch Rules (short):
            Allowed:
            - Copy paste messages
            - Obscene language
            - Friendly teasing
            - Asking awkward and inappropriate questions
            - Only half toxic messages
            - Interract with any dialogues
            - Sarcastic, non direct rule violations for fun without profit.

            Sense sarcasm, not all the messages is malisious,
            Disallowed content includes:
            - Hate speech, slurs, discrimination
            - Threats, harassment, bullying
            - Sexual content involving minors
            - Excessive sexual content or pornographic requests
            - Spam, scams, or malicious links
            - Encouraging self-harm or violence
            - Doxxing or sharing private info
            - Self-promotion or advertising
            Such messages must trigger: silence_user

            You are unobtrusive, good-natured chat owner.
            Available actions:
            - nothing        → no action needed
            - remember       → store information to memory
            - respond        → send a reply to chat
            - silence_user   → apply moderation mute
            ${this.llmActionsPrompt}`,
        },
        {
          role: "user",
          content: `
          Here is the chat history:
          -> old messages:
          ${chatLog}\n
          -> end of messages

          What action do you need to perform on new messages and why?
          action: action, reason: reason
          `,
        },
      ];

      const shouldRespondAnswer = await this.chat(shouldRespondMessages, {
        maxTokens: 128,
        temperature: 0.5,
      });
      this.log(`🤖: >>> "${shouldRespondAnswer}"`);

      // Handle different action types
      if (
        shouldRespondAnswer.trim().toLowerCase().startsWith("action: remember")
      ) {
        const responseMessages = [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Here is the chat history:\n
            ${chatLog}\n
            You decide to ${shouldRespondAnswer}\n
            What internal note do you want to remember? Write ONLY your memory note, without any timestamp, username, or prefix. Just the note itself.`,
          },
        ];

        const responseText = await this.chat(responseMessages, {
          maxTokens: 256,
          temperature: 0.7,
        });

        if (responseText?.trim()) {
          const cleanResponse = responseText
            .trim()
            .replace(/^\[\d{2}:\d{2}:\d{2}\]\s+\w+:\s*/, "");
          this.log(`🧠 LLM memory note: "${cleanResponse}"`);

          // Add to chat history as internal memory (not sent to Twitch)
          chatModule._addToChatHistory("[LLM_MEMORY]", cleanResponse);
        }
      } else if (
        shouldRespondAnswer.trim().toLowerCase().startsWith("action: respond")
      ) {
        const responseMessages = [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Here is the chat history:\n
            ${chatLog}\n
            You decide to ${shouldRespondAnswer}\n
            What should you say in response? Write ONLY your response text, without any timestamp, username, or prefix. Just the message itself.`,
          },
        ];

        const responseText = await this.chat(responseMessages, {
          maxTokens: 256,
          temperature: 0.7,
        });

        if (responseText?.trim()) {
          const cleanResponse = responseText
            .trim()
            .replace(/^\[\d{2}:\d{2}:\d{2}\]\s+\w+:\s*/, "");
          this.log(`🤖 LLM response: "${cleanResponse}"`);

          const sent = chatModule.send(cleanResponse);
          if (!sent) {
            this.log(`💥 Failed to send LLM response to chat!`);
          }
        }
      } else if (
        shouldRespondAnswer.trim().toLowerCase().startsWith("action: silence")
      ) {
        // Note: This is the fixed version (case-insensitive)
        this.log("🤖 LLM decided to request user silencing");
        const responseMessages = [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Here is the chat history:\n
            ${chatLog}\n
            What user must we silence? Name please.`,
          },
        ];

        const responseText = await this.chat(responseMessages, {
          maxTokens: 256,
          temperature: 0.7,
        });

        if (responseText?.trim()) {
          const cleanResponse = responseText
            .trim()
            .replace(/^\[\d{2}:\d{2}:\d{2}\]\s+\w+:\s*/, "");
          this.log(`🤖 LLM identified user: "${cleanResponse}"`);
          const sent = chatModule.send(
            "Moderators, please silence for 10 minutes: " + cleanResponse,
          );
          if (!sent) {
            this.log(`💥 Failed to send LLM moderation request to chat!`);
          }
        }
      } else {
        // Check if it matches any LLM_ACTIONS
        const answerLower = shouldRespondAnswer.trim().toLowerCase();

        // Extract first word from answer (action name)
        const actionMatch = answerLower.match(/^action:\s*([^,]+)/);
        if (actionMatch) {
          const firstWord = actionMatch[1];

          // Find matching action by comparing first word
          for (const [actionName, actionClosure] of Object.entries(
            LLM_ACTIONS,
          )) {
            const actionFirstWord = actionName.toLowerCase().split(/\s+/)[0];

            if (firstWord === actionFirstWord) {
              this.log(`🎯 LLM triggered action: ${actionName}`);

              try {
                // Extract reason from the answer
                const reasonMatch =
                  shouldRespondAnswer.match(/reason:\s*(.+)/i);
                const reason = reasonMatch
                  ? reasonMatch[1].trim()
                  : shouldRespondAnswer;

                // Extract username from the last message
                const lastMessage = chatHistory[chatHistory.length - 1];
                const username = lastMessage?.username || "unknown";

                // Execute the action with context, username, and reason
                await actionClosure(context, username, reason);
                this.log(`✅ LLM action "${actionName}" executed successfully`);
              } catch (error) {
                this.log(
                  `💥 Failed to execute LLM action "${actionName}": ${error.message}`,
                );
              }
              break;
            }
          }
        }
      }

      // Update marker position
      chatModule.setChatMarkerPosition(chatHistory.length);
    } catch (error) {
      this.log(`💥 LLM processing error: ${error.message}`);
    }
  }

  /**
   * Provide context for actions
   * Returns module reference - actions access methods directly
   */
  getContextContribution() {
    return { llm: this };
  }

  /**
   * Get system prompt (for actions that need it)
   */
  get systemPrompt() {
    return this.getConfigValue("system_prompt", "");
  }
}
