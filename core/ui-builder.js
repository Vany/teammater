/**
 * UI Builder
 *
 * Utility for auto-generating module UI components from config schemas.
 * Handles:
 * - Module containers with headers
 * - Status indicators
 * - Config panels with auto-generated form fields
 * - Control modals
 * - localStorage binding for config persistence
 */

export class UIBuilder {
  /**
   * Create module container with header
   * @param {string} moduleId - Module identifier
   * @param {string} displayName - Display name for module
   * @returns {HTMLElement} - Module container div
   */
  createModuleContainer(moduleId, displayName) {
    const container = document.createElement("div");
    container.className = "module";
    container.dataset.module = moduleId;

    const header = document.createElement("div");
    header.className = "module-header";

    const title = document.createElement("h3");
    title.textContent = displayName;
    header.appendChild(title);

    container.appendChild(header);

    return container;
  }

  /**
   * Create status indicator (colored dot)
   * @returns {HTMLElement} - Status indicator span
   */
  createStatusIndicator() {
    const indicator = document.createElement("span");
    indicator.className = "status-indicator disconnected";
    indicator.title = "Connection status";
    return indicator;
  }

  /**
   * Create enable checkbox for module
   * @param {string} moduleId - Module identifier
   * @param {boolean} initialEnabled - Initial enabled state
   * @param {Function} onChange - Change handler
   * @returns {HTMLElement} - Checkbox label element
   */
  createEnableCheckbox(moduleId, initialEnabled, onChange) {
    const label = document.createElement("label");
    label.className = "module-enable-label";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "module-enable-checkbox";

    // Set stored_as attribute for persistence
    const storageKey = `${moduleId}_enabled`;
    checkbox.setAttribute("stored_as", storageKey);

    // Restore from localStorage if available
    const storedValue = localStorage.getItem(storageKey);
    checkbox.checked =
      storedValue !== null ? storedValue === "true" : initialEnabled;

    checkbox.addEventListener("change", (e) => {
      // Save to localStorage
      localStorage.setItem(storageKey, e.target.checked.toString());
      onChange(e.target.checked);
    });

    label.appendChild(checkbox);
    return label;
  }

  /**
   * Create config toggle button (purple gear)
   * @param {Function} onClick - Click handler
   * @returns {HTMLElement} - Config toggle button
   */
  createConfigToggle(onClick) {
    const button = document.createElement("button");
    button.className = "config-toggle";
    button.textContent = "⚙️";
    button.title = "Toggle configuration";
    button.addEventListener("click", onClick);
    return button;
  }

  /**
   * Create control toggle button (for modal)
   * @param {Function} onClick - Click handler
   * @returns {HTMLElement} - Control toggle button
   */
  createControlToggle(onClick) {
    const button = document.createElement("button");
    button.className = "control-toggle";
    button.textContent = "🎵";
    button.title = "Show controls";
    button.addEventListener("click", onClick);
    return button;
  }

  /**
   * Create config panel from schema
   * Auto-generates form fields based on config schema
   *
   * @param {Object} configSchema - Config schema object
   * @param {string} moduleId - Module identifier (for localStorage keys)
   * @returns {HTMLElement} - Config panel div
   *
   * Schema format:
   * {
   *   section_name: {
   *     field_name: {
   *       type: 'text'|'number'|'checkbox'|'select'|'range'|'textarea',
   *       label: 'Field Label',
   *       default: default_value,
   *       stored_as: 'localStorage_key' (optional, defaults to moduleId_field_name),
   *       options: [...] (for select),
   *       min/max/step: (for range/number)
   *     }
   *   }
   * }
   */
  createConfigPanel(configSchema, moduleId) {
    const panel = document.createElement("div");
    panel.className = "config-panel collapsed";

    // Iterate through sections
    for (const [sectionName, fields] of Object.entries(configSchema)) {
      // Create section header
      const sectionHeader = document.createElement("h4");
      sectionHeader.textContent = this._formatSectionName(sectionName);
      sectionHeader.className = "config-section-header";
      panel.appendChild(sectionHeader);

      // Create fields
      for (const [fieldName, fieldConfig] of Object.entries(fields)) {
        const fieldElement = this._createField(
          fieldName,
          fieldConfig,
          moduleId,
        );
        panel.appendChild(fieldElement);
      }
    }

    return panel;
  }

  /**
   * Create control modal
   * @param {string} moduleId - Module identifier
   * @param {string} displayName - Display name for modal title
   * @param {Function} renderContent - Function that returns modal content element
   * @returns {HTMLElement} - Modal div
   */
  createControlModal(moduleId, displayName, renderContent) {
    const modal = document.createElement("div");
    modal.className = "control-modal";
    modal.dataset.module = moduleId;
    modal.style.display = "none";

    // Modal overlay
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.addEventListener("click", () => {
      modal.style.display = "none";
    });

    // Modal content
    const content = document.createElement("div");
    content.className = "modal-content";

    // Modal header
    const header = document.createElement("div");
    header.className = "modal-header";

    const title = document.createElement("h2");
    title.textContent = displayName;
    header.appendChild(title);

    const closeBtn = document.createElement("button");
    closeBtn.className = "modal-close";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => {
      modal.style.display = "none";
    });
    header.appendChild(closeBtn);

