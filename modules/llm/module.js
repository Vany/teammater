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

// Max tool-call iterations per monitoring cycle to prevent infinite loops
const MAX_TOOL_ITERATIONS = 10;

// localStorage key for persistent LLM memory
const MEMORY_STORAGE_KEY = "MEMORY";

// Trigger compression when memory exceeds this many lines
const MEMORY_COMPRESS_THRESHOLD = 100;

export class LLMModule extends BaseModule {
  constructor() {
    super();
    this.healthCheckTimer = null;
    this.lastHealthCheck = null;

    // Cached tools array — built once on connect, invalidated on disconnect
    this._toolsCache = null;

    // DOM reference for the control panel chat log — updated in real time
    this._chatLogEl = null;

    // DOM references for the memory modal
    this._memoryModalEl = null;
    this._memoryTextEl = null;

    // Thinking block elements — created once in initialize(), referenced by
    // _streamThinking/_collapseThinking/_clearThinking regardless of whether
    // the control panel modal is open or has ever been opened.
    this._thinkingDetailsEl = null;
    this._thinkingTextEl = null;
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
      identity: {
        bot_names: {
          type: "text",
          label: "Bot Names (comma-separated)",
          // First name = primary (used as nickname everywhere).
          // Rest = trigger aliases for echowire speech recognition.
          default: "Михалыч,Михайлович",
          stored_as: "llm_bot_names",
        },
      },
      model: {
        model_name: {
          type: "select",
          label: "Model",
          default: "", // Auto-selected on connect from available models
          required: false,
          options: [], // Populated dynamically after connection
          stored_as: "llm_model",
        },
        system_prompt: {
          type: "textarea",
          label: "System Prompt",
          required: false,
          default: `You are a tool-assisted assistant.
When you need data from a tool, call it.
When a tool result is available, you may call another tool if needed.
Do not make up results.
Do not guess or simulate tool results.
When a tool can provide authoritative or non-hallucinated data, you MUST call it.
You are an unobtrusive, good-natured chat companion.

User ${getBroadcasterUsername()} is chat owner, listen to them.
Local rules are more important than Twitch ones.
Sense sarcasm — not all messages are malicious.`,
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
          label: "Max Tokens (output)",
          default: 512,
          min: 1,
          max: 32768,
          step: 1,
          stored_as: "llm_max_tokens",
        },
        num_ctx: {
          type: "number",
          label: "Context Window (num_ctx)",
          // 8192 fits system prompt + 50 chat messages + tools comfortably
          default: 8192,
          min: 2048,
          max: 131072,
          step: 1024,
          stored_as: "llm_num_ctx",
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
        thinking: {
          type: "checkbox",
          label: "Enable Thinking Mode (Qwen3/DeepSeek-R1)",
          default: false,
          stored_as: "llm_thinking",
        },
        echowire_enabled: {
          type: "checkbox",
          label: "Enable Echowire",
          default: true,
          stored_as: "llm_echowire_enabled",
        },
        rules: {
          type: "textarea",
          label: "Chat Rules",
          required: false,
          stored_as: "llm_chat_rules",
          default: `Allowed:
- Copy paste messages
- Obscene language
- Friendly teasing
- Asking awkward and inappropriate questions
- Half-toxic messages
- Interacting with any dialogues
- Switching subject of conversation
- Creating disorder in the chat
- Sarcastic, non-direct rule violations for fun without profit.

Disallowed (use mute tool):
- Hate speech, slurs, discrimination
- Threats, harassment, bullying
- Sexual content involving minors
- Excessive sexual content or pornographic requests
- Spam, scams, or malicious links
- Encouraging self-harm or violence
- Doxxing or sharing private info
- Self-promotion or advertising`,
        },
      },
    };
  }

  hasControlPanel() {
    return true;
  }

  getControlPanelIcon() {
    return "🧠";
  }

  /**
   * Primary bot name (first in the comma-separated list).
   * Used as the bot's nickname in chat, logs, and system prompt.
   */
  getBotName() {
    return this.getConfigValue("bot_names", "Михалыч").split(",")[0].trim();
  }

  /**
   * All trigger aliases (all names including primary).
   * Used by echowire to detect speech-to-text commands addressed to the bot.
   * @returns {string[]}
   */
  getBotAliases() {
    return this.getConfigValue("bot_names", "Михалыч")
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
  }

