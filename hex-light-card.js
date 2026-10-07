/*
 * hex-light-card
 * A Home Assistant Lovelace custom card for setting a light (or light group)
 * color by hex value — either by typing it or using a visual picker.
 *
 * Usage (standalone card):
 *   type: custom:hex-light-card
 *   entity: light.my_light
 *
 * Usage (as a Tile card feature):
 *   type: tile
 *   entity: light.my_light
 *   features:
 *     - type: custom:hex-light-card-feature
 *
 * Options:
 *   entity             (required) a light entity or a light group
 *   title              (optional) card title (defaults to the light's name)
 *   show_title         (optional, default true) render the title + state row
 *                      (auto-off for the tile feature)
 *   show_current       (optional, default true) show the current color swatch
 *   brightness         (optional, default true) show the brightness slider
 *   initial_brightness (optional) initial slider value if the light has none
 */

const CARD_VERSION = "1.1.1";

const HEX_FULL = /^#?([0-9a-fA-F]{6})$/;
const HEX_SHORT = /^#?([0-9a-fA-F]{3})$/;

/**
 * Parse and normalize a user-supplied hex value.
 * Accepts "#RGB", "RGB", "#RRGGBB", "RRGGBB".
 * Returns "#RRGGBB" (lowercase) on success, or null if invalid.
 */
