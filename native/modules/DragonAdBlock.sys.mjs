/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DragonSettings } from "resource://dragon/DragonSettings.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const FILTER_LIST_URI = "resource://dragon/filter-lists.json";
const COSMETIC_CHUNK_SIZE = 12;
const STATS_PERSIST_DEBOUNCE_MS = 1500;
const UI_NOTIFY_DEBOUNCE_MS = 80;

const { normalizeDomain, extractHostname, isDomainInSet } = DragonSettings;

let initialized = false;
let observerRegistered = false;

const baseDomainSet = new Set();
const customDomainSet = new Set();
const allowlistSet = new Set();
let compiledUrlPatterns = [];
let cosmeticSelectors = [];
let cachedCosmeticCss = "";
let cachedAdblockEnabled = true;
let cachedCosmeticEnabled = true;

const browserDomains = new WeakMap();
const browserBlockedCounts = new WeakMap();

let totalBlocked = 0;
let statsPersistTimer = null;
let uiNotifyTimer = null;

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

function syncSharedPagePolicy(settings) {
  const active = settings || DragonSettings.getSettings();
  try {
    if (!Services?.ppmm?.sharedData) {
      return;
    }
    const cosmeticActive = Boolean(active.adblockEnabled && active.cosmeticBlockingEnabled);
    Services.ppmm.sharedData.set("dragon:pagePolicy", {
      cosmeticEnabled: cosmeticActive,
      cosmeticCss: cosmeticActive ? cachedCosmeticCss : "",
      allowlist: Array.isArray(active.allowlist) ? active.allowlist.slice() : [],
      forceDarkEnabled: active.forceDarkEnabled !== false,
      forceDarkExcludedDomains: Array.isArray(active.forceDarkExcludedDomains)
        ? active.forceDarkExcludedDomains.slice()
        : [],
    });
    Services.ppmm.sharedData.flush();
  } catch {
    // sharedData unavailable in restricted contexts
  }
}

function rebuildDynamicSets(settings) {
  const active = settings || DragonSettings.getSettings();
  cachedAdblockEnabled = Boolean(active.adblockEnabled);
  cachedCosmeticEnabled = Boolean(active.cosmeticBlockingEnabled);

  allowlistSet.clear();
  if (Array.isArray(active.allowlist)) {
    for (const entry of active.allowlist) {
      const domain = normalizeDomain(entry);
      if (domain) {
        allowlistSet.add(domain);
      }
    }
  }

  customDomainSet.clear();
  if (Array.isArray(active.customBlockedDomains)) {
    for (const entry of active.customBlockedDomains) {
      const domain = normalizeDomain(entry);
      if (domain) {
        customDomainSet.add(domain);
      }
    }
  }

  syncSharedPagePolicy(active);
}

function loadFilterListsSync() {
  baseDomainSet.clear();
  compiledUrlPatterns = [];
  cosmeticSelectors = [];

  try {
    const channel = lazy.NetUtil.newChannel({
      uri: FILTER_LIST_URI,
      loadUsingSystemPrincipal: true,
    });
    const stream = channel.open();
    const raw = lazy.NetUtil.readInputStreamToString(stream, stream.available(), {
      charset: "utf-8",
    });
    stream.close();

    const data = JSON.parse(raw);

    if (Array.isArray(data.domains)) {
      for (const rawDomain of data.domains) {
        const domain = normalizeDomain(rawDomain);
        if (domain) {
          baseDomainSet.add(domain);
        }
      }
    }

    if (Array.isArray(data.urlPatterns)) {
      for (const pattern of data.urlPatterns) {
        if (typeof pattern !== "string" || !pattern) {
          continue;
        }
        try {
          compiledUrlPatterns.push(new RegExp(pattern, "i"));
        } catch {
          // Skip malformed pattern safely
        }
      }
    }

    if (Array.isArray(data.cosmeticSelectors)) {
      cosmeticSelectors = data.cosmeticSelectors.filter(
        (sel) => typeof sel === "string" && sel.trim().length > 0
      );
    }
    cachedCosmeticCss = buildCosmeticCss(cosmeticSelectors);
  } catch (err) {
    console.error("[Dragon AdBlock] Failed to load native filter-lists.json:", err);
  }
}

function scheduleStatsPersist() {
  if (statsPersistTimer !== null) {
    return;
  }
  statsPersistTimer = lazy.setTimeout(() => {
    statsPersistTimer = null;
    DragonSettings.saveStats({ totalBlocked });
  }, STATS_PERSIST_DEBOUNCE_MS);
}

function scheduleUiNotify() {
  if (uiNotifyTimer !== null) {
    return;
  }
  uiNotifyTimer = lazy.setTimeout(() => {
    uiNotifyTimer = null;
    try {
      Services.obs.notifyObservers(null, "dragon-stats-changed");
    } catch {}
  }, UI_NOTIFY_DEBOUNCE_MS);
}

