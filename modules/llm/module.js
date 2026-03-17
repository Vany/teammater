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

// Indicator state → CSS class + tooltip title
const INDICATOR = {
  idle:         { cls: "llm-icon-idle",         title: "LLM ready" },
  busy:         { cls: "llm-icon-busy",         title: "LLM generating…" },
  error:        { cls: "llm-icon-error",         title: "LLM error" },
  disconnected: { cls: "llm-icon-disconnected", title: "LLM disconnected" },
};

export class LLMModule extends BaseModule {
  constructor() {
    super();
    this.healthCheckTimer = null;
    this.lastHealthCheck = null;

    // Cached tools array — built once on connect, invalidated on disconnect
    this._toolsCache = null;

    // Lazily-built Map<actionName, closure> derived from LLM_ACTIONS keys
    this._actionsMap = null;

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

    // 🤖 emoji icon in module header — serves as the color state indicator
    // (replaces the standard status dot for LLM)
    this._llmIconEl = null;

    // Live chat log handler registered on first modal open
    this._chatLogHandler = null;
  }

  // ===========================================================================
  // MODULE IDENTITY
  // ===========================================================================

  getDisplayName() {
    return "LLM";
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

  // ===========================================================================
  // INITIALIZATION & DOM
  // ===========================================================================

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

    // 🤖 icon — model state indicator (idle/busy/error), placed right after the
    // connection dot. Dot = Ollama reachable; 🤖 = model actively working or idle.
    const llmIcon = document.createElement("span");
    llmIcon.className = "llm-icon llm-icon-disconnected";
    llmIcon.title = "LLM model state";
    llmIcon.textContent = "🤖";
    this._llmIconEl = llmIcon;
    const header = this.ui.container.querySelector(".module-header");
    this.ui.statusIndicator.after(llmIcon);

    // Memory toggle button — inserted before ⚙️ (config toggle) so order is: 🧠 💾 ⚙️
    const memBtn = document.createElement("button");
    memBtn.className = "control-toggle";
    memBtn.textContent = "💾";
    memBtn.title = "Show memory";
    memBtn.addEventListener("click", () => this._toggleMemoryModal());
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
      this._saveMemory(textarea.value);
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
   * Render control panel — shows real-time chat context sent to LLM + direct input.
   * Called once at init by base class (modal body is built here).
   */
  renderControlPanel() {
    const container = document.createElement("div");
    container.className = "llm-chat-panel";

    // Header row: title + clear button
    const headerRow = document.createElement("div");
    headerRow.className = "llm-panel-header";

    const heading = document.createElement("h3");
    heading.textContent = "Chat context";
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
      this._refreshChatLog();
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
    input.placeholder = "Send direct message to LLM… (Enter)";
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

      const ownerName = this._getOwnerName();
      chatModule._addToChatHistory(ownerName, text);
      chatModule._notifyMessageHandlers({
        username: ownerName,
        message: text,
        tags: { "user-id": "direct-input" },
        userId: "direct-input",
        messageId: null,
        rawData: `direct://${ownerName}/${text}`,
        source: "direct",
      });
    });

    container.appendChild(input);

    // Thinking block — reuse the element created in initialize()
    container.appendChild(this._thinkingDetailsEl);

    // Keep reference for real-time updates
    this._chatLogEl = log;