function normalizeHex(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  let m = v.match(HEX_FULL);
  if (m) return `#${m[1].toLowerCase()}`;
  m = v.match(HEX_SHORT);
  if (m) {
    const [r, g, b] = m[1];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return null;
}

function hexToRgbArray(hex) {
  const m = hex.match(/^#([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Read the current color of a light from its state object.
 * Returns { rgb: [r,g,b] | null, hex: string | null, supportsRgb: bool }.
 */
function readLightColor(state) {
  const a = state.attributes || {};
  const supportedFeatures = a.supported_features || 0;
  // Legacy bit: FEATURE_SUPPORTS_RGB_COLOR = 2**2 = 4. Often unset on
  // modern color-mode lights and light groups.
  const legacyRgb = (supportedFeatures & 4) !== 0;
  // Modern capability advertising: supported_color_modes.
  const modes = a.supported_color_modes;
  const colorModeRgb = Array.isArray(modes) &&
    modes.some((m) => m === "hs" || m === "rgb" || m === "rgbw" || m === "rgbww" || m === "xy");
  const supportsRgb = legacyRgb || colorModeRgb;

  let rgb = null;
  if (state.state === "on") {
    if (Array.isArray(a.rgb_color) && a.rgb_color.length === 3) {
      rgb = a.rgb_color;
    } else if (Array.isArray(a.hs_color) && a.hs_color.length === 2) {
      // Fall back to hs conversion if rgb_color isn't exposed.
      rgb = hsvToRgb(a.hs_color[0] / 360, a.hs_color[1] / 100, 1);
    }
  }
  return { rgb, hex: rgb ? rgbArrayToHex(rgb) : null, supportsRgb };
}

function rgbArrayToHex(rgb) {
  return (
    "#" +
    rgb.map((c) => c.toString(16).padStart(2, "0")).join("")
  );
}

/** Standard HSV -> RGB, each channel 0..1, returns [0..255 x3]. */
function hsvToRgb(h, s, v) {
  let r, g, b;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

class HexLightCardElement extends HTMLElement {
  setConfig(config) {
    if (!config) throw new Error("You did not specify an entity");
    // As a standalone card `type` is "custom:hex-light-card"; as a tile
    // The standalone card arrives as "custom:hex-light-card"; a tile feature
    // arrives as "hex-light-card-feature" (the feature renderer strips the
    // custom: prefix). Accept either form.
    if (config.type && !/custom:hex-light-card(-feature)?|hex-light-card-feature/.test(config.type)) {
      throw new Error("Unknown card type: " + config.type);
    }
    // Standalone cards must name a light. A tile feature may omit `entity` —
    // it inherits the parent tile's light (resolved at render time).
    if (config.entity) {
      const entities = config.entity.split(",").map((s) => s.trim());
      if (!entities.every((e) => e.startsWith("light."))) {
        throw new Error(
          "hex-light-card: entity must be a light (or comma-separated list of lights)"
        );
      }
    } else if (!/feature$/.test(config.type || "")) {
      throw new Error("You did not specify an entity");
    }
    this._config = {
      ...config,
      show_title: config.show_title !== false,
      show_current: config.show_current !== false,
      brightness: config.brightness !== false,
    };
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() {
    // One row each: title, current-color, the no-RGB warning (when it will
    // show), the set-color row, and the brightness slider.
    const cfg = this._config || {};
    let rows = 2; // set-color row + status
    if (cfg.show_title !== false) rows += 1;
    if (cfg.show_current !== false) rows += 1;
    if (cfg.brightness !== false) rows += 1;
    return rows;
  }

  static getStubConfig() {
    return { entity: "light.example" };
  }

  static getConfigElement() {
    return document.createElement("hui-error-card");
  }

  _resolveEntityId() {
    if (this._config.entity) {
      return this._config.entity.split(",")[0].trim();
    }
    // Tile feature: inherit the parent tile's light entity.
    let el = this;
    while (el) {
      const attrs = el.getAttribute ? el.getAttribute("entity") : null;
      if (attrs && attrs.startsWith("light.")) return attrs.trim();
      el = el.parentElement;
    }
    return null;
  }

  /** Current color of the bound light as "#rrggbb", or null. */
  _currentHex() {
    const id = this._resolveEntityId();
    const light = id && this._hass ? this._hass.states[id] : undefined;
    if (!light) return null;
    const info = readLightColor(light);
    return info.hex || null;
  }

  _applyColor(hexInput, setStatus, cfg, hass) {
    const normalized = normalizeHex(hexInput.value);
    if (!normalized) {
      setStatus("Invalid hex \u2014 use #RRGGBB or #RGB (e.g. #00ff88)");
      return;
    }
    // Enter + the blur `change` it triggers would otherwise double-fire the
    // same value; collapse that into one service call.
    const now = Date.now();
    if (normalized === this._lastApplied && now - this._lastAppliedAt < 250) {
      setStatus("Applied " + normalized, true);
      return;
    }
    this._lastApplied = normalized;
    this._lastAppliedAt = now;
    const rgb = hexToRgbArray(normalized);
    const data = { rgb_color: rgb };
    const primaryId = this._resolveEntityId();
    const light = primaryId && this._hass ? this._hass.states[primaryId] : undefined;
    // Only send brightness while the light is ON. For an off light HA keeps
    // its remembered brightness and restores it on next turn_on — sending an
    // explicit value (a clamped 0 would land as 1) forces the light on dim.
    const brightness = this._brightness;
    if (light && light.state === "on" && brightness != null) {
      data.brightness = brightness;
    }
    const ids = cfg.entity ? cfg.entity.split(",").map((s) => s.trim()) : [primaryId];
    if (!ids[0]) {
      setStatus("No light entity to target");
      return;
    }
    data.entity_id = ids.length > 1 ? ids : ids[0];
    hass.callService("light", "turn_on", data).then(
      () => {
        // The value was just sent — the slider is no longer "local-only".
        this._brightnessDirty = false;
        setStatus("Applied " + normalized, true);
      },
      (err) => setStatus("Error: " + (err && err.message ? err.message : err))
    );
  }

  _render() {
    const hass = this._hass;
    const cfg = this._config;
    if (!hass || !cfg) return;

    // Primary entity: explicit config, or the parent tile's light (feature).
    const primaryId = this._resolveEntityId();
    const light = primaryId ? hass.states[primaryId] : undefined;
    const isOn = !!(light && light.state === "on");

    if (this._lightId && primaryId !== this._lightId) {
      this.innerHTML = "";
      this._built = false;
    }

    if (this._built) {
      if (!light) {
        if (this._lightId === primaryId) {
          // Same (still-missing) entity as the last render — the error row
          // is already accurate; skip the rebuild churn on every push.
          return;
        }
        // Entity disappeared — fall through to a full rebuild (error row).
        this.innerHTML = "";
        this._built = false;
      } else if (this._errorShown) {
        // Entity (re)appeared — the error row must give way to a full build;
        // _updateFromLight has no DOM to update on an error card.
        this.innerHTML = "";
        this._built = false;
      } else {
        this._updateFromLight(light, isOn);
        return;
      }
    }

    this.innerHTML = "";
    const root = document.createElement("div");
    root.style.padding = "12px";
    root.style.fontFamily = "var(--primary-font-family, system-ui, sans-serif)";
    root.style.display = "flex";
    root.style.flexDirection = "column";
    root.style.gap = "10px";

    // Title row: title + state pill
    if (cfg.show_title) {
      const titleRow = document.createElement("div");
      titleRow.style.display = "flex";
      titleRow.style.justifyContent = "space-between";
      titleRow.style.alignItems = "center";
      const title = document.createElement("div");
      title.style.fontWeight = "600";
      title.style.fontSize = "15px";
      title.textContent =
        cfg.title ||
        (light && light.attributes.friendly_name) ||
        primaryId;
      const pill = document.createElement("span");
      pill.textContent = light ? light.state.toUpperCase() : "?";
      pill.style.fontSize = "11px";
      pill.style.padding = "2px 8px";
      pill.style.borderRadius = "10px";
      pill.style.background = isOn ? "#3cb44b" : "#888";
      pill.style.color = "#fff";
      this._pill = pill;
      titleRow.appendChild(title);
      titleRow.appendChild(pill);
      root.appendChild(titleRow);
    }

    if (!light) {
      const msg = document.createElement("div");
      msg.style.color = "#c33";
      msg.textContent = primaryId
        ? "Entity not found: " + primaryId
        : "No light entity found \u2014 add an entity or place this feature on a light tile.";
      root.appendChild(msg);
      this.appendChild(root);
      this._lightId = primaryId;
      this._built = true;
      this._errorShown = true;
      return;
    }

    const info = readLightColor(light);

    // Current-color row (swatch + current hex)
    if (cfg.show_current) {
      const curRow = document.createElement("div");
      curRow.style.display = "flex";
      curRow.style.alignItems = "center";
      curRow.style.gap = "8px";
      const label = document.createElement("span");
      label.style.fontSize = "13px";
      label.textContent = "Current:";
      const swatch = document.createElement("span");
      swatch.style.width = "24px";
      swatch.style.height = "24px";
      swatch.style.borderRadius = "4px";
      swatch.style.border = "1px solid rgba(128,128,128,0.4)";
      swatch.style.background = info.hex || "transparent";
      this._swatch = swatch;
      const curHex = document.createElement("span");
      curHex.style.fontSize = "13px";
      curHex.style.fontFamily = "monospace";
      curHex.textContent = info.hex || (isOn ? "n/a" : "off");
      this._curHex = curHex;
      curRow.appendChild(label);
      curRow.appendChild(swatch);
      curRow.appendChild(curHex);
      root.appendChild(curRow);
    }

    if (!info.supportsRgb) {
      const warn = document.createElement("div");
      warn.style.color = "#b7791f";
      warn.style.fontSize = "13px";
      warn.textContent =
        "This light does not report RGB support. Setting a color may be rejected.";
      root.appendChild(warn);
    }

    // New-color row: native color input + hex text input
    const newRow = document.createElement("div");
    newRow.style.display = "flex";
    newRow.style.alignItems = "center";
    newRow.style.gap = "8px";
    const newLabel = document.createElement("span");
    newLabel.style.fontSize = "13px";
    newLabel.textContent = "Set:";

    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = info.hex || "#ffffff";
    this._colorInput = colorInput;
    colorInput.style.width = "44px";
    colorInput.style.height = "34px";
    colorInput.style.padding = "0";
    colorInput.style.border = "1px solid rgba(128,128,128,0.5)";
    colorInput.style.borderRadius = "4px";
    colorInput.style.background = "transparent";

    const hexInput = document.createElement("input");
    hexInput.type = "text";
    hexInput.value = info.hex || "#ffffff";
    this._hexInput = hexInput;
    hexInput.placeholder = "#rrggbb";
    // No maxLength: 6-char hex has no "#" at all (the regex allows it).
    hexInput.style.flex = "1";
    hexInput.style.minWidth = "90px";
    hexInput.style.fontSize = "15px";
    hexInput.style.fontFamily = "monospace";
    hexInput.style.padding = "6px 8px";
    hexInput.style.border = "1px solid rgba(128,128,128,0.5)";
    hexInput.style.borderRadius = "4px";

    const status = document.createElement("div");
    status.style.fontSize = "12px";
    status.style.minHeight = "14px";

    const setStatus = (msg, ok = false) => {
      status.textContent = msg;
      status.style.color = msg ? (ok ? "#3cb44b" : "#c33") : "";
    };
    this._setStatus = setStatus;

    // Always read the current hass reference — never the first render's.
    const doApply = () => this._applyColor(hexInput, setStatus, cfg, this._hass);

    colorInput.addEventListener("click", () => {
      this._picking = true;
      // Start a pick session; only a `change` (committed pick) confirms it.
      this._pick = { confirmed: false };
    });
    colorInput.addEventListener("input", () => {
      this._picking = true;
      hexInput.value = colorInput.value;
      // This value was written BY the picker — the cancel-rollback may
      // legitimately undo it (a typed value may not).
      this._hexLastWrite = "picker";
      setStatus("");
    });
    colorInput.addEventListener("blur", () => {
      this._picking = false;
      const pick = this._pick;
      this._pick = null;
      // Focus left the picker without a committed pick: roll the hex field
      // back to the light's actual color — but only when the field currently
      // holds a PICKER-written value, never a value the user typed.
      if (pick && !pick.confirmed && this._hexLastWrite === "picker") {
        const cur = this._currentHex();
        if (cur) {
          hexInput.value = cur;
          colorInput.value = cur;
        }
        this._hexLastWrite = "light";
      }
    });
    colorInput.addEventListener("change", () => {
      this._picking = false;
      if (this._pick) this._pick.confirmed = true;
      // Sync the text field BEFORE applying — never rely on a prior
      // `input` event having fired (fixes stale-hex applies).
      hexInput.value = colorInput.value;
      doApply();
    });
    hexInput.addEventListener("input", () => {
      // A keystroke: the field now holds a user-typed value.
      this._hexLastWrite = "typed";
      const n = normalizeHex(hexInput.value);
      if (n) {
        colorInput.value = n;
        setStatus("");
      } else if (hexInput.value.trim() !== "") {
        setStatus("Invalid hex \u2014 use #RRGGBB or #RGB (e.g. #00ff88)");
      } else {
        // Cleared the field: reflect that in the picker, clear the error.
        colorInput.value = "#ffffff";
        this._hexLastWrite = "light";
        setStatus("");
      }
    });
    hexInput.addEventListener("change", doApply);
    hexInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doApply();
    });

    newRow.appendChild(newLabel);
    newRow.appendChild(colorInput);
    newRow.appendChild(hexInput);
    root.appendChild(newRow);
    root.appendChild(status);

    // Optional brightness slider
    if (cfg.brightness) {
      const bRow = document.createElement("div");
      bRow.style.display = "flex";
      bRow.style.alignItems = "center";
      bRow.style.gap = "8px";
      const bLabel = document.createElement("span");
      bLabel.style.fontSize = "13px";
      bLabel.textContent = "Brightness:";
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "1";
      slider.max = "255";
      const curBright = light.attributes.brightness;
      const rawInit =
        typeof curBright === "number"
          ? curBright
          : cfg.initial_brightness || 255;
      // Clamp to HA's valid range (1-255) — an off light may report 0,
      // which would otherwise be sent verbatim in the next apply.
      const init = Math.min(255, Math.max(1, rawInit));
      slider.value = init;
      this._brightness = init;
      this._brightnessSlider = slider;
      slider.style.flex = "1";
      const bVal = document.createElement("span");
      bVal.style.fontSize = "12px";
      bVal.style.fontFamily = "monospace";
      bVal.textContent = String(init);
      this._brightnessVal = bVal;
      slider.addEventListener("input", () => {
        bVal.textContent = slider.value;
        this._brightness = parseInt(slider.value, 10);
        // Local, not-yet-applied change: don't let state pushes clobber it.
        this._brightnessDirty = true;
      });
      bRow.appendChild(bLabel);
      bRow.appendChild(slider);
      bRow.appendChild(bVal);
      root.appendChild(bRow);
    }

    this.appendChild(root);
    this._lightId = primaryId;
    this._built = true;
    this._errorShown = false;
    // A rebuild created fresh input nodes — any local unsynced flag is stale.
    this._brightnessDirty = false;
  }

  /**
   * Incremental update after the DOM has been built once. Only display values
   * change (state pill, current swatch/hex, picker swatch) — the input nodes
   * themselves are never replaced, so an open native color picker or active
   * text input survives live hass state updates.
   */
  _updateFromLight(light, isOn) {
    if (this._pill) {
      this._pill.textContent = light ? light.state.toUpperCase() : "?";
      this._pill.style.background = isOn ? "#3cb44b" : "#888";
    }
    if (light) {
      const info = readLightColor(light);
      if (this._swatch) {
        this._swatch.style.background = info.hex || "transparent";
      }
      if (this._curHex) {
        this._curHex.textContent = info.hex || (isOn ? "n/a" : "off");
      }
      if (this._colorInput && this._hexInput && !this._picking) {
        // The picker swatch mirrors the current color, but never clobbers a
        // hex value the user is actively typing.
        if (document.activeElement !== this._hexInput) {
          const valid = normalizeHex(this._hexInput.value);
          if (!valid) this._hexInput.value = info.hex || "#ffffff";
          this._colorInput.value = normalizeHex(this._hexInput.value) || "#ffffff";
        }
      }
      if (this._brightness == null && light.attributes.brightness != null) {
        this._brightness = light.attributes.brightness;
      }
      if (this._brightnessSlider) {
        const b = light.attributes.brightness;
        if (typeof b === "number") {
          const clamped = Math.min(255, Math.max(1, b));
          // Skip only when the user has a local, unapplied slider change —
          // an external brightness change always wins otherwise (fixes
          // the desync where the next apply reverted it).
          const sliderVal = parseInt(this._brightnessSlider.value, 10);
          if (!(this._brightnessDirty && sliderVal !== clamped)) {
            this._brightnessSlider.value = clamped;
            if (this._brightnessVal) this._brightnessVal.textContent = String(clamped);
            this._brightness = clamped;
            if (sliderVal === clamped) this._brightnessDirty = false;
          }
        }
      }
    }
  }
}

/**
 * Compact variant registered for use as a Tile card feature:
 *   type: custom:hex-light-card-feature
 * Skips the title/state row (the tile already shows the light name) and
 * renders the swatch + hex controls compactly inside the tile.
 */
class HexLightCardFeatureElement extends HexLightCardElement {
  setConfig(config) {
    super.setConfig(config);
    this._config.show_title = false;
    // Compact variant: the tile already shows name/state/current swatch,
    // so the current-color row is redundant by default. Opt back in with
    // `show_current: true` (note: inverted from the standalone card, where
    // the default is true and you'd set `show_current: false`).
    this._config.show_current = config.show_current === true;
  }

  getCardSize() {
    const cfg = this._config || {};
    let rows = 2; // set-color row + status
    if (cfg.show_current) rows += 1;
    if (cfg.brightness !== false) rows += 1;
    return rows;
  }

  static getStubConfig(ha, stateObj) {
    // Tile feature stub: use the tile's own light when available.
    const entity =
      stateObj && stateObj.entity_id && stateObj.entity_id.startsWith("light.")
        ? stateObj.entity_id
        : "light.example";
    return { entity };
  }
}

customElements.define("hex-light-card", HexLightCardElement);
customElements.define("hex-light-card-feature", HexLightCardFeatureElement);

// Standalone card registration (also usable inside entities cards).
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "hex-light-card")) {
  window.customCards.push({
    type: "hex-light-card",
    name: "Hex Light Card",
    description:
      "Set a light (or light group) color by hex \u2014 type a value or use the picker.",
    preview: true,
  });
}

// Tile-feature registration. Required for use as a tile `features:` entry —
// customCards alone is not enough for features.
window.customCardFeatures = window.customCardFeatures || [];
if (!window.customCardFeatures.some((c) => c.type === "hex-light-card-feature")) {
  window.customCardFeatures.push({
    type: "hex-light-card-feature",
    name: "Hex Light Card (Tile feature)",
    configurable: true,
  });
}

console.info(
  "\n %c hex-light-card %c v" + CARD_VERSION + " \n",
  "background-color: #555;color: #fff;padding: 3px 2px 3px 3px;border-radius: 3px 0 0 3px",
  "background-color: #bc81e0;color: #fff;padding: 3px 2px 3px 2px;border-radius: 0 3px 3px 0"
);

export default HexLightCardElement;
