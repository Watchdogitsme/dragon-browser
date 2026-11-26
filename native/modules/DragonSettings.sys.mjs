/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
});

const PREF_SETTINGS = "dragon.settings.json";
const PREF_STATS = "dragon.stats.json";

const VALID_ENGINES = new Set([
  "google",
  "duckduckgo",
  "brave",
  "bing",
  "startpage",
  "custom",
]);

const VALID_THEMES = new Set(["obsidian", "slate"]);

export const DEFAULT_SETTINGS = Object.freeze({
  defaultEngine: "google",
  customSearchUrl: "",
  adblockEnabled: true,
  cosmeticBlockingEnabled: true,
  allowlist: [],
  customBlockedDomains: [],
  tabSleepEnabled: true,
  tabSleepMinutes: 5,
  tabSleepExcludedDomains: [],
  forceDarkEnabled: true,
  forceDarkExcludedDomains: [],
  enabledOptionalBuiltins: [],
  theme: "obsidian",
  aiTargets: {
    gemini: "https://gemini.google.com/app#dragon_q={q}",
    claude: "https://claude.ai/new?q={q}",
    chatgpt: "https://chatgpt.com/?q={q}&hints=search",
    perplexity: "https://www.perplexity.ai/search?q={q}",
  },
});

const DEFAULT_STATS = Object.freeze({
  totalBlocked: 0,
});