  /**
   * Override initialize to inject a second "memory" button + modal into the module header.
   */
  async initialize(container) {
    // Create thinking block elements BEFORE super.initialize() — it calls
    // renderControlPanel() which immediately tries to appendChild(_thinkingDetailsEl).
    const thinkDetails = document.createElement("details");
    thinkDetails.className = "llm-thinking-block";
    thinkDetails.style.display = "none";
    const thinkSummary = document.createElement("summary");
    thinkSummary.textContent = "🧠 Thinking…";
    thinkDetails.appendChild(thinkSummary);
    const thinkPre = document.createElement("pre");
    thinkPre.className = "llm-thinking-text";
    thinkDetails.appendChild(thinkPre);
    this._thinkingDetailsEl = thinkDetails;
    this._thinkingTextEl = thinkPre;

    await super.initialize(container);

    // Memory toggle button — inserted before ⚙️ (config toggle) so order is: 🧠 💾 ⚙️
    const memBtn = document.createElement("button");
    memBtn.className = "control-toggle";
    memBtn.textContent = "💾";
    memBtn.title = "Show memory";
    memBtn.addEventListener("click", () => this._toggleMemoryModal());
    const header = this.ui.container.querySelector(".module-header");
    header.insertBefore(memBtn, this.ui.configToggle);

    // Memory modal
    this._memoryModalEl = this._createMemoryModal();
    document.body.appendChild(this._memoryModalEl);
  }

  /**
   * Build the memory modal DOM element.
   */
  _createMemoryModal() {
    const modal = document.createElement("div");
    modal.className = "control-modal";
    modal.style.display = "none";

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.addEventListener("click", () => {
      modal.style.display = "none";
    });

    const content = document.createElement("div");
    content.className = "modal-content";

    // Header
    const header = document.createElement("div");
    header.className = "modal-header";

    const title = document.createElement("h2");
    title.textContent = "LLM Memory";
    header.appendChild(title);

    const headerRight = document.createElement("div");
    headerRight.className = "modal-header-actions";

    const saveBtn = document.createElement("button");
    saveBtn.textContent = "💾 Save";
    saveBtn.className = "panel-action-btn";
    saveBtn.addEventListener("click", () => {
      localStorage.setItem(MEMORY_STORAGE_KEY, textarea.value);
      saveBtn.textContent = "✅ Saved";
      setTimeout(() => {
        saveBtn.textContent = "💾 Save";
      }, 1500);
      this.log("💾 LLM memory saved");
    });
    headerRight.appendChild(saveBtn);

    const compressBtn = document.createElement("button");
    compressBtn.textContent = "🗜️ Compress";
    compressBtn.className = "panel-action-btn";
    compressBtn.addEventListener("click", async () => {
      const text = textarea.value.trim();
      if (!text) return;
      compressBtn.disabled = true;
      compressBtn.textContent = "⏳ Compressing…";
      try {
        await this._compressMemory(text);
        this._refreshMemoryModal();
        compressBtn.textContent = "✅ Done";
      } catch {
        compressBtn.textContent = "💥 Failed";
      }
      setTimeout(() => {
        compressBtn.textContent = "🗜️ Compress";
        compressBtn.disabled = false;
      }, 2000);
    });
    headerRight.appendChild(compressBtn);

    const clearBtn = document.createElement("button");
    clearBtn.textContent = "🗑️ Clear";
    clearBtn.className = "panel-action-btn";
    clearBtn.addEventListener("click", () => {
      localStorage.removeItem(MEMORY_STORAGE_KEY);
      this._refreshMemoryModal();
      this.log("🗑️ LLM memory cleared");
    });
    headerRight.appendChild(clearBtn);

    const closeBtn = document.createElement("button");
    closeBtn.className = "modal-close";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => {
      modal.style.display = "none";
    });
    headerRight.appendChild(closeBtn);

    header.appendChild(headerRight);
    content.appendChild(header);

    // Body — editable textarea so memory can be manually tweaked
    const body = document.createElement("div");
    body.className = "modal-body";

    const textarea = document.createElement("textarea");
    textarea.style.cssText =
      "width: 100%; height: 60vh; box-sizing: border-box; font-family: monospace; font-size: 12px; background: #111; color: #ccc; border: 1px solid #444; border-radius: 4px; padding: 8px; resize: vertical;";
    textarea.placeholder = "(memory is empty)";
    body.appendChild(textarea);
    content.appendChild(body);

