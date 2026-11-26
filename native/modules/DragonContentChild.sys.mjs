/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const COSMETIC_STYLE_ID = "dragon-cosmetic-style";
const COSMETIC_CHUNK_SIZE = 12;

const FORCE_DARK_STYLE_ID = "dragon-force-dark-style";
const FORCE_DARK_ATTR = "data-dragon-force-dark";
const FORCE_DARK_MARK_ATTR = "data-dragon-fd";
const FORCE_DARK_CACHE_KEY = "__dragonForceDarkMode";
const BATCH_LIMIT = 350;

const GEMINI_HASH_KEY = "dragon_q=";
const GEMINI_WAIT_TIMEOUT_MS = 10000;
const GEMINI_SEND_RETRY_MS = 120;
const GEMINI_SEND_MAX_ATTEMPTS = 25;

const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "META",
  "LINK",
  "NOSCRIPT",
  "HEAD",
  "TITLE",
  "BR",
  "WBR",
  "IMG",
  "VIDEO",
  "AUDIO",
  "CANVAS",
  "PICTURE",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "SOURCE",
  "TRACK",
]);

const SVG_TAGS = new Set([
  "svg",
  "path",
  "circle",
  "rect",
  "polygon",
  "polyline",
  "line",
  "ellipse",
]);

const BORDER_PROPS = [
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
];

const BORDER_STYLE_PROPS = [
  "borderTopStyle",
  "borderRightStyle",
  "borderBottomStyle",
  "borderLeftStyle",
];

const BORDER_WIDTH_PROPS = [
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
];

const BORDER_COLOR_COMPUTED = [
  "borderTopColor",
  "borderRightColor",
  "borderBottomColor",
  "borderLeftColor",
];

const OBSIDIAN_RAMP = [
  [0.0, 9, 9, 13], // #09090d
  [0.04, 17, 18, 26], // #11121a
  [0.09, 25, 27, 38], // #191b26
  [0.2, 35, 38, 52], // #232634
  [0.55, 46, 50, 66], // #2e3242
];

const GEMINI_EDITOR_SELECTORS = [
  '.ql-editor[contenteditable="true"]',
  'rich-textarea [contenteditable="true"]',
  '[role="textbox"][contenteditable="true"]',
];

const GEMINI_SEND_SELECTORS = [
  "button.send-button",
  'button[aria-label*="Send"]',
  'button[data-mat-icon-name="send"]',
  'button:has([data-mat-icon-name="send"])',
  'button[aria-label*="send" i]',
];

const BASE_DARK_CSS = `
:root[${FORCE_DARK_ATTR}="true"] {
  color-scheme: dark !important;
  min-height: 100vh;
  background-color: #09090d !important;
  color: #e8eaf2 !important;
  scrollbar-color: rgba(255, 255, 255, 0.18) #09090d !important;
  scrollbar-width: thin !important;
}
html[${FORCE_DARK_ATTR}="true"] body {
  background-color: #09090d;
  color: #e8eaf2;
}
html[${FORCE_DARK_ATTR}="true"] input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]):not([type="hidden"]),
html[${FORCE_DARK_ATTR}="true"] textarea,
html[${FORCE_DARK_ATTR}="true"] select {
  background-color: #13141c !important;
  color: #eef0f6 !important;
  border-color: rgba(255, 255, 255, 0.16) !important;
  caret-color: #f4f4f8 !important;
}
html[${FORCE_DARK_ATTR}="true"] input::placeholder,
html[${FORCE_DARK_ATTR}="true"] textarea::placeholder {
  color: #7c8096 !important;
  opacity: 1 !important;
}
html[${FORCE_DARK_ATTR}="true"] hr {
  border-color: rgba(255, 255, 255, 0.1) !important;
}
html[${FORCE_DARK_ATTR}="true"] ::selection {
  background-color: rgba(232, 72, 85, 0.34) !important;
  color: #ffffff !important;
}
`.trim();

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function parseRgba(colorStr) {
  if (!colorStr || typeof colorStr !== "string") {
    return null;
  }
  const trimmed = colorStr.trim();
  if (!trimmed || trimmed === "transparent" || trimmed === "none") {
    return null;
  }
  const commaMatch = trimmed.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+%?))?\s*\)$/i
  );
  const spaceMatch =
    !commaMatch &&
    trimmed.match(
      /^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/i
    );
  const match = commaMatch || spaceMatch;
  if (!match) {
    return null;
  }

  const r = Number(match[1]);
  const g = Number(match[2]);
  const b = Number(match[3]);
  let a = 1;
  if (match[4] !== undefined) {
    a = match[4].endsWith("%") ? Number(match[4].slice(0, -1)) / 100 : Number(match[4]);
  }
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || !Number.isFinite(a) || a <= 0.04) {
    return null;
  }
  return { r, g, b, a };
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const delta = max - min;

  if (delta === 0) {
    return { h: 0, s: 0, l };
  }

  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h = 0;
  if (max === rn) {
    h = (gn - bn) / delta + (gn < bn ? 6 : 0);
  } else if (max === gn) {
    h = (bn - rn) / delta + 2;
  } else {
    h = (rn - gn) / delta + 4;
  }
  return { h: h * 60, s, l };
}