function normalizeDomain(input) {
  if (typeof input !== "string") {
    return "";
  }
  let value = input.trim().toLowerCase();
  if (!value) {
    return "";
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      value = new URL(value).hostname.toLowerCase();
    } catch {
      return "";
    }
  } else {
    const slashIdx = value.search(/[/?#]/);
    if (slashIdx !== -1) {
      value = value.slice(0, slashIdx);
    }
    const atIdx = value.lastIndexOf("@");
    if (atIdx !== -1) {
      value = value.slice(atIdx + 1);
    }
    if (!value.startsWith("[")) {
      const colonIdx = value.indexOf(":");
      if (colonIdx !== -1) {
        value = value.slice(0, colonIdx);
      }
    }
  }

  value = value.replace(/^\*+\./, "").replace(/^\.+/, "").replace(/\.+$/, "");
  if (!value || /\s/.test(value)) {
    return "";
  }
  return value;
}

function extractHostname(url) {
  if (typeof url !== "string" || !url) {
    return "";
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    return parsed.hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return "";
  }
}

function isDomainInSet(hostname, domainSet) {
  if (!hostname || !domainSet || domainSet.size === 0) {
    return false;
  }
  let host = hostname.toLowerCase();
  if (host.endsWith(".")) {
    host = host.slice(0, -1);
  }
  if (!host) {
    return false;
  }
  if (domainSet.has(host)) {
    return true;
  }
  let dotIdx = host.indexOf(".");
  while (dotIdx !== -1) {
    host = host.slice(dotIdx + 1);
    if (host && domainSet.has(host)) {
      return true;
    }
    dotIdx = host.indexOf(".");
  }
  return false;
}

function isDomainInList(hostname, list) {
  const clean = normalizeDomain(hostname);
  if (!clean || !Array.isArray(list)) {
    return false;
  }
  for (const item of list) {
    const entry = normalizeDomain(item);
    if (entry && (clean === entry || clean.endsWith("." + entry))) {
      return true;
    }
  }
  return false;
}

function sanitizeDomainList(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  const seen = new Set();
  const result = [];
  for (const raw of list) {
    const normalized = normalizeDomain(raw);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function sanitizeTemplateUrl(candidate, fallback) {
  if (typeof candidate !== "string") {
    return fallback;
  }
  const trimmed = candidate.trim();
  if (!trimmed) {
    return fallback;
  }
  try {
    const testUrl = new URL(trimmed.replaceAll("{q}", "test"));
    if (testUrl.protocol === "http:" || testUrl.protocol === "https:") {
      return trimmed;
    }
  } catch {
    // Ignore invalid template
  }
  return fallback;
}

function cloneSettings(settings) {
  return {
    defaultEngine: settings.defaultEngine,
    customSearchUrl: settings.customSearchUrl,
    adblockEnabled: Boolean(settings.adblockEnabled),
    cosmeticBlockingEnabled: Boolean(settings.cosmeticBlockingEnabled),
    allowlist: Array.isArray(settings.allowlist) ? settings.allowlist.slice() : [],
    customBlockedDomains: Array.isArray(settings.customBlockedDomains)
      ? settings.customBlockedDomains.slice()
      : [],
    tabSleepEnabled: Boolean(settings.tabSleepEnabled),
    tabSleepMinutes: Number(settings.tabSleepMinutes),
    tabSleepExcludedDomains: Array.isArray(settings.tabSleepExcludedDomains)
      ? settings.tabSleepExcludedDomains.slice()
      : [],
    forceDarkEnabled: settings.forceDarkEnabled !== false,
    forceDarkExcludedDomains: Array.isArray(settings.forceDarkExcludedDomains)
      ? settings.forceDarkExcludedDomains.slice()
      : [],
    enabledOptionalBuiltins: Array.isArray(settings.enabledOptionalBuiltins)
      ? settings.enabledOptionalBuiltins.slice()
      : [],
    theme: settings.theme === "slate" ? "slate" : "obsidian",
    aiTargets: {
      gemini: settings.aiTargets.gemini,
      claude: settings.aiTargets.claude,
      chatgpt: settings.aiTargets.chatgpt,
      perplexity: settings.aiTargets.perplexity,
    },
  };
}

function mergeSettings(base, patch) {
  const next = cloneSettings(base);
  if (!patch || typeof patch !== "object") {
    return next;
  }

  if (typeof patch.defaultEngine === "string") {
    const candidate = patch.defaultEngine.trim().toLowerCase();
    if (VALID_ENGINES.has(candidate)) {
      next.defaultEngine = candidate;
    }
  }

  if (typeof patch.customSearchUrl === "string") {
    const trimmed = patch.customSearchUrl.trim();
    next.customSearchUrl = trimmed ? sanitizeTemplateUrl(trimmed, next.customSearchUrl) : "";
  }

  if (typeof patch.adblockEnabled === "boolean") {
    next.adblockEnabled = patch.adblockEnabled;
  }

  if (typeof patch.cosmeticBlockingEnabled === "boolean") {
    next.cosmeticBlockingEnabled = patch.cosmeticBlockingEnabled;
  }

  if (Array.isArray(patch.allowlist)) {
    next.allowlist = sanitizeDomainList(patch.allowlist);
  }

  if (Array.isArray(patch.customBlockedDomains)) {
    next.customBlockedDomains = sanitizeDomainList(patch.customBlockedDomains);
  }

  if (typeof patch.tabSleepEnabled === "boolean") {
    next.tabSleepEnabled = patch.tabSleepEnabled;
  }

  if (patch.tabSleepMinutes !== undefined) {
    const mins = Number(patch.tabSleepMinutes);
    if (Number.isFinite(mins) && mins >= 0 && mins <= 1440) {
      next.tabSleepMinutes = Math.floor(mins);
    }
  }

  if (Array.isArray(patch.tabSleepExcludedDomains)) {
    next.tabSleepExcludedDomains = sanitizeDomainList(patch.tabSleepExcludedDomains);
  }

  if (typeof patch.forceDarkEnabled === "boolean") {
    next.forceDarkEnabled = patch.forceDarkEnabled;
  }

  if (Array.isArray(patch.forceDarkExcludedDomains)) {
    next.forceDarkExcludedDomains = sanitizeDomainList(patch.forceDarkExcludedDomains);
  }

  if (Array.isArray(patch.enabledOptionalBuiltins)) {
    const seen = new Set();
    const cleaned = [];
    for (const rawId of patch.enabledOptionalBuiltins) {
      const id = typeof rawId === "string" ? rawId.trim() : "";
      if (id && !seen.has(id)) {
        seen.add(id);
        cleaned.push(id);
      }
    }
    next.enabledOptionalBuiltins = cleaned;
  }

  if (typeof patch.theme === "string") {
    const theme = patch.theme.trim().toLowerCase();
    if (VALID_THEMES.has(theme)) {
      next.theme = theme;
    } else if (theme === "light") {
      next.theme = "obsidian";
    }
  }

  if (patch.aiTargets && typeof patch.aiTargets === "object") {
    for (const key of Object.keys(DEFAULT_SETTINGS.aiTargets)) {
      if (Object.prototype.hasOwnProperty.call(patch.aiTargets, key)) {
        next.aiTargets[key] = sanitizeTemplateUrl(
          patch.aiTargets[key],
          DEFAULT_SETTINGS.aiTargets[key]
        );
      }
    }
  }

  return next;
}

let initialized = false;
let currentSettings = cloneSettings(DEFAULT_SETTINGS);
let currentStats = { ...DEFAULT_STATS };

function broadcastContentPolicyUpdate() {
  try {
    const windows = lazy.BrowserWindowTracker?.orderedWindows || [];
    for (const win of windows) {
      if (!win || !win.gBrowser || !win.gBrowser.tabs) {
        continue;
      }
      for (const tab of win.gBrowser.tabs) {
        try {
          const topBc = tab?.linkedBrowser?.browsingContext;
          const contexts =
            typeof topBc?.getAllBrowsingContextsInSubtree === "function"
              ? topBc.getAllBrowsingContextsInSubtree()
              : topBc
                ? [topBc]
                : [];
          for (const bc of contexts) {
            try {
              const wg = bc?.currentWindowGlobal;
              const actor = wg?.getActor("DragonContent");
              if (actor) {
                actor.sendAsyncMessage("Dragon:SettingsUpdated", {});
              }
            } catch {
              // Subframe might not be HTTP/HTTPS or actor not attached
            }
          }
        } catch {
          // Tab might not be HTTP/HTTPS or browsing context not ready
        }
      }
    }
  } catch {
    // BrowserWindowTracker not ready
  }
}

function persistSettings() {
  try {
    Services.prefs.setStringPref(PREF_SETTINGS, JSON.stringify(currentSettings));
  } catch {
    // Ignore pref write errors
  }
  try {
    Services.obs.notifyObservers(null, "dragon-settings-changed");
  } catch {}
  broadcastContentPolicyUpdate();
}

function persistStats() {
  try {
    Services.prefs.setStringPref(PREF_STATS, JSON.stringify(currentStats));
  } catch {
    // Ignore pref write errors
  }
}

export const DragonSettings = {
  DEFAULT_SETTINGS,
  normalizeDomain,
  extractHostname,
  isDomainInSet,
  isDomainInList,
  sanitizeDomainList,

  init() {
    if (initialized) {
      return cloneSettings(currentSettings);
    }
    initialized = true;

    try {
      const rawSettings = Services.prefs.getStringPref(PREF_SETTINGS, "");
      if (rawSettings) {
        currentSettings = mergeSettings(DEFAULT_SETTINGS, JSON.parse(rawSettings));
      }
    } catch {
      currentSettings = cloneSettings(DEFAULT_SETTINGS);
    }

    try {
      const rawStats = Services.prefs.getStringPref(PREF_STATS, "");
      if (rawStats) {
        const parsed = JSON.parse(rawStats);
        if (parsed && Number.isFinite(parsed.totalBlocked) && parsed.totalBlocked >= 0) {
          currentStats.totalBlocked = Math.floor(parsed.totalBlocked);
        }
      }
    } catch {
      currentStats = { ...DEFAULT_STATS };
    }

    return cloneSettings(currentSettings);
  },

  getSettings() {
    this.init();
    return cloneSettings(currentSettings);
  },

  updateSettings(patch) {
    this.init();
    currentSettings = mergeSettings(currentSettings, patch);
    persistSettings();
    return cloneSettings(currentSettings);
  },

  getStats() {
    this.init();
    return { totalBlocked: currentStats.totalBlocked };
  },

  saveStats(stats) {
    this.init();
    if (stats && Number.isFinite(stats.totalBlocked) && stats.totalBlocked >= 0) {
      currentStats.totalBlocked = Math.floor(stats.totalBlocked);
      persistStats();
    }
  },

  toggleForceDarkSite(domain) {
    this.init();
    const clean = normalizeDomain(domain);
    const existing = Array.isArray(currentSettings.forceDarkExcludedDomains)
      ? currentSettings.forceDarkExcludedDomains.slice()
      : [];

    if (!clean) {
      return {
        isExcluded: false,
        forceDarkExcludedDomains: existing,
      };
    }

    const alreadyExcluded = isDomainInList(clean, existing);
    let nextList;
    let isExcluded;
    if (alreadyExcluded) {
      nextList = existing.filter((entry) => {
        const norm = normalizeDomain(entry);
        return !(norm && (clean === norm || clean.endsWith("." + norm)));
      });
      isExcluded = false;
    } else {
      nextList = existing.concat([clean]);
      isExcluded = true;
    }

    currentSettings = {
      ...currentSettings,
      forceDarkExcludedDomains: nextList,
    };
    persistSettings();

    return {
      isExcluded,
      forceDarkExcludedDomains: nextList.slice(),
    };
  },
};