    return container;
  }

  /**
   * Override toggleControlModal to refresh log on open and register live handler.
   */
  toggleControlModal() {
    super.toggleControlModal();

    const isOpen = this.ui.controlModal?.style.display !== "none";
    if (!isOpen) return;

    this._refreshChatLog();

    // Register live message handler if not already registered
    if (!this._chatLogHandler) {
      const chatModule = this.moduleManager?.get("twitch-chat");
      if (chatModule) {
        this._chatLogHandler = () => this._refreshChatLog();
        chatModule.registerMessageHandler(this._chatLogHandler, -100);
      }
    }
  }

  /**
   * Pull latest chat history and render it.
   * If twitch-chat module is live, use its formatter (includes marker).
   * Otherwise fall back to reading the "CHAT" localStorage key directly
   * so the log is populated even before Twitch Chat connects.
   */
  _refreshChatLog() {
    const chatModule = this.moduleManager?.get("twitch-chat");
    if (chatModule) {
      this._updateChatLog(chatModule.formatChatHistoryForLLM());
      return;
    }

    // Fallback: read raw storage
    try {
      const raw = localStorage.getItem("CHAT");
      if (!raw) { this._updateChatLog("(no chat context yet)"); return; }
      const entries = JSON.parse(raw);
      if (!entries.length) { this._updateChatLog("(no chat context yet)"); return; }
      const lines = entries.map((e) => {
        const ts = new Date(e.timestamp).toLocaleTimeString("en-US", {
          hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
        });
        return `[${ts}] ${e.username}: ${e.message}`;
      });
      this._updateChatLog(lines.join("\n"));
    } catch {
      this._updateChatLog("(no chat context yet)");
    }
  }

  /**
   * Render text into the chat log element.
   * Highlights " -> new messages:" marker lines.
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

  // ===========================================================================
  // THINKING BLOCK HELPERS
  // ===========================================================================

  /**
   * Guard helper — executes fn() only when both thinking DOM elements exist.
   * Eliminates repeated null checks in _streamThinking/_collapseThinking/_clearThinking.
   */
  _thinkingOp(fn) {
    if (!this._thinkingDetailsEl || !this._thinkingTextEl) return;
    fn();
  }

  /** Show thinking block and append a token to it (called during streaming) */
  _streamThinking(token) {
    this._thinkingOp(() => {
      this._thinkingDetailsEl.style.display = "";
      this._thinkingDetailsEl.open = true;
      this._thinkingTextEl.textContent += token;
      this._thinkingTextEl.scrollTop = this._thinkingTextEl.scrollHeight;
    });
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
    this._thinkingOp(() => {
      this._thinkingDetailsEl.style.display = "none";
      this._thinkingDetailsEl.open = false;
      this._thinkingTextEl.textContent = "";
      const summary = this._thinkingDetailsEl.querySelector("summary");
      if (summary) summary.textContent = "🧠 Thinking…";
    });
  }

  // ===========================================================================
  // INDICATOR
  // ===========================================================================

  /**
   * Set 🤖 icon state: "idle" | "busy" | "error" | "disconnected"
   */
  _setIndicator(state) {
    const icon = this._llmIconEl;
    if (!icon) return;
    icon.classList.remove(
      "llm-icon-idle",
      "llm-icon-busy",
      "llm-icon-error",
      "llm-icon-disconnected",
    );
    const def = INDICATOR[state] ?? INDICATOR.disconnected;
    icon.classList.add(def.cls);
    icon.title = def.title;
  }

  // ===========================================================================
  // CONNECTION
  // ===========================================================================

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

        if (healthCheckInterval > 0) {
          this.healthCheckTimer = setInterval(() => this.checkHealth(), healthCheckInterval);
        }

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
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    this._toolsCache = null;
    this._setIndicator("disconnected");
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
          this._setIndicator("idle");
          this.log(`✅ Ollama server is back online`);
        } else {
          this._setIndicator("disconnected");
          this.log(`⚠️ Ollama server stopped responding`);
        }
      }

      return isHealthy;
    } catch (error) {
      const wasConnected = this.connected;

      if (wasConnected) {
        this.updateStatus(false);
        this._setIndicator("disconnected");
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

      const modelSelect = this.ui.configPanel?.querySelector(
        'select[stored_as="llm_model"]',
      );
      if (modelSelect) {
        const storedModel = this.getConfigValue("model_name", "");

        modelSelect.innerHTML = "";

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

  // ===========================================================================
  // LLM API — SHARED HELPERS
  // ===========================================================================

  /**
   * Read generation config values in one place.
   * @returns {{baseUrl:string, model:string, temperature:number, maxTokens:number, numCtx:number, timeout:number}}
   */
  _readConfig() {
    return {
      baseUrl:     this.getConfigValue("base_url", "http://localhost:11434"),
      model:       this.getConfigValue("model_name", ""),
      temperature: parseFloat(this.getConfigValue("temperature", "0.7")),
      maxTokens:   parseInt(this.getConfigValue("max_tokens", "512")),
      numCtx:      parseInt(this.getConfigValue("num_ctx", "8192")),
      timeout:     parseInt(this.getConfigValue("timeout", "30000")),
    };
  }

  /**
   * Build the Ollama-compatible request body.
   * Config values are merged with per-call option overrides.
   * @param {Array}   messages
   * @param {Object}  options   - {model, temperature, maxTokens, tools}
   * @param {boolean} stream
   * @returns {Object}
   */
  _buildRequestBody(messages, options, stream = false) {
    const { model, temperature, maxTokens, numCtx } = this._readConfig();
    const { model: overrideModel, temperature: overrideTemp, maxTokens: overrideMaxTokens, tools } = options;

    const body = {
      model:       overrideModel || model,
      messages,
      temperature: overrideTemp     !== undefined ? overrideTemp     : temperature,
      max_tokens:  overrideMaxTokens !== undefined ? overrideMaxTokens : maxTokens,
      options:     { num_ctx: numCtx },
    };

    if (stream) body.stream = true;

    if (tools?.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    return body;
  }

  /**
   * Perform the fetch to /v1/chat/completions with abort-on-timeout.
   * Returns the raw Response — callers decide whether to .json() or stream it.
   * @param {string} url
   * @param {Object} body
   * @param {number} timeout  ms
   * @returns {Promise<{response: Response, clearTimeout: Function}>}
   */
  async _fetchChat(url, body, timeout) {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(new Error(`Request timed out after ${timeout}ms`)),
      timeout,
    );

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      clearTimeout(timeoutId);
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Return both response and a way to clear the timer — streaming callers
    // must call clearTimer() after they finish reading the body.
    return { response, clearTimer: () => clearTimeout(timeoutId) };
  }

  // ===========================================================================
  // LLM API — PUBLIC
  // ===========================================================================

  /**
   * Send messages to Ollama chat/completions API (non-streaming).
   * Returns the full message object (role, content, tool_calls) from choices[0].message.
   * Pass `options.tools` for function-calling.
   */
  async chatRaw(messages, options = {}) {
    if (!this.isConnected()) {
      throw new Error("Not connected to Ollama server");
    }

    const { baseUrl, timeout } = this._readConfig();
    const requestBody = this._buildRequestBody(messages, options, false);

    if (window.DEBUG)
      console.log("[LLM] →", JSON.parse(JSON.stringify(requestBody)));

    try {
      const { response, clearTimer } = await this._fetchChat(
        `${baseUrl}/v1/chat/completions`,
        requestBody,
        timeout,
      );

      clearTimer();

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

    const { baseUrl, timeout } = this._readConfig();
    const requestBody = this._buildRequestBody(messages, options, true);

    if (window.DEBUG) console.log("[LLM streaming] →", JSON.parse(JSON.stringify(requestBody)));

    this._clearThinking();

    let response, clearTimer;
    try {
      ({ response, clearTimer } = await this._fetchChat(
        `${baseUrl}/v1/chat/completions`,
        requestBody,
        timeout,
      ));
    } catch (error) {
      this._collapseThinking();
      const msg = error.name === "AbortError"
        ? (error.cause?.message ?? `Request timed out after ${timeout}ms`)
        : error.message;
      this.log(`💥 ChatRaw streaming failed: ${msg}`);
      throw new Error(msg);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    // Assembled final message
    let role = "assistant";
    let content = "";
    let toolCalls = null; // {index -> {id, name, arguments_str}}
    // <think> tag parser state — fallback for models that embed thinking in content
    let inThinkTag = false;
    let thinkBuf = ""; // partial tag accumulation across chunks

    try {
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

      clearTimer();
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
      clearTimer();
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
   * Persist memory text to localStorage.
   * Single write point — all callers use this instead of setItem directly.
   * @param {string} text
   */
  _saveMemory(text) {
    localStorage.setItem(MEMORY_STORAGE_KEY, text);
  }

  /**
   * Append a note to persistent memory and trigger compression if needed.
   * @param {string} note
   */
  async _appendMemory(note) {
    const current = this._loadMemory();
    const updated = current ? `${current}\n${note}` : note;
    this._saveMemory(updated);
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
        this._saveMemory(compressed);
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
  // TOOLS & ACTIONS
  // ===========================================================================

  /**
   * Lazily build and cache the Map<actionName, closure> from LLM_ACTIONS.
   * Key format: "name  description" (two spaces separate name from description).
   */
  _getActionsMap() {
    if (this._actionsMap) return this._actionsMap;
    this._actionsMap = new Map();
    for (const [key, closure] of Object.entries(LLM_ACTIONS)) {
      const spaceIdx = key.indexOf("  ");
      const name = spaceIdx >= 0 ? key.slice(0, spaceIdx).trim() : key.trim();
      this._actionsMap.set(name, closure);
    }
    return this._actionsMap;
  }

  /**
   * Resolve action closure by tool name.
   * @param {string} name
   * @returns {Function|undefined}
   */
  _resolveAction(name) {
    return this._getActionsMap().get(name);
  }

  /**
   * Wrap a function definition into the OpenAI tool descriptor shape.
   * @param {string} name
   * @param {string} description
   * @param {Object} parameters  JSON-schema parameters object
   * @returns {Object}
   */
  _tool(name, description, parameters) {
    return { type: "function", function: { name, description, parameters } };
  }

  /**
   * Build OpenAI-compatible tools array from LLM_ACTIONS + built-ins.
   * Built-ins: nothing, respond, remember.
   */
  _buildTools() {
    const tools = [
      this._tool("nothing", "Do nothing, wait till something happens.", {
        type: "object",
        properties: {},
      }),
      this._tool("respond", "Respond to chat with a message.", {
        type: "object",
        properties: {
          message: { type: "string", description: "Message to send to Twitch chat" },
        },
        required: ["message"],
      }),
      this._tool(
        "remember",
        "Store an internal memory note visible in future chat history.",
        {
          type: "object",
          properties: {
            message: { type: "string", description: "Note to remember" },
          },
          required: ["message"],
        },
      ),
    ];

    // Action tools share a common parameter schema
    const actionParams = {
      type: "object",
      properties: {
        user:    { type: "string", description: "Target user if applicable" },
        message: { type: "string", description: "Arguments of function" },
      },
    };

    for (const [key] of Object.entries(LLM_ACTIONS)) {
      const spaceIdx = key.indexOf("  ");
      const name        = spaceIdx >= 0 ? key.slice(0, spaceIdx).trim() : key.trim();
      const description = spaceIdx >= 0 ? key.slice(spaceIdx + 2).trim() : "";
      tools.push(this._tool(name, description, actionParams));
    }

    return tools;
  }

  // ===========================================================================
  // OWNER NAME RESOLUTION
  // ===========================================================================

  /**
   * Resolve the stream owner's display name.
   * Priority: echowire localStorage config → getBroadcasterUsername() → "owner"
   * Mirrors the resolution order used in echowire's _forwardToLLM.
   * @returns {string}
   */
  _getOwnerName() {
    return (
      localStorage.getItem("echowire_owner")?.trim() ||
      getBroadcasterUsername() ||
      "owner"
    );
  }

  // ===========================================================================
  // UTILITY
  // ===========================================================================

  /**
   * Get time since last successful health check
   */
  getLastHealthCheckAge() {
    if (!this.lastHealthCheck) return null;
    return Date.now() - this.lastHealthCheck;
  }

  // ===========================================================================
  // TOOL-CALL LOOP
  // ===========================================================================

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
              this._refreshChatLog();
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

  // ===========================================================================
  // MONITOR CHAT
  // ===========================================================================

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
      this._refreshChatLog();

      // TODO: remove once ACTION messages are handled properly upstream
      // Strip /me (ACTION) lines — \x01ACTION...\x01 clutters context without value
      const filteredLog = chatLog
        .split("\n")
        .filter((line) => !line.includes("\x01ACTION"))
        .join("\n");

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
          content: `Here is the chat history:\n${filteredLog}\n\nReact to the new messages using available tools.`,
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

  // ===========================================================================
  // EXTERNAL API
  // ===========================================================================

  /**
   * Provide context for actions
   * Returns module reference — actions access methods directly
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