    content.appendChild(header);

    // Modal body (rendered by module)
    const body = document.createElement("div");
    body.className = "modal-body";
    const renderedContent = renderContent();
    if (renderedContent) {
      body.appendChild(renderedContent);
    }
    content.appendChild(body);

    modal.appendChild(overlay);
    modal.appendChild(content);

    return modal;
  }

  /**
   * Create form field from config
   * @private
   */
  _createField(fieldName, fieldConfig, moduleId) {
    const container = document.createElement("div");
    container.className = "config-field";

    const {
      type,
      label,
      default: defaultValue,
      stored_as,
      options,
      min,
      max,
      step,
    } = fieldConfig;

    // Determine localStorage key
    const storageKey = stored_as || `${moduleId}_${fieldName}`;

    // Create label
    const labelElement = document.createElement("label");
    labelElement.textContent = label || this._formatFieldName(fieldName);

    // Create input based on type
    let input;

    switch (type) {
      case "checkbox":
        input = document.createElement("input");
        input.type = "checkbox";
        input.setAttribute("stored_as", storageKey);
        input.checked =
          this._getStoredValue(storageKey, defaultValue) === "true";
        input.addEventListener("change", () => {
          localStorage.setItem(storageKey, input.checked.toString());
        });
        labelElement.appendChild(input);
        container.appendChild(labelElement);
        break;

      case "select":
        input = document.createElement("select");
        input.setAttribute("stored_as", storageKey);
        const storedValue = this._getStoredValue(storageKey, defaultValue);

        // Add options
        if (options && Array.isArray(options)) {
          options.forEach((opt) => {
            const option = document.createElement("option");
            option.value = opt;
            option.textContent = opt;
            if (opt === storedValue) option.selected = true;
            input.appendChild(option);
          });
        }

        input.addEventListener("change", () => {
          localStorage.setItem(storageKey, input.value);
        });

        container.appendChild(labelElement);
        container.appendChild(input);
        break;

      case "range":
        input = document.createElement("input");
        input.type = "range";
        input.setAttribute("stored_as", storageKey);
        input.min = min || 0;
        input.max = max || 100;
        input.step = step || 1;
        input.value = this._getStoredValue(storageKey, defaultValue);

        // Create value display
        const valueDisplay = document.createElement("span");
        valueDisplay.className = "range-value";
        valueDisplay.textContent = input.value;

        input.addEventListener("input", () => {
          valueDisplay.textContent = input.value;
          localStorage.setItem(storageKey, input.value);
        });

        labelElement.appendChild(valueDisplay);
        container.appendChild(labelElement);
        container.appendChild(input);
        break;

      case "textarea":
        input = document.createElement("textarea");
        input.setAttribute("stored_as", storageKey);
        input.value = this._getStoredValue(storageKey, defaultValue);
        input.rows = 4;

        input.addEventListener("change", () => {
          localStorage.setItem(storageKey, input.value);
        });

        container.appendChild(labelElement);
        container.appendChild(input);
        break;

      case "number":
        input = document.createElement("input");
        input.type = "number";
        input.setAttribute("stored_as", storageKey);
        input.value = this._getStoredValue(storageKey, defaultValue);
        if (min !== undefined) input.min = min;
        if (max !== undefined) input.max = max;
        if (step !== undefined) input.step = step;

        input.addEventListener("change", () => {
          localStorage.setItem(storageKey, input.value);
        });

        container.appendChild(labelElement);
        container.appendChild(input);
        break;

      case "text":
      default:
        input = document.createElement("input");
        input.type = "text";
        input.setAttribute("stored_as", storageKey);
        input.value = this._getStoredValue(storageKey, defaultValue);

        input.addEventListener("change", () => {
          localStorage.setItem(storageKey, input.value);
        });

        container.appendChild(labelElement);
        container.appendChild(input);
        break;
    }

    return container;
  }

  /**
   * Get stored value from localStorage with fallback
   * @private
   */
  _getStoredValue(key, defaultValue) {
    const stored = localStorage.getItem(key);
    return stored !== null ? stored : defaultValue || "";
  }

  /**
   * Format section name (snake_case -> Title Case)
   * @private
   */
  _formatSectionName(name) {
    return name
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  /**
   * Format field name (snake_case -> Title Case)
   * @private
   */
  _formatFieldName(name) {
    return name
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }
}