function isAllowlisted(hostname) {
  const normalized = normalizeDomain(hostname);
  if (!normalized) {
    return false;
  }
  return isDomainInSet(normalized, allowlistSet);
}

function extractUriHostname(uri) {
  if (!uri) {
    return "";
  }
  try {
    const host = uri.asciiHost || uri.host || "";
    return host ? host.toLowerCase().replace(/\.+$/, "") : "";
  } catch {
    return extractHostname(uri.spec || "");
  }
}

function shouldBlockRequest(url, isMainDocument, tabOriginHost, settings, precomputedHost = "") {
  const enabled = settings ? Boolean(settings.adblockEnabled) : cachedAdblockEnabled;
  if (!enabled) {
    return false;
  }

  const requestHost = precomputedHost || extractHostname(url);
  if (!requestHost) {
    return false;
  }

  if (tabOriginHost && isAllowlisted(tabOriginHost)) {
    return false;
  }

  if (isMainDocument) {
    if (isAllowlisted(requestHost)) {
      return false;
    }
    return isDomainInSet(requestHost, customDomainSet);
  }

  if (
    isDomainInSet(requestHost, baseDomainSet) ||
    isDomainInSet(requestHost, customDomainSet)
  ) {
    return true;
  }

  for (let i = 0; i < compiledUrlPatterns.length; i += 1) {
    if (compiledUrlPatterns[i].test(url)) {
      return true;
    }
  }

  return false;
}

const requestObserver = {
  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),

  observe(subject, topic) {
    if (topic === "xpcom-shutdown") {
      if (statsPersistTimer !== null) {
        lazy.clearTimeout(statsPersistTimer);
        statsPersistTimer = null;
      }
      if (uiNotifyTimer !== null) {
        lazy.clearTimeout(uiNotifyTimer);
        uiNotifyTimer = null;
      }
      try {
        Services.obs.removeObserver(requestObserver, "http-on-modify-request");
        Services.obs.removeObserver(requestObserver, "dragon-settings-changed");
        Services.obs.removeObserver(requestObserver, "xpcom-shutdown");
      } catch {}
      return;
    }

    if (topic === "dragon-settings-changed") {
      rebuildDynamicSets(DragonSettings.getSettings());
      scheduleUiNotify();
      return;
    }

    if (topic !== "http-on-modify-request") {
      return;
    }

    if (!cachedAdblockEnabled) {
      return;
    }

    let channel;
    try {
      channel = subject.QueryInterface(Ci.nsIHttpChannel);
    } catch {
      return;
    }

    const uri = channel.URI;
    if (!uri) {
      return;
    }
    const scheme = uri.scheme;
    if (scheme !== "http" && scheme !== "https") {
      return;
    }

    const loadInfo = channel.loadInfo;
    if (!loadInfo) {
      return;
    }

    const policyType = loadInfo.externalContentPolicyType;
    const isMainDocument = policyType === Ci.nsIContentPolicy.TYPE_DOCUMENT;

    // Never interfere with internal browser/system fetches outside page documents
    if (
      !isMainDocument &&
      loadInfo.loadingPrincipal?.isSystemPrincipal &&
      !loadInfo.browsingContext
    ) {
      return;
    }

    // Ignore requests explicitly originating from internal chrome/resource pages
    if (
      !isMainDocument &&
      (loadInfo.triggeringPrincipal?.schemeIs?.("chrome") ||
        loadInfo.triggeringPrincipal?.schemeIs?.("resource"))
    ) {
      return;
    }

    const requestUrl = uri.spec;
    const requestHost = extractUriHostname(uri);

    let browser = null;
    try {
      browser = loadInfo.browsingContext?.top?.embedderElement || null;
    } catch {
      browser = null;
    }

    if (isMainDocument) {
      if (browser) {
        if (requestHost) {
          browserDomains.set(browser, requestHost);
        } else {
          browserDomains.delete(browser);
        }
        browserBlockedCounts.set(browser, 0);
        scheduleUiNotify();
      }

      if (shouldBlockRequest(requestUrl, true, requestHost, null, requestHost)) {
        totalBlocked += 1;
        scheduleStatsPersist();
        if (browser) {
          browserBlockedCounts.set(browser, 1);
        }
        scheduleUiNotify();
        try {
          channel.cancel(Cr.NS_BINDING_ABORTED);
        } catch {}
      }
      return;
    }

    let tabOriginHost = (browser ? browserDomains.get(browser) : "") || "";
    if (!tabOriginHost && browser?.currentURI) {
      tabOriginHost = extractUriHostname(browser.currentURI);
    }
    if (!tabOriginHost && loadInfo.topLevelPrincipal?.URI) {
      tabOriginHost = extractUriHostname(loadInfo.topLevelPrincipal.URI);
    }
    if (!tabOriginHost && loadInfo.triggeringPrincipal?.URI) {
      tabOriginHost = extractUriHostname(loadInfo.triggeringPrincipal.URI);
    }

    if (shouldBlockRequest(requestUrl, false, tabOriginHost, null, requestHost)) {
      totalBlocked += 1;
      scheduleStatsPersist();
      if (browser) {
        browserBlockedCounts.set(browser, (browserBlockedCounts.get(browser) || 0) + 1);
      }
      scheduleUiNotify();
      try {
        channel.cancel(Cr.NS_BINDING_ABORTED);
      } catch {}
    }
  },
};