    modal.appendChild(overlay);
    modal.appendChild(content);

    this._memoryTextEl = textarea;

    // Escape closes
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.style.display !== "none") {
        modal.style.display = "none";
      }
    });

    return modal;
  }

  _toggleMemoryModal() {
    if (!this._memoryModalEl) return;
    const isHidden = this._memoryModalEl.style.display === "none";
    if (isHidden) {
      this._refreshMemoryModal();
      this._memoryModalEl.style.display = "flex";
    } else {
      this._memoryModalEl.style.display = "none";
    }
  }

  _refreshMemoryModal() {
    if (this._memoryTextEl) {
      this._memoryTextEl.value = this._loadMemory();
    }
  }

  /**
   * Render control panel — shows real-time chat context sent to LLM + direct input
   */
  renderControlPanel() {
    const container = document.createElement("div");
    container.className = "llm-chat-panel";

    // Header row: title + clear button
    const headerRow = document.createElement("div");
    headerRow.className = "llm-panel-header";

    const heading = document.createElement("h3");
    heading.textContent = "Chat context sent to LLM";
    headerRow.appendChild(heading);

    const clearBtn = document.createElement("button");
    clearBtn.textContent = "🗑️ Clear";
    clearBtn.className = "panel-action-btn";
    clearBtn.addEventListener("click", () => {
      const chatModule = this.moduleManager?.get("twitch-chat");
      if (chatModule?.clearChatHistory) {
        chatModule.clearChatHistory();
        this.log("🗑️ Chat history cleared");
      }
      this._updateChatLog("(no chat context yet)");
    });
    headerRow.appendChild(clearBtn);

    container.appendChild(headerRow);

    const log = document.createElement("pre");
    log.id = "llmChatLog";
    log.className = "llm-chat-log";
    container.appendChild(log);

    // Direct input line
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Send direct message to LLM (Enter)";
    input.className = "llm-direct-input";

    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const text = input.value.trim();
      if (!text) return;
      input.value = "";

      const chatModule = this.moduleManager?.get("twitch-chat");
      if (!chatModule?.isConnected()) {
        this.log("⚠️ Twitch Chat not connected — cannot inject message");
        return;
      }

      // Inject as owner — same pattern as echowire's _forwardToLLM
      const owner = `[${getBroadcasterUsername() || "owner"}]`;
      chatModule._addToChatHistory(owner, text);
      chatModule._notifyMessageHandlers({
        username: owner,
        message: text,
        tags: { "user-id": "direct-input" },
        userId: "direct-input",
        messageId: null,
        rawData: `direct://${owner}/${text}`,
        source: "direct",
      });
    });

    container.appendChild(input);

    // Thinking block — reuse the element created in initialize()
    // (refs already set; just attach to this panel's container)
    container.appendChild(this._thinkingDetailsEl);

    // Keep reference for real-time updates
    this._chatLogEl = log;

    // Register live update handler — refresh log on every incoming message
    const chatModule = this.moduleManager?.get("twitch-chat");
    const onMessage = () => {
      if (chatModule) this._updateChatLog(chatModule.formatChatHistoryForLLM());
    };
    chatModule?.registerMessageHandler(onMessage, -100); // lowest priority — observe only

    // Unregister when panel is removed from DOM
    new MutationObserver((_, obs) => {
      if (!document.contains(container)) {
        chatModule?.unregisterMessageHandler(onMessage);
        obs.disconnect();
      }
    }).observe(document.body, { childList: true, subtree: true });

    // Populate with restored history (or placeholder if empty)
    const initialLog = chatModule?.formatChatHistoryForLLM();
    this._updateChatLog(initialLog || "(no chat context yet)");

    return container;
  }

  /**
   * Update chat log display in the control panel.
   * Renders " -> new messages:" marker lines with a bright highlight.
   */
  _updateChatLog(text) {
    // Update cached reference if element still in DOM
    if (!this._chatLogEl || !document.contains(this._chatLogEl)) {
      this._chatLogEl = document.getElementById("llmChatLog");
    }
    if (!this._chatLogEl) return;

    this._chatLogEl.innerHTML = "";
    for (const line of text.split("\n")) {
      if (line.includes(" -> new messages:")) {
        const marker = document.createElement("span");
        marker.className = "llm-chat-marker";
        marker.textContent = line + "\n";
        this._chatLogEl.appendChild(marker);
      } else {
        this._chatLogEl.appendChild(document.createTextNode(line + "\n"));
      }
    }
    this._chatLogEl.scrollTop = this._chatLogEl.scrollHeight;
  }

  /** Show thinking block and append a token to it (called during streaming) */
  _streamThinking(token) {
    if (!this._thinkingDetailsEl || !this._thinkingTextEl) return;
    this._thinkingDetailsEl.style.display = "";
    this._thinkingDetailsEl.open = true;
    this._thinkingTextEl.textContent += token;
    this._thinkingTextEl.scrollTop = this._thinkingTextEl.scrollHeight;
  }

  /** Collapse thinking block when generation finishes (keep content readable on expand) */
  _collapseThinking() {
    if (!this._thinkingDetailsEl) return;
    this._thinkingDetailsEl.open = false;
    const summary = this._thinkingDetailsEl.querySelector("summary");
    if (summary) summary.textContent = "🧠 Reasoning (click to expand)";
  }

  /** Hide and clear thinking block (between cycles) */
  _clearThinking() {
    if (!this._thinkingDetailsEl || !this._thinkingTextEl) return;
    this._thinkingDetailsEl.style.display = "none";
    this._thinkingDetailsEl.open = false;
    this._thinkingTextEl.textContent = "";
    const summary = this._thinkingDetailsEl.querySelector("summary");
    if (summary) summary.textContent = "🧠 Thinking…";
  }

  /**
   * Set status indicator state: "idle" | "busy" | "error"
   * idle  → green (connected, doing nothing)
   * busy  → yellow pulsing (model is generating)
   * error → red pulsing (last request failed)
   */
  _setIndicator(state) {
    const el = this.ui.statusIndicator;
    if (!el) return;
    el.classList.remove("connected", "busy", "error", "disconnected");
    if (state === "idle") el.classList.add("connected");
    else if (state === "busy") el.classList.add("busy");
    else if (state === "error") el.classList.add("error");
    else el.classList.add("disconnected");
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
        this._setIndicator("idle");

        // Warn if thinking mode is on but max_tokens is too low
        const thinkingOn = this.getConfigValue("thinking", "false") === "true";
        const maxTok = parseInt(this.getConfigValue("max_tokens", "512"));
        if (thinkingOn && maxTok < 4096) {
          this.log(`⚠️ Thinking mode is ON but Max Tokens is ${maxTok} — recommended ≥ 4096, responses may be cut off`);
        }

        // Start periodic health checks
        if (healthCheckInterval > 0) {
          this._startHealthChecks(healthCheckInterval);
        }

        // Fetch and populate available models
        await this.populateModels();

        // Pre-build tools cache — LLM_ACTIONS is static, no need to rebuild per cycle
        this._toolsCache = this._buildTools();

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
    this._toolsCache = null;
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
        const storedModel = this.getConfigValue("model_name", "");

        // Clear existing options
        modelSelect.innerHTML = "";

        // Add model options
        let hasStoredModel = false;
        models.forEach((model) => {
          const option = document.createElement("option");
          option.value = model.name;
          option.textContent = model.name;
          if (model.name === storedModel) {
            option.selected = true;
            hasStoredModel = true;
          }
          modelSelect.appendChild(option);
        });

        // If stored model not found (or empty), auto-select first and persist
        if (!hasStoredModel) {
          modelSelect.selectedIndex = 0;
          const firstName = models[0].name;
          this.setConfigValue("model_name", firstName);
          this.log(`🤖 Auto-selected model: ${firstName}`);
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
   * Send messages to Ollama chat/completions API.
   * Returns the full message object (role, content, tool_calls) from choices[0].message.
   * Pass `options.tools` for function-calling.
   */
  async chatRaw(messages, options = {}) {
    if (!this.isConnected()) {
      throw new Error("Not connected to Ollama server");
    }

    const baseUrl = this.getConfigValue("base_url", "http://localhost:11434");
    const model = this.getConfigValue("model_name", "");
    const temperature = parseFloat(this.getConfigValue("temperature", "0.7"));
    const maxTokens = parseInt(this.getConfigValue("max_tokens", "512"));
    const numCtx = parseInt(this.getConfigValue("num_ctx", "8192"));
    const timeout = parseInt(this.getConfigValue("timeout", "30000"));

    const {
      model: overrideModel,
      temperature: overrideTemp,
      maxTokens: overrideMaxTokens,
      tools,
    } = options;

    const requestBody = {
      model: overrideModel || model,
      messages,
      temperature: overrideTemp !== undefined ? overrideTemp : temperature,
      max_tokens:
        overrideMaxTokens !== undefined ? overrideMaxTokens : maxTokens,
      options: { num_ctx: numCtx },
    };

    if (tools && tools.length > 0) {
      requestBody.tools = tools;
      requestBody.tool_choice = "auto";
    }

    if (window.DEBUG)
      console.log("[LLM] →", JSON.parse(JSON.stringify(requestBody)));

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () =>
          controller.abort(new Error(`Request timed out after ${timeout}ms`)),
        timeout,
      );

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
      const message = data.choices?.[0]?.message || {
        role: "assistant",
        content: "",
      };
      if (window.DEBUG)
        console.log("[LLM] ←", JSON.parse(JSON.stringify(message)));

      // Non-streaming reasoning — show as pre-filled collapsed block
      const reasoning = message.reasoning_content || message.reasoning;
      if (reasoning) {
        this._clearThinking();
        this._streamThinking(reasoning);
        this._collapseThinking();
      }

      return message;
    } catch (error) {
      const msg =
        error.name === "AbortError"
          ? (error.cause?.message ?? `Request timed out after ${timeout}ms`)
          : error.message;
      this.log(`💥 ChatRaw failed: ${msg}`);
      throw new Error(msg);
    }
  }

  /**
   * Streaming variant of chatRaw.
   * Pipes reasoning_content tokens to the thinking block live.
   * Returns the same assembled message object as chatRaw when done.
   */
  async chatRawStreaming(messages, options = {}) {
    if (!this.isConnected()) throw new Error("Not connected to Ollama server");

    const baseUrl = this.getConfigValue("base_url", "http://localhost:11434");
    const model = this.getConfigValue("model_name", "");
    const temperature = parseFloat(this.getConfigValue("temperature", "0.7"));
    const maxTokens = parseInt(this.getConfigValue("max_tokens", "512"));
    const numCtx = parseInt(this.getConfigValue("num_ctx", "8192"));
    const timeout = parseInt(this.getConfigValue("timeout", "30000"));
    const { model: overrideModel, temperature: overrideTemp, maxTokens: overrideMaxTokens, tools } = options;

    const requestBody = {
      model: overrideModel || model,
      messages,
      temperature: overrideTemp !== undefined ? overrideTemp : temperature,
      max_tokens: overrideMaxTokens !== undefined ? overrideMaxTokens : maxTokens,
      options: { num_ctx: numCtx },
      stream: true,
    };
    if (tools?.length > 0) {
      requestBody.tools = tools;
      requestBody.tool_choice = "auto";
    }

    if (window.DEBUG) console.log("[LLM streaming] →", JSON.parse(JSON.stringify(requestBody)));

    this._clearThinking();

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(new Error(`Request timed out after ${timeout}ms`)),
      timeout,
    );

    try {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      // Assembled final message
      let role = "assistant";
      let content = "";
      let toolCalls = null; // {index -> {id, name, arguments_str}}
      // <think> tag parser state — fallback for models that embed thinking in content
      let inThinkTag = false;
      let thinkBuf = ""; // partial tag accumulation across chunks

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const json = trimmed.slice(5).trim();
          if (json === "[DONE]") continue;

          let delta;
          try { delta = JSON.parse(json).choices?.[0]?.delta; } catch { continue; }
          if (!delta) continue;

          if (delta.role) role = delta.role;

          // Reasoning/thinking tokens — dedicated field (Qwen3 via Ollama ≥0.6)
          if (delta.reasoning_content) {
            this._streamThinking(delta.reasoning_content);
          }

          // Regular content — also handles <think>…</think> tag fallback
          if (delta.content) {
            // Route tokens: inside <think> → thinking block, outside → content
            let raw = thinkBuf + delta.content;
            thinkBuf = "";
            while (raw.length > 0) {
              if (inThinkTag) {
                const end = raw.indexOf("</think>");
                if (end === -1) {
                  // Whole chunk is thinking
                  this._streamThinking(raw);
                  raw = "";
                } else {
                  this._streamThinking(raw.slice(0, end));
                  inThinkTag = false;
                  raw = raw.slice(end + 8); // skip </think>
                }
              } else {
                const start = raw.indexOf("<think>");
                if (start === -1) {
                  // Check for partial tag at end of chunk
                  const partialStart = raw.lastIndexOf("<");
                  if (partialStart !== -1 && "<think>".startsWith(raw.slice(partialStart))) {
                    content += raw.slice(0, partialStart);
                    thinkBuf = raw.slice(partialStart);
                    raw = "";
                  } else {
                    content += raw;
                    raw = "";
                  }
                } else {
                  content += raw.slice(0, start);
                  inThinkTag = true;
                  raw = raw.slice(start + 7); // skip <think>
                }
              }
            }
          }

          // Tool calls — streamed as partial argument strings
          if (delta.tool_calls) {
            if (!toolCalls) toolCalls = {};
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCalls[idx]) {
                toolCalls[idx] = { id: tc.id ?? "", name: tc.function?.name ?? "", arguments_str: "" };
              }
              if (tc.function?.name) toolCalls[idx].name = tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].arguments_str += tc.function.arguments;
            }
          }
        }
      }

      clearTimeout(timeoutId);
      this._collapseThinking();

      // Assemble final message matching chatRaw output format
      const message = { role, content: content || null };
      if (toolCalls) {
        message.tool_calls = Object.values(toolCalls).map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments_str },
        }));
      }

      if (window.DEBUG) console.log("[LLM streaming] ←", JSON.parse(JSON.stringify(message)));
      return message;

    } catch (error) {
      clearTimeout(timeoutId);
      this._collapseThinking();
      const msg = error.name === "AbortError"
        ? (error.cause?.message ?? `Request timed out after ${timeout}ms`)
        : error.message;
      this.log(`💥 ChatRaw streaming failed: ${msg}`);
      throw new Error(msg);
    }
  }

  // ===========================================================================
  // PERSISTENT MEMORY
  // ===========================================================================

  /**
   * Load memory text from localStorage.
   * @returns {string}
   */
  _loadMemory() {
    return localStorage.getItem(MEMORY_STORAGE_KEY) || "";
  }

  /**
   * Append a note to persistent memory and trigger compression if needed.
   * @param {string} note
   */
  async _appendMemory(note) {
    const current = this._loadMemory();
    const updated = current ? `${current}\n${note}` : note;
    localStorage.setItem(MEMORY_STORAGE_KEY, updated);
    this._refreshMemoryModal();

    const lineCount = updated.split("\n").filter((l) => l.trim()).length;
    if (lineCount >= MEMORY_COMPRESS_THRESHOLD) {
      await this._compressMemory(updated);
      this._refreshMemoryModal(); // refresh again after compression
    }
  }

  /**
   * Ask LLM in a separate session to compress memory text.
   * Replaces MEMORY in localStorage with the condensed version.
   * @param {string} memoryText
   */
  async _compressMemory(memoryText) {
    this.log(
      `🧠 Memory at ${MEMORY_COMPRESS_THRESHOLD}+ lines — compressing...`,
    );

    try {
      const messages = [
        {
          role: "system",
          content:
            "You are a memory compression assistant. Your job is to take a list of notes and rewrite them as a concise, information-dense summary. Remove duplicates, merge related facts, preserve all unique details. Output only the compressed notes — no commentary, no formatting, just the condensed text.",
        },
        {
          role: "user",
          content: `Compress these notes:\n\n${memoryText}`,
        },
      ];

      const result = await this.chatRaw(messages, {
        maxTokens: 8196,
        temperature: 0.1,
      });
      const compressed = result?.content?.trim();

      if (compressed) {
        localStorage.setItem(MEMORY_STORAGE_KEY, compressed);
        const before = memoryText.split("\n").filter((l) => l.trim()).length;
        const after = compressed.split("\n").filter((l) => l.trim()).length;
        this.log(`🧠 Memory compressed: ${before} → ${after} lines`);
      } else {
        this.log(`⚠️ Memory compression returned empty — keeping original`);
      }
    } catch (err) {
      this.log(`💥 Memory compression failed: ${err.message}`);
    }
  }

  /**
   * Build system prompt string, prepending persistent memory if present.
   * @returns {string}
   */
  _buildSystemPrompt(extra = "") {
    const configDef = this.getConfig().model.system_prompt;
    const base = this.getConfigValue("system_prompt", "") || configDef.default;
    const memory = this._loadMemory();
    const memoryBlock = memory
      ? `[MEMORY — facts you have learned and stored]\n${memory}\n[/MEMORY]\n\n`
      : "";
    const aliases = this.getBotAliases();
    const nameBlock = `Your names is ${aliases.join(" either ")}.`;
    // Thinking mode soft switch — prepend /no_think to suppress Qwen3/R1 reasoning tokens
    const thinkingEnabled = this.getConfigValue("thinking", "false") === "true";
    const thinkPrefix = thinkingEnabled ? "" : "/no_think\n";
    return `${thinkPrefix}${memoryBlock}${nameBlock}\n\n${base}${extra ? `\n\n${extra}` : ""}`;
  }

  // ===========================================================================

  /**
   * Build OpenAI-compatible tools array from LLM_ACTIONS.
   * Key format: "name  description" (first word is function name, rest is description).
   * Injects built-in tools: nothing, respond, remember.
   */
  _buildTools() {
    const tools = [];

    // Built-in tools always present
    tools.push({
      type: "function",
      function: {
        name: "nothing",
        description: "Do nothing, wait till something happens.",
        parameters: { type: "object", properties: {} },
      },
    });

    tools.push({
      type: "function",
      function: {
        name: "respond",
        description: "Respond to chat with a message.",
        parameters: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "Message to send to Twitch chat",
            },
          },
          required: ["message"],
        },
      },
    });

    tools.push({
      type: "function",
      function: {
        name: "remember",
        description:
          "Store an internal memory note visible in future chat history.",
        parameters: {
          type: "object",
          properties: {
            message: { type: "string", description: "Note to remember" },
          },
          required: ["message"],
        },
      },
    });

    // LLM_ACTIONS: key is "name  description", value is action closure
    for (const key of Object.keys(LLM_ACTIONS)) {
      const spaceIdx = key.indexOf("  ");
      const name = spaceIdx >= 0 ? key.slice(0, spaceIdx).trim() : key.trim();
      const description = spaceIdx >= 0 ? key.slice(spaceIdx + 2).trim() : "";

      tools.push({
        type: "function",
        function: {
          name,
          description,
          parameters: {
            type: "object",
            properties: {
              user: {
                type: "string",
                description: "Target user if applicable",
              },
              message: { type: "string", description: "Arguments of function" },
            },
          },
        },
      });
    }

    return tools;
  }

  /**
   * Resolve action closure by tool name from LLM_ACTIONS.
   * Returns null if not found.
   */
  _resolveAction(name) {
    for (const [key, closure] of Object.entries(LLM_ACTIONS)) {
      const spaceIdx = key.indexOf("  ");
      const actionName =
        spaceIdx >= 0 ? key.slice(0, spaceIdx).trim() : key.trim();
      if (actionName === name) return closure;
    }
    return null;
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
   * Shared tool-call loop used by monitorChat (and any future callers).
   *
   * Executes up to MAX_TOOL_ITERATIONS rounds:
   *   - nothing()   → stop
   *   - respond()   → send to chat, add to history, update log
   *   - remember()  → append to persistent memory
   *   - LLM_ACTIONS → execute closure, return result
   *
   * @param {Array}             messages   - Mutable conversation array (modified in place)
   * @param {Array}             tools      - OpenAI tools array from _buildTools()
   * @param {TwitchChatModule}  chatModule - Chat module for send / history
   * @param {Object}            context    - Execution context for LLM_ACTIONS
   * @param {string}            fallbackUser - Default user when not in args (e.g. last in history)
   */
  async _runToolLoop(messages, tools, chatModule, context, fallbackUser) {
    const thinkingEnabled = this.getConfigValue("thinking", "false") === "true";
    const chat = thinkingEnabled
      ? (msgs, opts) => this.chatRawStreaming(msgs, opts)
      : (msgs, opts) => this.chatRaw(msgs, opts);

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const assistantMsg = await chat(messages, { tools });
      messages.push(assistantMsg);

      const toolCalls = assistantMsg.tool_calls;

      if (!toolCalls || toolCalls.length === 0) {
        this.log(`🤖 LLM plain text response — stopping cycle`);
        break;
      }

      let shouldStop = false;

      for (const call of toolCalls) {
        const name = call.function?.name;
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || "{}");
        } catch {
          args = {};
        }

        this.log(`🔧 LLM tool call: ${name}(${JSON.stringify(args)})`);

        let toolResult;

        if (name === "nothing") {
          this.log(`🤖 LLM chose nothing — stopping cycle`);
          shouldStop = true;
          toolResult = "Function has no result";
        } else if (name === "respond") {
          const msg = args.message?.trim();
          if (msg && chatModule) {
            const sent = chatModule.send(msg);
            this.log(
              sent
                ? `📤 LLM responded: "${msg}"`
                : `💥 Failed to send LLM response`,
            );
            if (sent) {
              chatModule._addToChatHistory(this.getBotName(), msg);
              this._updateChatLog(chatModule.formatChatHistoryForLLM());
            }
            toolResult = sent
              ? "Message sent to chat"
              : "Failed to send message";
          } else {
            toolResult = "Empty message or no chat module";
          }
        } else if (name === "remember") {
          const note = args.message?.trim();
          if (note) {
            await this._appendMemory(note);
            this.log(`🧠 LLM memory stored: "${note}"`);
            toolResult = "Note stored in persistent memory";
          } else {
            toolResult = "Empty note, nothing stored";
          }
        } else {
          const closure = this._resolveAction(name);
          if (closure) {
            try {
              const user =
                args.user ||
                fallbackUser ||
                getBroadcasterUsername() ||
                "unknown";
              const message = args.message || "";
              const result = await closure(context, user, message);
              toolResult =
                result !== undefined
                  ? `Result: ${JSON.stringify(result)}`
                  : "Function has no result";
              this.log(`✅ Action "${name}" executed — ${toolResult}`);
            } catch (err) {
              toolResult = `Error: ${err.message}`;
              this.log(`💥 Action "${name}" failed: ${err.message}`);
            }
          } else {
            toolResult = `Unknown tool: ${name}`;
            this.log(`⚠️ Unknown tool called: ${name}`);
          }
        }

        messages.push({
          role: "tool",
          name,
          content: JSON.stringify({ result: toolResult }),
        });
      }

      if (shouldStop) break;

      messages.push({
        role: "user",
        content: "Do you want to execute something else?",
      });
    }
  }

  /**
   * Monitor chat and react using tool-call loop.
   *
   * Flow:
   * 1. Build tools from LLM_ACTIONS + built-ins (nothing, respond, remember)
   * 2. Send chat history to LLM with tools
   * 3. _runToolLoop handles the iteration:
   *    - respond(message) → send to Twitch chat
   *    - remember(message) → persist to MEMORY
   *    - nothing() → stop
   *    - LLM_ACTIONS tool → execute closure
   * 4. Advance chatMarkerPosition after full cycle
   *
   * @param {TwitchChatModule} chatModule - Chat module reference
   * @param {Object} context - Execution context for actions
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

    const chatHistory = chatModule.getChatHistory();
    const markerPosition = chatModule.getChatMarkerPosition();

    if (markerPosition >= chatHistory.length) {
      return;
    }

    this.log("🤖 LLM processing chat batch...");
    this._setIndicator("busy");

    try {
      const chatLog = chatModule.formatChatHistoryForLLM();
      this._updateChatLog(chatLog);

      const tools = this._toolsCache ?? this._buildTools();
      const fallbackUser =
        chatHistory[chatHistory.length - 1]?.username || "unknown";

      const messages = [
        {
          role: "system",
          content: `${this._buildSystemPrompt()}

${this.getConfigValue("rules", "") || this.getConfig().features.rules.default}`,
        },
        {
          role: "user",
          content: `Here is the chat history:\n${chatLog}\n\nReact to the new messages using available tools.`,
        },
      ];

      await this._runToolLoop(
        messages,
        tools,
        chatModule,
        context,
        fallbackUser,
      );

      // Advance marker — done after full cycle
      chatModule.setChatMarkerPosition(chatHistory.length);
      this._setIndicator("idle");
    } catch (error) {
      // Advance marker even on failure to avoid retrying the same batch
      chatModule.setChatMarkerPosition(chatHistory.length);
      this._setIndicator("error");
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