function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  if (s <= 0) {
    const gray = Math.round(clamp(l, 0, 1) * 255);
    return { r: gray, g: gray, b: gray };
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = hue / 360;

  function hue2rgb(t) {
    let tn = t;
    if (tn < 0) tn += 1;
    if (tn > 1) tn -= 1;
    if (tn < 1 / 6) return p + (q - p) * 6 * tn;
    if (tn < 1 / 2) return q;
    if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6;
    return p;
  }

  return {
    r: Math.round(hue2rgb(hk + 1 / 3) * 255),
    g: Math.round(hue2rgb(hk) * 255),
    b: Math.round(hue2rgb(hk - 1 / 3) * 255),
  };
}

function formatRgba(rgb, alpha) {
  const a = alpha === undefined ? 1 : alpha;
  if (a >= 0.995) {
    return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
  }
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Number(a.toFixed(3))})`;
}

function interpolateObsidian(lightness) {
  const d = clamp(1 - lightness, 0, 0.55);
  for (let i = 0; i < OBSIDIAN_RAMP.length - 1; i++) {
    const [d0, r0, g0, b0] = OBSIDIAN_RAMP[i];
    const [d1, r1, g1, b1] = OBSIDIAN_RAMP[i + 1];
    if (d <= d1) {
      const t = (d - d0) / (d1 - d0 || 1);
      return {
        r: Math.round(r0 + (r1 - r0) * t),
        g: Math.round(g0 + (g1 - g0) * t),
        b: Math.round(b0 + (b1 - b0) * t),
      };
    }
  }
  return { r: 46, g: 50, b: 66 };
}

function transformBackground(rgba) {
  if (!rgba) {
    return null;
  }
  const { h, s, l } = rgbToHsl(rgba.r, rgba.g, rgba.b);
  if (l <= 0.45) {
    return null;
  }
  if (s <= 0.14) {
    return formatRgba(interpolateObsidian(l), rgba.a);
  }
  if (l <= 0.48) {
    return null;
  }
  const newS = Math.min(s * 0.78, 0.58);
  const newL = clamp(0.12 + (1 - l) * 0.24, 0.11, 0.28);
  return formatRgba(hslToRgb(h, newS, newL), rgba.a);
}

function transformText(rgba) {
  if (!rgba) {
    return null;
  }
  const { h, s, l } = rgbToHsl(rgba.r, rgba.g, rgba.b);
  if (l >= 0.58) {
    return null;
  }
  if (s <= 0.18) {
    const t = clamp(l / 0.58, 0, 1);
    const rgb = {
      r: Math.round(240 + (138 - 240) * t),
      g: Math.round(241 + (142 - 241) * t),
      b: Math.round(246 + (162 - 246) * t),
    };
    return formatRgba(rgb, rgba.a);
  }
  const minL = h >= 200 && h <= 265 ? 0.68 : 0.62;
  const newS = clamp(s * 0.92, 0.35, 0.88);
  const newL = clamp(Math.max(minL, 0.92 - l * 0.5), minL, 0.84);
  return formatRgba(hslToRgb(h, newS, newL), rgba.a);
}

function transformBorder(rgba) {
  if (!rgba) {
    return null;
  }
  const { h, s, l } = rgbToHsl(rgba.r, rgba.g, rgba.b);
  if (l <= 0.35) {
    return null;
  }
  if (s <= 0.18) {
    const t = clamp((l - 0.35) / 0.65, 0, 1);
    const alpha = rgba.a * (0.1 + (1 - t) * 0.06);
    return formatRgba({ r: 255, g: 255, b: 255 }, alpha);
  }
  if (l <= 0.55) {
    return null;
  }
  const newS = Math.min(s * 0.8, 0.55);
  const newL = clamp(0.26 + (1 - l) * 0.22, 0.26, 0.36);
  return formatRgba(hslToRgb(h, newS, newL), rgba.a);
}

function transformGradient(bgImage) {
  if (!bgImage || !bgImage.includes("gradient(") || bgImage.includes("url(")) {
    return null;
  }
  let changed = false;
  const replaced = bgImage.replace(/rgba?\([^)]+\)/gi, (stop) => {
    const parsed = parseRgba(stop);
    const remapped = transformBackground(parsed);
    if (remapped) {
      changed = true;
      return remapped;
    }
    return stop;
  });
  return changed ? replaced : null;
}

function relativeLuminance(rgb) {
  if (!rgb) {
    return null;
  }
  return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
}

function hasDarkThemeMarker(el) {
  if (!el) {
    return false;
  }
  if (el.hasAttribute("dark")) {
    return true;
  }
  const attrs = ["data-theme", "data-color-mode", "data-bs-theme", "data-mode", "theme"];
  for (const attr of attrs) {
    const val = (el.getAttribute(attr) || "").toLowerCase();
    if (val && (val === "dark" || val.includes("night") || val.includes("obsidian"))) {
      return true;
    }
  }
  const cls = (typeof el.className === "string" ? el.className : "").toLowerCase();
  return /\b(dark|dark-mode|theme-dark|night-mode)\b/.test(cls);
}

function buildCosmeticCss(selectors) {
  const clean = [];
  for (let i = 0; i < selectors.length; i += 1) {
    const sel = typeof selectors[i] === "string" ? selectors[i].trim() : "";
    if (sel && !sel.includes("{") && !sel.includes("}")) {
      clean.push(sel);
    }
  }
  if (clean.length === 0) {
    return "";
  }
  const blocks = [];
  for (let i = 0; i < clean.length; i += COSMETIC_CHUNK_SIZE) {
    const chunk = clean.slice(i, i + COSMETIC_CHUNK_SIZE);
    blocks.push(
      chunk.join(",\n") + " {\n  display: none !important;\n  visibility: hidden !important;\n}"
    );
  }
  return blocks.join("\n");
}

export class DragonContentChild extends JSWindowActorChild {
  constructor() {
    super();
    this._destroyed = false;
    this._policy = null;
    this._policyPromise = null;

    this._activeDarkMode = false;
    this._styleEl = null;
    this._domObserver = null;
    this._attrObserver = null;
    this._rafId = null;
    this._attrTimerId = null;
    this._attrStopTimerId = null;
    this._processedElements = new WeakSet();
    this._savedInlineStyles = new WeakMap();
    this._queuedSet = new Set();
    this._pendingQueue = [];
    this._queueHead = 0;
    this._visibilityListener = null;

    this._geminiObserver = null;
    this._geminiTimeoutId = null;
    this._geminiRetryTimerId = null;
  }

  _isDomainInList(hostname, list) {
    if (!hostname || !Array.isArray(list) || list.length === 0) {
      return false;
    }
    for (let i = 0; i < list.length; i += 1) {
      const entry = typeof list[i] === "string" ? list[i].trim().toLowerCase() : "";
      if (entry && (hostname === entry || hostname.endsWith("." + entry))) {
        return true;
      }
    }
    return false;
  }

  _readSharedPolicy(hostname) {
    try {
      const shared = Services?.cpmm?.sharedData?.get("dragon:pagePolicy");
      if (!shared || typeof shared !== "object") {
        return null;
      }
      const allowlisted = this._isDomainInList(hostname, shared.allowlist);
      const cosmeticActive = Boolean(shared.cosmeticEnabled && !allowlisted);
      return {
        cosmeticEnabled: cosmeticActive,
        cosmeticCss: cosmeticActive ? shared.cosmeticCss || "" : "",
        forceDarkEnabled: shared.forceDarkEnabled !== false,
        forceDarkExcluded: this._isDomainInList(hostname, shared.forceDarkExcludedDomains),
      };
    } catch {
      return null;
    }
  }

  get _isTopFrame() {
    try {
      return Boolean(this.browsingContext && this.browsingContext === this.browsingContext.top);
    } catch {
      return false;
    }
  }

  _getHostname() {
    try {
      const win = this.contentWindow;
      const protocol = win?.location?.protocol || "";
      if (protocol !== "http:" && protocol !== "https:") {
        return "";
      }
      return (win?.location?.hostname || "").toLowerCase();
    } catch {
      return "";
    }
  }

  _ensurePolicyLoaded() {
    if (this._policyPromise) {
      return this._policyPromise;
    }
    const hostname = this._getHostname();
    if (!hostname) {
      return Promise.resolve(null);
    }
    const sharedPolicy = this._readSharedPolicy(hostname);
    if (sharedPolicy) {
      this._policy = sharedPolicy;
      this._policyPromise = Promise.resolve(sharedPolicy);
      return this._policyPromise;
    }
    this._policyPromise = this.sendQuery("Dragon:GetPagePolicy", { hostname })
      .then((res) => {
        if (this._destroyed || !res) {
          return null;
        }
        this._policy = res;
        return res;
      })
      .catch(() => null);
    return this._policyPromise;
  }

  _applyCosmeticPolicy(policy) {
    if (this._destroyed) {
      return;
    }
    const doc = this.document;
    if (!doc) {
      return;
    }

    const existing = doc.getElementById(COSMETIC_STYLE_ID);
    if (!policy || !policy.cosmeticEnabled) {
      if (existing) {
        existing.remove();
      }
      return;
    }

    const cssText =
      typeof policy.cosmeticCss === "string" && policy.cosmeticCss
        ? policy.cosmeticCss
        : Array.isArray(policy.cosmeticSelectors)
          ? buildCosmeticCss(policy.cosmeticSelectors)
          : "";
    if (!cssText) {
      if (existing) {
        existing.remove();
      }
      return;
    }

    let styleEl = existing;
    if (!styleEl) {
      styleEl = doc.createElement("style");
      styleEl.id = COSMETIC_STYLE_ID;
      const target = doc.head || doc.documentElement;
      if (!target) {
        return;
      }
      target.appendChild(styleEl);
    }
    styleEl.textContent = cssText;
  }

  _ensureDarkStyle() {
    const doc = this.document;
    if (!doc) {
      return null;
    }
    if (!this._styleEl || !this._styleEl.isConnected) {
      this._styleEl = doc.getElementById(FORCE_DARK_STYLE_ID);
      if (!this._styleEl) {
        this._styleEl = doc.createElement("style");
        this._styleEl.id = FORCE_DARK_STYLE_ID;
        this._styleEl.textContent = BASE_DARK_CSS;
        const target = doc.head || doc.documentElement;
        if (target) {
          target.appendChild(this._styleEl);
        }
      }
    }
    return this._styleEl;
  }

  _setSavedStyle(el, prop, value) {
    let record = this._savedInlineStyles.get(el);
    if (!record) {
      record = Object.create(null);
      this._savedInlineStyles.set(el, record);
      if (el.getAttribute(FORCE_DARK_MARK_ATTR) !== "1") {
        el.setAttribute(FORCE_DARK_MARK_ATTR, "1");
      }
    }
    if (!(prop in record)) {
      record[prop] = [
        el.style.getPropertyValue(prop),
        el.style.getPropertyPriority(prop),
      ];
    }
    el.style.setProperty(prop, value, "important");
  }

  _findOpaqueContainerColors(root, body) {
    const win = this.contentWindow;
    const doc = this.document;
    if (!win || !doc) {
      return null;
    }

    const candidates = [];
    if (
      typeof doc.elementFromPoint === "function" &&
      win.innerWidth > 0 &&
      win.innerHeight > 0
    ) {
      const hit = doc.elementFromPoint(
        Math.floor(win.innerWidth / 2),
        Math.min(200, Math.floor(win.innerHeight / 2))
      );
      let cur = hit;
      while (cur && cur !== body && cur !== root) {
        candidates.push(cur);
        cur = cur.parentElement;
      }
    }

    const fallbackNodes = doc.querySelectorAll('main, #app, #root, #__next, [role="main"]');
    for (const node of fallbackNodes) {
      candidates.push(node);
    }

    const seen = new Set();
    for (const node of candidates) {
      if (!node || seen.has(node)) {
        continue;
      }
      seen.add(node);
      const style = win.getComputedStyle(node);
      const bg = parseRgba(style.backgroundColor);
      if (bg) {
        return { bg, color: parseRgba(style.color) };
      }
    }
    return null;
  }

  _isPageAlreadyDark() {
    const win = this.contentWindow;
    const doc = this.document;
    const root = doc?.documentElement;
    if (!win || !doc || !root) {
      return false;
    }
    const body = doc.body;

    const el = this._styleEl || doc.getElementById(FORCE_DARK_STYLE_ID);
    const prevDisabled = el ? el.disabled : false;
    if (el) {
      el.disabled = true;
    }

    let dark = false;
    try {
      const rootStyle = win.getComputedStyle(root);
      const bodyStyle = body ? win.getComputedStyle(body) : null;

      const bodyBg = bodyStyle ? parseRgba(bodyStyle.backgroundColor) : null;
      const rootBg = parseRgba(rootStyle.backgroundColor);
      let effectiveBg = bodyBg || rootBg;
      let textRgb = parseRgba((bodyStyle || rootStyle).color);

      if (!effectiveBg) {
        const container = this._findOpaqueContainerColors(root, body);
        if (container) {
          effectiveBg = container.bg;
          if (!textRgb || container.color) {
            textRgb = container.color || textRgb;
          }
        }
      }

      const bgLum = relativeLuminance(effectiveBg);
      const textLum = relativeLuminance(textRgb);

      if (bgLum !== null && bgLum < 92) {
        dark = true;
      } else if (
        (hasDarkThemeMarker(root) || hasDarkThemeMarker(body)) &&
        (bgLum === null || bgLum < 120)
      ) {
        dark = true;
      } else if (bgLum === null && textLum !== null && textLum > 140) {
        dark = true;
      } else {
        const metaScheme = doc.querySelector('meta[name="color-scheme"]');
        const metaContent = metaScheme
          ? (metaScheme.getAttribute("content") || "").toLowerCase()
          : "";
        if (metaContent.includes("dark") && (bgLum === null || bgLum < 120)) {
          dark = true;
        }
      }
    } catch {
      dark = false;
    } finally {
      if (el) {
        el.disabled = prevDisabled;
      }
    }

    return dark;
  }

  _processSmallSvgIcon(el, style) {
    const tag = (el.tagName || "").toLowerCase();
    if (!SVG_TAGS.has(tag)) {
      return;
    }
    const hostSvg = tag === "svg" ? el : el.ownerSVGElement;
    if (!hostSvg || typeof hostSvg.getBoundingClientRect !== "function") {
      return;
    }
    const rect = hostSvg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.width > 48 || rect.height > 48) {
      return;
    }

    const fill = parseRgba(style.fill);
    if (fill) {
      const hsl = rgbToHsl(fill.r, fill.g, fill.b);
      if (hsl.l < 0.35 && hsl.s < 0.15) {
        this._setSavedStyle(el, "fill", "#d8dce8");
      }
    }

    const stroke = parseRgba(style.stroke);
    if (stroke) {
      const hsl = rgbToHsl(stroke.r, stroke.g, stroke.b);
      if (hsl.l < 0.35 && hsl.s < 0.15) {
        this._setSavedStyle(el, "stroke", "#d8dce8");
      }
    }
  }

  _processElement(el) {
    const win = this.contentWindow;
    if (!win || !el || el.nodeType !== 1 || !el.isConnected || this._processedElements.has(el)) {
      return;
    }
    this._processedElements.add(el);

    const upperTag = (el.tagName || "").toUpperCase();
    if (SKIP_TAGS.has(upperTag) || !el.style) {
      return;
    }

    const style = win.getComputedStyle(el);
    if (!style) {
      return;
    }

    const bgImage = style.backgroundImage || "";
    if (bgImage.includes("url(")) {
      return;
    }

    if (upperTag !== "HTML") {
      const bgColor = parseRgba(style.backgroundColor);
      const nextBg = transformBackground(bgColor);
      if (nextBg) {
        this._setSavedStyle(el, "background-color", nextBg);
      }

      if (bgImage && bgImage.includes("gradient(")) {
        const nextGrad = transformGradient(bgImage);
        if (nextGrad) {
          this._setSavedStyle(el, "background-image", nextGrad);
        }
      }

      const textColor = parseRgba(style.color);
      const nextColor = transformText(textColor);
      if (nextColor) {
        this._setSavedStyle(el, "color", nextColor);
      }

      for (let i = 0; i < BORDER_PROPS.length; i++) {
        const bStyle = style[BORDER_STYLE_PROPS[i]];
        const bWidth = parseFloat(style[BORDER_WIDTH_PROPS[i]]) || 0;
        if (bStyle && bStyle !== "none" && bWidth > 0) {
          const nextBorder = transformBorder(parseRgba(style[BORDER_COLOR_COMPUTED[i]]));
          if (nextBorder) {
            this._setSavedStyle(el, BORDER_PROPS[i], nextBorder);
          }
        }
      }

      this._processSmallSvgIcon(el, style);
    }
  }

  _flushQueue() {
    this._rafId = null;
    if (this._destroyed || !this._activeDarkMode) {
      this._pendingQueue.length = 0;
      this._queueHead = 0;
      this._queuedSet.clear();
      return;
    }

    if (this.document?.hidden) {
      return;
    }

    let count = 0;
    while (this._queueHead < this._pendingQueue.length && count < BATCH_LIMIT) {
      const node = this._pendingQueue[this._queueHead++];
      this._queuedSet.delete(node);
      if (node && node.isConnected) {
        this._processElement(node);
      }
      count++;
    }

    if (this._queueHead >= this._pendingQueue.length) {
      this._pendingQueue.length = 0;
      this._queueHead = 0;
    } else if (this._queueHead > 512) {
      this._pendingQueue = this._pendingQueue.slice(this._queueHead);
      this._queueHead = 0;
    }

    if (this._queueHead < this._pendingQueue.length && this.contentWindow) {
      this._rafId = this.contentWindow.requestAnimationFrame(() => this._flushQueue());
    }
  }

  _scheduleFlush() {
    if (
      this._rafId !== null ||
      this._queueHead >= this._pendingQueue.length ||
      this.document?.hidden ||
      !this.contentWindow
    ) {
      return;
    }
    this._rafId = this.contentWindow.requestAnimationFrame(() => this._flushQueue());
  }

  _enqueueElement(el) {
    if (!el || el.nodeType !== 1 || this._processedElements.has(el) || this._queuedSet.has(el)) {
      return;
    }
    const upperTag = (el.tagName || "").toUpperCase();
    if (SKIP_TAGS.has(upperTag)) {
      return;
    }
    this._queuedSet.add(el);
    this._pendingQueue.push(el);
  }

  _enqueueTree(rootNode) {
    if (!rootNode || rootNode.nodeType !== 1) {
      return;
    }
    this._enqueueElement(rootNode);
    const descendants = rootNode.getElementsByTagName("*");
    for (let i = 0; i < descendants.length; i++) {
      this._enqueueElement(descendants[i]);
    }
    this._scheduleFlush();
  }

  _ensureObservers() {
    const win = this.contentWindow;
    const doc = this.document;
    const root = doc?.documentElement;
    if (!win || !doc || !root || typeof win.MutationObserver === "undefined") {
      return;
    }

    if (!this._domObserver) {
      this._domObserver = new win.MutationObserver((mutations) => {
        if (this._destroyed || !this._activeDarkMode) {
          return;
        }
        for (const mutation of mutations) {
          for (const added of mutation.addedNodes) {
            if (added && added.nodeType === 1) {
              this._enqueueTree(added);
            }
          }
        }
      });
      this._domObserver.observe(root, { childList: true, subtree: true });
    }

    if (!this._attrObserver) {
      this._attrObserver = new win.MutationObserver(() => {
        if (this._destroyed || this._attrTimerId !== null) {
          return;
        }
        this._attrTimerId = win.setTimeout(() => {
          this._attrTimerId = null;
          if (!this._destroyed) {
            this._evaluatePageDarkMode();
          }
        }, 60);
      });
      this._attrObserver.observe(root, {
        attributes: true,
        attributeFilter: ["class", "data-theme", "data-color-mode", "data-bs-theme", "dark"],
      });
      if (doc.body) {
        this._attrObserver.observe(doc.body, {
          attributes: true,
          attributeFilter: ["class", "data-theme", "data-color-mode", "data-bs-theme", "dark"],
        });
      }
      this._attrStopTimerId = win.setTimeout(() => {
        this._attrStopTimerId = null;
        if (this._attrObserver) {
          this._attrObserver.disconnect();
          this._attrObserver = null;
        }
      }, 3000);
    }

    if (!this._visibilityListener) {
      this._visibilityListener = () => {
        if (!this._destroyed && this._activeDarkMode && !doc.hidden) {
          this._scheduleFlush();
        }
      };
      doc.addEventListener("visibilitychange", this._visibilityListener);
    }
  }

  _stopDarkObservers() {
    const win = this.contentWindow;
    const doc = this.document;
    if (this._rafId !== null && win) {
      try {
        win.cancelAnimationFrame(this._rafId);
      } catch {}
    }
    this._rafId = null;

    if (this._attrTimerId !== null && win) {
      try {
        win.clearTimeout(this._attrTimerId);
      } catch {}
    }
    this._attrTimerId = null;

    if (this._attrStopTimerId !== null && win) {
      try {
        win.clearTimeout(this._attrStopTimerId);
      } catch {}
    }
    this._attrStopTimerId = null;

    if (this._visibilityListener && doc) {
      try {
        doc.removeEventListener("visibilitychange", this._visibilityListener);
      } catch {}
    }
    this._visibilityListener = null;

    this._pendingQueue.length = 0;
    this._queueHead = 0;
    this._queuedSet.clear();

    if (this._domObserver) {
      this._domObserver.disconnect();
      this._domObserver = null;
    }
    if (this._attrObserver) {
      this._attrObserver.disconnect();
      this._attrObserver = null;
    }
  }

  _restoreAllElements() {
    this._activeDarkMode = false;
    this._stopDarkObservers();

    const doc = this.document;
    if (doc) {
      const marked = doc.querySelectorAll("[" + FORCE_DARK_MARK_ATTR + "]");
      for (let i = 0; i < marked.length; i += 1) {
        const el = marked[i];
        const props = this._savedInlineStyles.get(el);
        if (props && el.style) {
          for (const prop of Object.keys(props)) {
            const [val, prio] = props[prop];
            if (val) {
              el.style.setProperty(prop, val, prio || "");
            } else {
              el.style.removeProperty(prop);
            }
          }
          if (el.getAttribute("style") === "") {
            el.removeAttribute("style");
          }
        }
        el.removeAttribute(FORCE_DARK_MARK_ATTR);
      }
    }
    this._savedInlineStyles = new WeakMap();
    this._processedElements = new WeakSet();

    const root = doc?.documentElement;
    if (root) {
      root.removeAttribute(FORCE_DARK_ATTR);
    }
  }

  _setForceDarkActive(active) {
    const win = this.contentWindow;
    const doc = this.document;
    const root = doc?.documentElement;
    if (!win || !doc || !root) {
      return;
    }
    if (active) {
      this._activeDarkMode = true;
      this._ensureDarkStyle();
      root.setAttribute(FORCE_DARK_ATTR, "true");
      this._ensureObservers();
      this._enqueueTree(doc.body || root);
    } else {
      this._restoreAllElements();
    }
    try {
      win.sessionStorage.setItem(FORCE_DARK_CACHE_KEY, active ? "on" : "off");
    } catch {}
  }

  _evaluatePageDarkMode() {
    if (this._destroyed || !this._isTopFrame) {
      return;
    }
    const win = this.contentWindow;
    const doc = this.document;
    if (!win || !doc) {
      return;
    }

    const enabled = this._policy ? this._policy.forceDarkEnabled !== false : true;
    const excluded = this._policy ? Boolean(this._policy.forceDarkExcluded) : false;

    if (!enabled || excluded) {
      this._restoreAllElements();
      if (this._styleEl && this._styleEl.isConnected) {
        this._styleEl.remove();
        this._styleEl = null;
      }
      try {
        win.sessionStorage.setItem(FORCE_DARK_CACHE_KEY, "off");
      } catch {}
      return;
    }

    if (doc.readyState === "loading" && !doc.body) {
      this._ensureDarkStyle();
      return;
    }

    this._ensureDarkStyle();
    if (this._isPageAlreadyDark()) {
      this._setForceDarkActive(false);
    } else {
      this._setForceDarkActive(true);
    }
  }

  _cleanupGeminiWatcher() {
    const win = this.contentWindow;
    if (this._geminiObserver) {
      this._geminiObserver.disconnect();
      this._geminiObserver = null;
    }
    if (this._geminiTimeoutId !== null && win) {
      try {
        win.clearTimeout(this._geminiTimeoutId);
      } catch {}
    }
    this._geminiTimeoutId = null;

    if (this._geminiRetryTimerId !== null && win) {
      try {
        win.clearTimeout(this._geminiRetryTimerId);
      } catch {}
    }
    this._geminiRetryTimerId = null;
  }

  _runGeminiBridge() {
    if (this._destroyed || !this._isTopFrame) {
      return;
    }
    const win = this.contentWindow;
    const doc = this.document;
    if (!win || !doc || win.location?.hostname !== "gemini.google.com") {
      return;
    }

    const hash = win.location.hash || "";
    if (!hash || !hash.startsWith("#")) {
      return;
    }
    const fragment = hash.slice(1);
    let rawEncoded = null;
    if (fragment.startsWith(GEMINI_HASH_KEY)) {
      rawEncoded = fragment.slice(GEMINI_HASH_KEY.length);
    } else {
      const idx = fragment.indexOf("&" + GEMINI_HASH_KEY);
      if (idx !== -1) {
        rawEncoded = fragment.slice(idx + 1 + GEMINI_HASH_KEY.length);
      }
    }
    if (rawEncoded === null) {
      return;
    }
    const ampIdx = rawEncoded.indexOf("&");
    if (ampIdx !== -1) {
      rawEncoded = rawEncoded.slice(0, ampIdx);
    }

    let decoded = rawEncoded;
    const normalizedEncoded = rawEncoded.replace(/\+/g, " ");
    try {
      decoded = decodeURIComponent(normalizedEncoded);
    } catch {
      decoded = normalizedEncoded;
    }

    try {
      win.history.replaceState(null, "", win.location.pathname + win.location.search);
    } catch {}

    const query = decoded.trim();
    if (!query) {
      return;
    }

    const isVisible = (el) => {
      if (!el || !el.isConnected) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const findEditor = () => {
      for (const sel of GEMINI_EDITOR_SELECTORS) {
        const cand = doc.querySelector(sel);
        if (cand && isVisible(cand)) {
          return cand;
        }
      }
      for (const sel of GEMINI_EDITOR_SELECTORS) {
        const cand = doc.querySelector(sel);
        if (cand) {
          return cand;
        }
      }
      return null;
    };

    const findSendBtn = () => {
      for (const sel of GEMINI_SEND_SELECTORS) {
        let candidates;
        try {
          candidates = doc.querySelectorAll(sel);
        } catch {
          continue;
        }
        for (const btn of candidates) {
          if (isVisible(btn) && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
            return btn;
          }
        }
      }
      return null;
    };

    const submitWithEditor = (editor) => {
      this._cleanupGeminiWatcher();
      editor.focus();
      while (editor.firstChild) {
        editor.removeChild(editor.firstChild);
      }
      for (const line of query.split(/\r?\n/)) {
        const p = doc.createElement("p");
        if (line.length > 0) {
          p.appendChild(doc.createTextNode(line));
        } else {
          p.appendChild(doc.createElement("br"));
        }
        editor.appendChild(p);
      }
      if (editor.classList) {
        editor.classList.remove("ql-blank");
      }
      try {
        const sel = win.getSelection();
        if (sel) {
          const range = doc.createRange();
          range.selectNodeContents(editor);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } catch {}
      try {
        editor.dispatchEvent(
          new win.InputEvent("input", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: query,
          })
        );
      } catch {
        editor.dispatchEvent(new win.Event("input", { bubbles: true }));
      }
      editor.dispatchEvent(new win.Event("change", { bubbles: true }));

      const trySend = (attempt) => {
        if (this._destroyed) {
          return;
        }
        const sendBtn = findSendBtn();
        if (sendBtn) {
          sendBtn.click();
          return;
        }
        if (attempt >= GEMINI_SEND_MAX_ATTEMPTS) {
          return;
        }
        this._geminiRetryTimerId = win.setTimeout(() => trySend(attempt + 1), GEMINI_SEND_RETRY_MS);
      };
      this._geminiRetryTimerId = win.setTimeout(() => trySend(0), 80);
    };

    this._cleanupGeminiWatcher();
    const existing = findEditor();
    if (existing) {
      submitWithEditor(existing);
      return;
    }

    const observeRoot = doc.body || doc.documentElement;
    if (!observeRoot || typeof win.MutationObserver === "undefined") {
      return;
    }
    this._geminiObserver = new win.MutationObserver(() => {
      const ed = findEditor();
      if (ed) {
        submitWithEditor(ed);
      }
    });
    this._geminiObserver.observe(observeRoot, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    this._geminiTimeoutId = win.setTimeout(() => this._cleanupGeminiWatcher(), GEMINI_WAIT_TIMEOUT_MS);
  }

  handleEvent(event) {
    if (this._destroyed) {
      return;
    }
    const hostname = this._getHostname();
    if (!hostname) {
      return;
    }

    switch (event.type) {
      case "DOMDocElementInserted": {
        if (this._isTopFrame) {
          try {
            this._ensureDarkStyle();
            if (this.contentWindow?.sessionStorage?.getItem(FORCE_DARK_CACHE_KEY) === "on") {
              this.document?.documentElement?.setAttribute(FORCE_DARK_ATTR, "true");
            }
          } catch {}
        }
        this._ensurePolicyLoaded().then((policy) => {
          if (this._destroyed || !policy) {
            return;
          }
          this._applyCosmeticPolicy(policy);
          if (this._isTopFrame) {
            this._evaluatePageDarkMode();
          }
        });
        break;
      }

      case "DOMContentLoaded": {
        this._ensurePolicyLoaded().then((policy) => {
          if (this._destroyed || !policy) {
            return;
          }
          this._applyCosmeticPolicy(policy);
          if (this._isTopFrame) {
            this._evaluatePageDarkMode();
            this._runGeminiBridge();
          }
        });
        break;
      }

      case "load": {
        if (this._isTopFrame) {
          this._evaluatePageDarkMode();
          this._runGeminiBridge();
        }
        break;
      }

      case "hashchange": {
        if (this._isTopFrame) {
          this._runGeminiBridge();
        }
        break;
      }
    }
  }

  receiveMessage(message) {
    if (this._destroyed || !message || message.name !== "Dragon:SettingsUpdated") {
      return;
    }
    this._policyPromise = null;
    this._ensurePolicyLoaded().then((policy) => {
      if (this._destroyed || !policy) {
        return;
      }
      this._applyCosmeticPolicy(policy);
      if (this._isTopFrame) {
        this._evaluatePageDarkMode();
      }
    });
  }

  didDestroy() {
    this._destroyed = true;
    this._stopDarkObservers();
    this._cleanupGeminiWatcher();
    this._savedInlineStyles = new WeakMap();
    this._processedElements = new WeakSet();
  }
}
