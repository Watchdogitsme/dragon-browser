/* Dragon Browser — Native Minimal Search-Pill Home Page Controller */
(() => {
  "use strict";

  const { DragonCoreService } = ChromeUtils.importESModule(
    "resource://dragon/DragonCoreService.sys.mjs"
  );

  const ENGINE_META = {
    google: {
      label: "Google",
      glyph: "G",
      prefix: "@google",
      category: "search",
      placeholder: "Search Google or enter a URL...",
    },
    duckduckgo: {
      label: "DuckDuckGo",
      glyph: "D",
      prefix: "@ddg",
      category: "search",
      placeholder: "Search DuckDuckGo privately...",
    },
    brave: {
      label: "Brave",
      glyph: "B",
      prefix: "@brave",
      category: "search",
      placeholder: "Search Brave...",
    },
    bing: {
      label: "Bing",
      glyph: "B",
      prefix: "@bing",
      category: "search",
      placeholder: "Search Bing...",
    },
    startpage: {
      label: "Startpage",
      glyph: "S",
      prefix: "@sp",
      category: "search",
      placeholder: "Search Startpage...",
    },
    custom: {
      label: "Custom",
      glyph: "C",
      prefix: "{q}",
      category: "search",
      placeholder: "Search custom engine...",
    },
    gemini: {
      label: "Gemini",
      glyph: "\u2726",
      prefix: "@gemini",
      category: "ai",
      placeholder: "Ask Gemini...",
    },
    claude: {
      label: "Claude",
      glyph: "\u25C8",
      prefix: "@claude",
      category: "ai",
      placeholder: "Ask Claude...",
    },
    chatgpt: {
      label: "ChatGPT",
      glyph: "\u25CE",
      prefix: "@gpt",
      category: "ai",
      placeholder: "Ask ChatGPT...",
    },
    perplexity: {
      label: "Perplexity",
      glyph: "\u2318",
      prefix: "@perp",
      category: "ai",
      placeholder: "Research with Perplexity...",
    },
  };

  const AI_BASE_URLS = {
    gemini: "https://gemini.google.com/app",
    claude: "https://claude.ai/new",
    chatgpt: "https://chatgpt.com/",
    perplexity: "https://www.perplexity.ai/",
  };

  const PREFIX_TO_ENGINE = {
    "@gemini": "gemini",
    "!gm": "gemini",
    "@claude": "claude",
    "!cl": "claude",
    "@gpt": "chatgpt",
    "@chatgpt": "chatgpt",
    "!gpt": "chatgpt",
    "@perp": "perplexity",
    "@perplexity": "perplexity",
    "!p": "perplexity",
    "@google": "google",
    "!g": "google",
    "@ddg": "duckduckgo",
    "!ddg": "duckduckgo",
    "@brave": "brave",
    "!b": "brave",
    "@bing": "bing",
    "@sp": "startpage",
  };

  // DOM references
  const privateModeBadge = document.getElementById("private-mode-badge");
  const searchForm = document.getElementById("search-form");
  const searchInput = document.getElementById("search-input");
  const searchClearBtn = document.getElementById("search-clear-btn");
  const targetPickerWrap = document.querySelector(".target-picker-wrap");
  const activeTargetPill = document.getElementById("active-target-pill");
  const activeTargetGlyph = document.getElementById("active-target-glyph");
  const activeTargetLabel = document.getElementById("active-target-label");
  const targetMenu = document.getElementById("target-menu");
  const targetMenuSearch = document.getElementById("target-menu-search");
  const toastEl = document.getElementById("home-toast");

  let currentSettings = DragonCoreService.getSettings();
  let selectedEngine = "google";
  let detectedPrefixEngine = null;
  let detectedPrefixToken = "";
  let toastTimer = null;

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === "slate" ? "slate" : "obsidian";
  }

  function applyPrivateContext(isPrivate) {
    if (!isPrivate) {
      return;
    }
    document.documentElement.dataset.private = "true";
    document.title = "Dragon Private";
    if (privateModeBadge) {
      privateModeBadge.hidden = false;
    }
  }

  // Apply theme & Private mode synchronously immediately on load
  applyTheme(currentSettings.theme);
  const isPrivateContext =
    window.location.search.includes("private=1") ||
    Boolean(window.browsingContext && window.browsingContext.usePrivateBrowsing);
  applyPrivateContext(isPrivateContext);

  function isSafeNavigationUrl(raw) {
    try {
      const parsed = new URL(raw);
      return (
        parsed.protocol === "https:" ||
        parsed.protocol === "http:" ||
        parsed.protocol === "about:" ||
        parsed.protocol === "chrome:" ||
        parsed.protocol === "resource:"
      );
    } catch (_) {
      return false;
    }
  }

  function normalizeUserUrl(raw) {
    const trimmed = String(raw || "").trim();
    if (!trimmed) {
      return null;
    }
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
      ? trimmed
      : "https://" + trimmed;
    try {
      const parsed = new URL(withScheme);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null;
      }
      if (!parsed.hostname) {
        return null;
      }
      return parsed.href;
    } catch (_) {
      return null;
    }
  }

  function looksLikeDirectUrl(value) {
    const trimmed = value.trim();
    if (!trimmed || /\s/.test(trimmed)) {
      return false;
    }
    if (/^(https?:\/\/|about:|chrome:\/\/|localhost(:\d{1,5})?([/?#]|$))/i.test(trimmed)) {
      return true;
    }
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?([/?#]|$)/.test(trimmed)) {
      return true;
    }
    const domainMatch = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d{1,5})?(?:[/?#]\S*)?$/i.exec(
      trimmed
    );
    if (!domainMatch) {
      return false;
    }
    const labels = domainMatch[1].split(".");
    const tld = labels[labels.length - 1];
    return /^[a-z]{2,24}$/i.test(tld) || /^xn--[a-z0-9-]{2,}$/i.test(tld);
  }

  function detectPrefix(value) {
    const leading = value.trimStart();
    const match = leading.match(/^(@[a-z]+|![a-z]+)(?:\s+|$)/i);
    if (!match) {
      return null;
    }
    const token = match[1].toLowerCase();
    const engineId = PREFIX_TO_ENGINE[token];
    if (!engineId) {
      return null;
    }
    return { token, engineId };
  }

  function stripLeadingPrefix(value) {
    const leading = value.trimStart();
    const match = leading.match(/^(@[a-z]+|![a-z]+)\s+/i);
    if (match && PREFIX_TO_ENGINE[match[1].toLowerCase()]) {
      return leading.slice(match[0].length);
    }
    const exactMatch = leading.match(/^(@[a-z]+|![a-z]+)$/i);
    if (exactMatch && PREFIX_TO_ENGINE[exactMatch[1].toLowerCase()]) {
      return "";
    }
    return value;
  }

  function getAllTargetOptions() {
    return Array.from(targetMenu.querySelectorAll(".target-option"));
  }

  function ensureExtraEngineOption(engineId) {
    if (!engineId || engineId === "google" || engineId === "duckduckgo" || engineId === "brave") {
      return;
    }
    const meta = ENGINE_META[engineId];
    if (!meta || meta.category !== "search") {
      return;
    }
    if (targetMenuSearch.querySelector(`.target-option[data-engine="${engineId}"]`)) {
      return;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "target-option";
    btn.setAttribute("role", "menuitemradio");
    btn.dataset.engine = engineId;
    btn.dataset.category = "search";
    btn.setAttribute("aria-checked", "false");

    const glyphSpan = document.createElement("span");
    glyphSpan.className = "target-option-glyph";
    glyphSpan.setAttribute("aria-hidden", "true");
    glyphSpan.textContent = meta.glyph;

    const nameSpan = document.createElement("span");
    nameSpan.className = "target-option-name";
    nameSpan.textContent = meta.label;

    const prefixSpan = document.createElement("span");
    prefixSpan.className = "target-option-prefix";
    prefixSpan.textContent = meta.prefix || "";

    btn.appendChild(glyphSpan);
    btn.appendChild(nameSpan);
    btn.appendChild(prefixSpan);
    targetMenuSearch.appendChild(btn);
  }

  function isTargetMenuOpen() {
    return targetMenu.classList.contains("is-open");
  }

  function openTargetMenu(focusSelected) {
    targetMenu.classList.add("is-open");
    targetMenu.setAttribute("aria-hidden", "false");
    targetMenu.removeAttribute("inert");
    activeTargetPill.setAttribute("aria-expanded", "true");
    if (focusSelected) {
      const targetId = detectedPrefixEngine || selectedEngine;
      const options = getAllTargetOptions();
      const activeOpt =
        options.find((opt) => opt.dataset.engine === targetId) || options[0];
      if (activeOpt) {
        activeOpt.focus();
      }
    }
  }

  function closeTargetMenu(restoreSearchFocus) {
    if (!isTargetMenuOpen()) {
      return;
    }
    targetMenu.classList.remove("is-open");
    targetMenu.setAttribute("aria-hidden", "true");
    targetMenu.setAttribute("inert", "");
    activeTargetPill.setAttribute("aria-expanded", "false");
    if (restoreSearchFocus) {
      searchInput.focus();
    }
  }

  function toggleTargetMenu() {
    if (isTargetMenuOpen()) {
      closeTargetMenu(false);
    } else {
      openTargetMenu(false);
    }
  }

  function updateTargetUI() {
    const value = searchInput.value;
    searchClearBtn.hidden = value.length === 0;

    const detected = detectPrefix(value);
    detectedPrefixEngine = detected ? detected.engineId : null;
    detectedPrefixToken = detected ? detected.token : "";

    const effectiveEngine = detectedPrefixEngine || selectedEngine;
    const meta = ENGINE_META[effectiveEngine] || ENGINE_META.google;
    const isDirectUrl = !detected && meta.category !== "ai" && looksLikeDirectUrl(value);

    for (const option of getAllTargetOptions()) {
      const isSelected = option.dataset.engine === effectiveEngine;
      option.classList.toggle("is-selected", isSelected);
      option.setAttribute("aria-checked", String(isSelected));
    }

    activeTargetPill.classList.toggle("is-prefix", Boolean(detectedPrefixEngine));
    if (isDirectUrl) {
      activeTargetPill.dataset.target = "url";
      activeTargetGlyph.textContent = "\u2197";
      activeTargetLabel.textContent = "Direct URL";
      searchForm.dataset.activeMode = "url";
    } else {
      activeTargetPill.dataset.target = effectiveEngine;
      activeTargetGlyph.textContent = meta.glyph;
      activeTargetLabel.textContent = detectedPrefixEngine
        ? `${meta.label} (${detectedPrefixToken})`
        : meta.label;
      searchForm.dataset.activeMode = effectiveEngine;
    }

    const selectedMeta = ENGINE_META[selectedEngine] || ENGINE_META.google;
    searchInput.placeholder = selectedMeta.placeholder;
  }

  function selectEngine(engineId) {
    if (!ENGINE_META[engineId]) {
      return;
    }
    selectedEngine = engineId;
    if (detectedPrefixEngine && detectedPrefixEngine !== engineId) {
      searchInput.value = stripLeadingPrefix(searchInput.value);
    }
    updateTargetUI();
    searchInput.focus();
  }

  function cycleEngine(direction) {
    const options = getAllTargetOptions();
    if (options.length === 0) {
      return;
    }
    const current = detectedPrefixEngine || selectedEngine;
    const currentIdx = options.findIndex((o) => o.dataset.engine === current);
    const startIdx = currentIdx === -1 ? 0 : currentIdx;
    const nextIdx = (startIdx + direction + options.length) % options.length;
    selectEngine(options[nextIdx].dataset.engine);
  }

  function launchQuery(overrideEngineId, openInNewTab) {
    const rawInput = searchInput.value.trim();
    const targetEngine = overrideEngineId || selectedEngine;

    if (!rawInput) {
      const baseAiUrl = AI_BASE_URLS[targetEngine];
      if (!baseAiUrl) {
        searchInput.focus();
        return;
      }
      const res = DragonCoreService.resolveQuery("", targetEngine);
      const targetUrl =
        res && typeof res.url === "string" && isSafeNavigationUrl(res.url)
          ? res.url
          : baseAiUrl;
      DragonCoreService.navigateFromPage(window, targetUrl, openInNewTab);
      return;
    }

    const effectiveInput =
      overrideEngineId && detectedPrefixEngine && detectedPrefixEngine !== overrideEngineId
        ? stripLeadingPrefix(rawInput)
        : rawInput;

    const response = DragonCoreService.resolveQuery(effectiveInput, targetEngine);
    let resolvedUrl =
      response && typeof response.url === "string" && isSafeNavigationUrl(response.url)
        ? response.url
        : null;

    if (!resolvedUrl) {
      resolvedUrl = looksLikeDirectUrl(effectiveInput)
        ? normalizeUserUrl(effectiveInput)
        : "https://www.google.com/search?q=" + encodeURIComponent(effectiveInput);
    }

    if (resolvedUrl && isSafeNavigationUrl(resolvedUrl)) {
      DragonCoreService.navigateFromPage(window, resolvedUrl, openInNewTab);
    }
  }

  // Event listeners
  searchInput.addEventListener("input", () => {
    updateTargetUI();
  });

  searchInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Tab" && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      ev.preventDefault();
      cycleEngine(ev.shiftKey ? -1 : 1);
      return;
    }
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      launchQuery(null, true);
    }
  });

  searchClearBtn.addEventListener("click", () => {
    searchInput.value = "";
    updateTargetUI();
    searchInput.focus();
  });

  searchForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    launchQuery(null, false);
  });

  activeTargetPill.addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleTargetMenu();
  });

  activeTargetPill.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      openTargetMenu(true);
    }
  });

  targetMenu.addEventListener("click", (ev) => {
    const option = ev.target.closest(".target-option");
    if (!option) {
      return;
    }
    const engineId = option.dataset.engine;
    if (!engineId) {
      return;
    }
    if (ev.shiftKey && searchInput.value.trim().length > 0) {
      closeTargetMenu(false);
      launchQuery(engineId, false);
      return;
    }
    selectEngine(engineId);
    closeTargetMenu(true);
  });

  targetMenu.addEventListener("keydown", (ev) => {
    const options = getAllTargetOptions();
    if (options.length === 0) {
      return;
    }
    const idx = options.indexOf(document.activeElement);
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      options[(idx + 1 + options.length) % options.length].focus();
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      options[(idx - 1 + options.length) % options.length].focus();
    } else if (ev.key === "Home") {
      ev.preventDefault();
      options[0].focus();
    } else if (ev.key === "End") {
      ev.preventDefault();
      options[options.length - 1].focus();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      closeTargetMenu(true);
    }
  });

  document.addEventListener("click", (ev) => {
    if (isTargetMenuOpen() && targetPickerWrap && !targetPickerWrap.contains(ev.target)) {
      closeTargetMenu(false);
    }
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && isTargetMenuOpen()) {
      closeTargetMenu(true);
      return;
    }
    if (
      ev.key === "/" &&
      !ev.ctrlKey &&
      !ev.altKey &&
      !ev.metaKey &&
      document.activeElement !== searchInput &&
      !isTargetMenuOpen()
    ) {
      ev.preventDefault();
      searchInput.focus();
    }
  });

  function syncSettingsFromService() {
    const prevDefault = currentSettings.defaultEngine;
    currentSettings = DragonCoreService.getSettings();
    applyTheme(currentSettings.theme);
    ensureExtraEngineOption(currentSettings.defaultEngine);
    if (selectedEngine === prevDefault && currentSettings.defaultEngine !== prevDefault) {
      selectedEngine = ENGINE_META[currentSettings.defaultEngine]
        ? currentSettings.defaultEngine
        : "google";
    }
    updateTargetUI();
  }

  const settingsObserver = {
    observe() {
      syncSettingsFromService();
    },
  };
  Services.obs.addObserver(settingsObserver, "dragon-settings-changed");

  window.addEventListener(
    "unload",
    () => {
      if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }
      try {
        Services.obs.removeObserver(settingsObserver, "dragon-settings-changed");
      } catch {}
    },
    { once: true }
  );

  // Initial synchronous render
  const defEngine = currentSettings.defaultEngine || "google";
  ensureExtraEngineOption(defEngine);
  selectedEngine = ENGINE_META[defEngine] ? defEngine : "google";
  updateTargetUI();
})();
