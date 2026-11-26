/* Dragon Browser — Native Settings Page Controller */
(() => {
  "use strict";

  const { DragonCoreService } = ChromeUtils.importESModule(
    "resource://dragon/DragonCoreService.sys.mjs"
  );

  const DEFAULT_AI_TARGETS = {
    gemini: "https://gemini.google.com/app#dragon_q={q}",
    claude: "https://claude.ai/new?q={q}",
    chatgpt: "https://chatgpt.com/?q={q}&hints=search",
    perplexity: "https://www.perplexity.ai/search?q={q}",
  };

  // DOM references
  const navLinks = Array.from(document.querySelectorAll(".nav-link"));

  const engineRadios = Array.from(document.querySelectorAll('input[name="defaultEngine"]'));
  const customSearchUrlInput = document.getElementById("custom-search-url");
  const customUrlHint = document.getElementById("custom-url-hint");

  const aiInputs = {
    gemini: document.getElementById("ai-url-gemini"),
    claude: document.getElementById("ai-url-claude"),
    chatgpt: document.getElementById("ai-url-chatgpt"),
    perplexity: document.getElementById("ai-url-perplexity"),
  };
  const resetAiDefaultsBtn = document.getElementById("reset-ai-defaults-btn");

  const adblockEnabledToggle = document.getElementById("adblock-enabled");
  const cosmeticBlockingToggle = document.getElementById("cosmetic-blocking-enabled");
  const allowlistForm = document.getElementById("allowlist-form");
  const allowlistInput = document.getElementById("allowlist-input");
  const allowlistChips = document.getElementById("allowlist-chips");
  const allowlistCount = document.getElementById("allowlist-count");
  const customBlockedTextarea = document.getElementById("custom-blocked-domains");
  const customBlockedCount = document.getElementById("custom-blocked-count");

  const openAddonsBtn = document.getElementById("open-addons-btn");
  const optionalAddonsList = document.getElementById("optional-addons-list");

  const tabSleepEnabledToggle = document.getElementById("tab-sleep-enabled");
  const sleepTimeoutBtns = Array.from(document.querySelectorAll("#sleep-timeout-group .segment-btn"));
  const sleepExcludedTextarea = document.getElementById("sleep-excluded-domains");
  const sleepExcludedCount = document.getElementById("sleep-excluded-count");

  const themeCards = Array.from(document.querySelectorAll(".theme-card[data-theme-choice]"));
  const forceDarkEnabledToggle = document.getElementById("force-dark-enabled");
  const forceDarkExcludedTextarea = document.getElementById("force-dark-excluded-domains");
  const forceDarkExcludedCount = document.getElementById("force-dark-excluded-count");

  const saveToast = document.getElementById("save-toast");

  let settings = DragonCoreService.getSettings();
  let toastTimer = null;
  const debounceTimers = new Map();

  function applyTheme(theme) {
    const valid = theme === "slate" ? "slate" : "obsidian";
    document.documentElement.dataset.theme = valid;
    for (const card of themeCards) {
      const active = card.dataset.themeChoice === valid;
      card.classList.toggle("is-active", active);
      card.setAttribute("aria-pressed", String(active));
    }
  }

  // Apply active theme synchronously
  applyTheme(settings.theme);

  function showSavedToast(text) {
    saveToast.textContent = text || "Saved";
    saveToast.hidden = false;
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(() => {
      saveToast.hidden = true;
    }, 1800);
  }

  function debounce(key, fn, delayMs) {
    if (debounceTimers.has(key)) {
      clearTimeout(debounceTimers.get(key));
    }
    const timer = setTimeout(() => {
      debounceTimers.delete(key);
      fn();
    }, delayMs);
    debounceTimers.set(key, timer);
  }

  function normalizeDomain(raw) {
    let val = String(raw || "").trim().toLowerCase();
    if (!val) {
      return "";
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(val)) {
      try {
        val = new URL(val).hostname.toLowerCase();
      } catch (_) {
        val = val.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
      }
    }
    val = val.replace(/^\*\./, "");
    val = val.split(/[/?#]/)[0];
    val = val.split(":")[0];
    val = val.replace(/^\.+|\.+$/g, "");
    if (!val || /\s/.test(val) || (!val.includes(".") && val !== "localhost")) {
      return "";
    }
    return val;
  }

  function parseDomainLines(text) {
    const seen = new Set();
    const list = [];
    for (const line of String(text || "").split(/\r?\n/)) {
      const cleaned = normalizeDomain(line);
      if (cleaned && !seen.has(cleaned)) {
        seen.add(cleaned);
        list.push(cleaned);
      }
    }
    return list;
  }

  function validateCustomSearchHint() {
    const val = customSearchUrlInput.value.trim();
    const isCustomSelected = settings.defaultEngine === "custom";
    if (!val && isCustomSelected) {
      customUrlHint.textContent =
        "Enter a URL containing {q} so custom search works (e.g. https://example.com/search?q={q}).";
      customUrlHint.classList.add("is-warning");
      return;
    }
    if (val && !val.includes("{q}")) {
      customUrlHint.textContent = "Template is missing the {q} placeholder for the search query.";
      customUrlHint.classList.add("is-warning");
      return;
    }
    customUrlHint.textContent = "Use {q} where your encoded search query should be inserted.";
    customUrlHint.classList.remove("is-warning");
  }

  function renderAllowlist() {
    const list = Array.isArray(settings.allowlist) ? settings.allowlist : [];
    allowlistCount.textContent = `${list.length} site${list.length === 1 ? "" : "s"}`;
    allowlistChips.replaceChildren();

    if (list.length === 0) {
      const note = document.createElement("span");
      note.className = "empty-note";
      note.textContent = "No allowlisted sites. Dragon Shield is protecting all sites.";
      allowlistChips.appendChild(note);
      return;
    }

    for (const domain of list) {
      const chip = document.createElement("span");
      chip.className = "domain-chip";

      const label = document.createElement("span");
      label.textContent = domain;

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "domain-chip-remove";
      removeBtn.title = `Remove ${domain}`;
      removeBtn.setAttribute("aria-label", `Remove ${domain} from allowlist`);
      removeBtn.textContent = "\u00D7";
      removeBtn.addEventListener("click", () => {
        const nextList = settings.allowlist.filter((d) => d !== domain);
        savePatch({ allowlist: nextList });
      });

      chip.appendChild(label);
      chip.appendChild(removeBtn);
      allowlistChips.appendChild(chip);
    }
  }

  function renderSleepTimeoutButtons() {
    const activeVal = settings.tabSleepEnabled ? Number(settings.tabSleepMinutes) || 5 : 0;
    for (const btn of sleepTimeoutBtns) {
      const btnMinutes = Number(btn.dataset.minutes);
      btn.classList.toggle("is-active", btnMinutes === activeVal);
    }
  }

  async function renderOptionalAddons() {
    if (!optionalAddonsList || typeof DragonCoreService.getOptionalBuiltins !== "function") {
      return;
    }
    try {
      const items = await DragonCoreService.getOptionalBuiltins();
      optionalAddonsList.replaceChildren();
      for (const item of items) {
        const row = document.createElement("div");
        row.className = "addon-row";

        const info = document.createElement("div");
        info.className = "addon-info";

        const titleLine = document.createElement("div");
        titleLine.className = "addon-title-line";

        const title = document.createElement("span");
        title.className = "addon-title";
        title.textContent = item.name;
        titleLine.appendChild(title);

        const badge = document.createElement("span");
        badge.className =
          item.category === "Recommended" ? "addon-badge is-recommended" : "addon-badge";
        badge.textContent = item.category;
        titleLine.appendChild(badge);

        const status = document.createElement("span");
        status.className = item.installed ? "addon-status is-active" : "addon-status";
        status.textContent = item.installed ? "Active" : "Off (0 MB RAM)";
        titleLine.appendChild(status);

        const desc = document.createElement("p");
        desc.className = "addon-desc";
        desc.textContent = item.description;

        info.appendChild(titleLine);
        info.appendChild(desc);

        const actionBtn = document.createElement("button");
        actionBtn.type = "button";
        actionBtn.className = item.installed ? "btn btn-secondary" : "btn btn-primary";
        actionBtn.textContent = item.installed ? "Remove" : "Install";
        actionBtn.addEventListener("click", async () => {
          actionBtn.disabled = true;
          try {
            if (item.installed) {
              await DragonCoreService.removeOptionalBuiltin(item.id);
              showSavedToast(`Removed ${item.name}`);
            } else {
              await DragonCoreService.installOptionalBuiltin(item.id);
              showSavedToast(`Installed ${item.name}`);
            }
          } catch (_) {
            showSavedToast("Extension action failed");
          } finally {
            await renderOptionalAddons();
          }
        });

        row.appendChild(info);
        row.appendChild(actionBtn);
        optionalAddonsList.appendChild(row);
      }
    } catch (_) {
      // Ignore if AddonManager not ready
    }
  }

  function renderDomainCounts() {
    const blockedLen = Array.isArray(settings.customBlockedDomains)
      ? settings.customBlockedDomains.length
      : 0;
    customBlockedCount.textContent = `${blockedLen} domain${blockedLen === 1 ? "" : "s"}`;

    const excludedLen = Array.isArray(settings.tabSleepExcludedDomains)
      ? settings.tabSleepExcludedDomains.length
      : 0;
    sleepExcludedCount.textContent = `${excludedLen} domain${excludedLen === 1 ? "" : "s"}`;

    const forceDarkExcludedLen = Array.isArray(settings.forceDarkExcludedDomains)
      ? settings.forceDarkExcludedDomains.length
      : 0;
    if (forceDarkExcludedCount) {
      forceDarkExcludedCount.textContent = `${forceDarkExcludedLen} domain${
        forceDarkExcludedLen === 1 ? "" : "s"
      }`;
    }
  }

  function renderAll(skipFocusedInputs) {
    for (const radio of engineRadios) {
      radio.checked = radio.value === (settings.defaultEngine || "google");
    }
    if (!skipFocusedInputs || document.activeElement !== customSearchUrlInput) {
      customSearchUrlInput.value = settings.customSearchUrl || "";
    }
    validateCustomSearchHint();

    const targets = { ...DEFAULT_AI_TARGETS, ...(settings.aiTargets || {}) };
    for (const key of Object.keys(aiInputs)) {
      const input = aiInputs[key];
      if (!skipFocusedInputs || document.activeElement !== input) {
        input.value = targets[key] || DEFAULT_AI_TARGETS[key];
      }
    }

    adblockEnabledToggle.checked = Boolean(settings.adblockEnabled);
    cosmeticBlockingToggle.checked = Boolean(settings.cosmeticBlockingEnabled);
    renderAllowlist();
    if (!skipFocusedInputs || document.activeElement !== customBlockedTextarea) {
      customBlockedTextarea.value = (settings.customBlockedDomains || []).join("\n");
    }

    tabSleepEnabledToggle.checked = Boolean(settings.tabSleepEnabled);
    renderSleepTimeoutButtons();
    if (!skipFocusedInputs || document.activeElement !== sleepExcludedTextarea) {
      sleepExcludedTextarea.value = (settings.tabSleepExcludedDomains || []).join("\n");
    }

    renderDomainCounts();

    applyTheme(settings.theme);
    if (forceDarkEnabledToggle) {
      forceDarkEnabledToggle.checked = settings.forceDarkEnabled !== false;
    }
    if (
      forceDarkExcludedTextarea &&
      (!skipFocusedInputs || document.activeElement !== forceDarkExcludedTextarea)
    ) {
      forceDarkExcludedTextarea.value = (settings.forceDarkExcludedDomains || []).join("\n");
    }
  }

  function savePatch(patch, toastMessage) {
    try {
      const next = DragonCoreService.updateSettings(patch);
      settings = {
        ...settings,
        ...next,
        aiTargets: { ...DEFAULT_AI_TARGETS, ...(next.aiTargets || {}) },
      };
      renderAll(true);
      showSavedToast(toastMessage || "Saved");
    } catch (_) {
      showSavedToast("Save failed");
    }
  }

  // Event wiring: Sidebar navigation
  for (const link of navLinks) {
    link.addEventListener("click", () => {
      for (const item of navLinks) {
        item.classList.toggle("is-active", item === link);
      }
    });
  }

  // Event wiring: Search Engine
  for (const radio of engineRadios) {
    radio.addEventListener("change", () => {
      if (radio.checked) {
        savePatch({ defaultEngine: radio.value });
      }
    });
  }

  customSearchUrlInput.addEventListener("input", () => {
    validateCustomSearchHint();
    debounce(
      "customSearchUrl",
      () => {
        savePatch({ customSearchUrl: customSearchUrlInput.value.trim() });
      },
      350
    );
  });

  // Event wiring: AI Chatbot Direct Search
  for (const key of Object.keys(aiInputs)) {
    const input = aiInputs[key];
    input.addEventListener("input", () => {
      debounce(
        `ai-${key}`,
        () => {
          const val = input.value.trim() || DEFAULT_AI_TARGETS[key];
          savePatch({
            aiTargets: {
              ...settings.aiTargets,
              [key]: val,
            },
          });
        },
        350
      );
    });
  }

  resetAiDefaultsBtn.addEventListener("click", () => {
    const restored = { ...DEFAULT_AI_TARGETS };
    for (const key of Object.keys(aiInputs)) {
      aiInputs[key].value = restored[key];
    }
    savePatch({ aiTargets: restored }, "AI defaults restored");
  });

  // Event wiring: Dragon Shield
  adblockEnabledToggle.addEventListener("change", () => {
    savePatch({ adblockEnabled: adblockEnabledToggle.checked });
  });

  cosmeticBlockingToggle.addEventListener("change", () => {
    savePatch({ cosmeticBlockingEnabled: cosmeticBlockingToggle.checked });
  });

  allowlistForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const cleaned = normalizeDomain(allowlistInput.value);
    if (!cleaned) {
      allowlistInput.focus();
      return;
    }
    const existing = Array.isArray(settings.allowlist) ? settings.allowlist : [];
    if (!existing.includes(cleaned)) {
      savePatch({ allowlist: [...existing, cleaned] });
    }
    allowlistInput.value = "";
  });

  customBlockedTextarea.addEventListener("input", () => {
    const parsed = parseDomainLines(customBlockedTextarea.value);
    customBlockedCount.textContent = `${parsed.length} domain${parsed.length === 1 ? "" : "s"}`;
    debounce(
      "customBlockedDomains",
      () => {
        savePatch({ customBlockedDomains: parseDomainLines(customBlockedTextarea.value) });
      },
      450
    );
  });

  // Event wiring: Auto-Sleeping Tabs
  tabSleepEnabledToggle.addEventListener("change", () => {
    const enabled = tabSleepEnabledToggle.checked;
    const minutes = Number(settings.tabSleepMinutes) > 0 ? Number(settings.tabSleepMinutes) : 5;
    savePatch({ tabSleepEnabled: enabled, tabSleepMinutes: minutes });
  });

  if (openAddonsBtn && typeof DragonCoreService.openAddonsTab === "function") {
    openAddonsBtn.addEventListener("click", () => {
      DragonCoreService.openAddonsTab();
    });
  }

  for (const btn of sleepTimeoutBtns) {
    btn.addEventListener("click", () => {
      const minutes = Number(btn.dataset.minutes);
      if (minutes === 0) {
        savePatch({ tabSleepEnabled: false });
      } else {
        savePatch({ tabSleepEnabled: true, tabSleepMinutes: minutes });
      }
    });
  }

  sleepExcludedTextarea.addEventListener("input", () => {
    const parsed = parseDomainLines(sleepExcludedTextarea.value);
    sleepExcludedCount.textContent = `${parsed.length} domain${parsed.length === 1 ? "" : "s"}`;
    debounce(
      "tabSleepExcludedDomains",
      () => {
        savePatch({ tabSleepExcludedDomains: parseDomainLines(sleepExcludedTextarea.value) });
      },
      450
    );
  });

  // Event wiring: Appearance
  for (const card of themeCards) {
    card.addEventListener("click", () => {
      const theme = card.dataset.themeChoice;
      if (!theme) {
        return;
      }
      applyTheme(theme);
      savePatch({ theme });
    });
  }

  if (forceDarkEnabledToggle) {
    forceDarkEnabledToggle.addEventListener("change", () => {
      savePatch({ forceDarkEnabled: forceDarkEnabledToggle.checked });
    });
  }

  if (forceDarkExcludedTextarea) {
    forceDarkExcludedTextarea.addEventListener("input", () => {
      const parsed = parseDomainLines(forceDarkExcludedTextarea.value);
      if (forceDarkExcludedCount) {
        forceDarkExcludedCount.textContent = `${parsed.length} domain${
          parsed.length === 1 ? "" : "s"
        }`;
      }
      debounce(
        "forceDarkExcludedDomains",
        () => {
          savePatch({ forceDarkExcludedDomains: parseDomainLines(forceDarkExcludedTextarea.value) });
        },
        450
      );
    });
  }

  const settingsObserver = {
    observe() {
      const next = DragonCoreService.getSettings();
      settings = {
        ...settings,
        ...next,
        aiTargets: { ...DEFAULT_AI_TARGETS, ...(next.aiTargets || {}) },
      };
      renderAll(true);
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
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
      }
      debounceTimers.clear();
      try {
        Services.obs.removeObserver(settingsObserver, "dragon-settings-changed");
      } catch {}
    },
    { once: true }
  );

  renderAll(false);
  renderOptionalAddons();
})();