export const DragonAdBlock = {
  init() {
    if (initialized) {
      return;
    }
    initialized = true;

    const settings = DragonSettings.init();
    const stats = DragonSettings.getStats();
    totalBlocked = Number.isFinite(stats.totalBlocked) ? stats.totalBlocked : 0;

    loadFilterListsSync();
    rebuildDynamicSets(settings);

    if (!observerRegistered) {
      observerRegistered = true;
      Services.obs.addObserver(requestObserver, "http-on-modify-request");
      Services.obs.addObserver(requestObserver, "dragon-settings-changed");
      Services.obs.addObserver(requestObserver, "xpcom-shutdown");
    }
  },

  updateSettings(settings) {
    rebuildDynamicSets(settings || DragonSettings.getSettings());
    scheduleUiNotify();
  },

  isAllowlisted,

  toggleAllowlist(domain) {
    const normalized = normalizeDomain(domain);
    const settings = DragonSettings.getSettings();
    const existingList = Array.isArray(settings.allowlist)
      ? settings.allowlist.map(normalizeDomain).filter(Boolean)
      : [];

    if (!normalized) {
      return {
        isAllowlisted: false,
        allowlist: Array.from(new Set(existingList)),
      };
    }

    const currentlyAllowlisted = isAllowlisted(normalized);
    let nextList;

    if (currentlyAllowlisted) {
      nextList = existingList.filter((entry) => {
        if (entry === normalized) {
          return false;
        }
        return !normalized.endsWith("." + entry);
      });
    } else {
      nextList = Array.from(new Set([...existingList, normalized]));
    }

    const updated = DragonSettings.updateSettings({ allowlist: nextList });
    rebuildDynamicSets(updated);

    return {
      isAllowlisted: !currentlyAllowlisted,
      allowlist: updated.allowlist.slice(),
    };
  },

  getCosmeticStatus(hostname) {
    const normalized = normalizeDomain(hostname);
    const enabled = Boolean(
      cachedAdblockEnabled &&
        cachedCosmeticEnabled &&
        normalized &&
        !isAllowlisted(normalized)
    );
    return {
      enabled,
      selectors: enabled ? cosmeticSelectors.slice() : [],
    };
  },

  getCosmeticCss() {
    return cachedCosmeticCss;
  },

  getPagePolicyForHost(hostname) {
    const settings = DragonSettings.getSettings();
    const normalized = normalizeDomain(hostname);
    const cosmeticEnabled = Boolean(
      settings.adblockEnabled &&
        settings.cosmeticBlockingEnabled &&
        normalized &&
        !isAllowlisted(normalized)
    );
    return {
      cosmeticEnabled,
      cosmeticCss: cosmeticEnabled ? cachedCosmeticCss : "",
      cosmeticSelectors: cosmeticEnabled && !cachedCosmeticCss ? cosmeticSelectors.slice() : [],
      forceDarkEnabled: settings.forceDarkEnabled !== false,
      forceDarkExcluded: DragonSettings.isDomainInList(
        hostname,
        settings.forceDarkExcludedDomains
      ),
    };
  },

  resetBrowserCount(browser, urlSpec) {
    if (!browser) {
      return;
    }
    const host = extractHostname(urlSpec || "");
    const prevHost = browserDomains.get(browser) || "";
    if (host) {
      browserDomains.set(browser, host);
    } else {
      browserDomains.delete(browser);
    }
    if (host !== prevHost) {
      browserBlockedCounts.set(browser, 0);
      scheduleUiNotify();
    }
  },

  getBrowserBlockedCount(browser) {
    return browser ? browserBlockedCounts.get(browser) || 0 : 0;
  },

  getTotalBlocked() {
    return totalBlocked;
  },

  getBrowserDomain(browser) {
    if (!browser) {
      return "";
    }
    return (
      extractHostname(browser.currentURI?.spec || "") ||
      browserDomains.get(browser) ||
      ""
    );
  },

  shouldBlockRequest,
};
