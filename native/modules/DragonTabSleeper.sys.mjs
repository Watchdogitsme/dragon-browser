/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DragonSettings } from "resource://dragon/DragonSettings.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
});

const SWEEP_PERIOD_MS = 60 * 1000;
const MINIMIZE_COOLDOWN_MS = 15 * 1000;
const ESTIMATED_RAM_PER_TAB_MB = 45;
const EXEMPT_URL_PREFIXES = [
  "about:",
  "chrome:",
  "resource:",
  "moz-extension:",
  "view-source:",
];

let initialized = false;
let sweepIntervalId = null;
let lastMinimizeTime = 0;
let excludedDomainSet = new Set();

const lastActiveByTab = new WeakMap();

const { normalizeDomain, extractHostname, isDomainInSet } = DragonSettings;

function rebuildExcludedDomains(settings) {
  excludedDomainSet.clear();
  if (Array.isArray(settings?.tabSleepExcludedDomains)) {
    for (const entry of settings.tabSleepExcludedDomains) {
      const domain = normalizeDomain(entry);
      if (domain) {
        excludedDomainSet.add(domain);
      }
    }
  }
}

function getTabUriSpec(tab) {
  try {
    return tab?.linkedBrowser?.currentURI?.spec || "";
  } catch {
    return "";
  }
}

function isInternalUrl(url) {
  if (typeof url !== "string" || !url) {
    return true;
  }
  const lower = url.toLowerCase();
  for (let i = 0; i < EXEMPT_URL_PREFIXES.length; i += 1) {
    if (lower.startsWith(EXEMPT_URL_PREFIXES[i])) {
      return true;
    }
  }
  return false;
}

function isTabAlreadySleeping(tab) {
  if (!tab || tab.selected || tab.closing) {
    return false;
  }
  return Boolean(tab.discarded || tab.hasAttribute("pending"));
}

function isTabExempt(tab) {
  if (!tab || tab.selected || tab.pinned || tab.closing || tab.soundPlaying) {
    return true;
  }
  if (isTabAlreadySleeping(tab)) {
    return true;
  }
  const uri = getTabUriSpec(tab);
  if (isInternalUrl(uri)) {
    return true;
  }
  const host = extractHostname(uri);
  if (host && isDomainInSet(host, excludedDomainSet)) {
    return true;
  }
  return false;
}

function getWindows() {
  try {
    return lazy.BrowserWindowTracker?.orderedWindows || [];
  } catch {
    return [];
  }
}

function touchTab(tab) {
  if (tab) {
    lastActiveByTab.set(tab, Date.now());
  }
}

function minimizeMemoryNow(force = false) {
  const now = Date.now();
  if (!force && now - lastMinimizeTime < MINIMIZE_COOLDOWN_MS) {
    return false;
  }
  lastMinimizeTime = now;
  try {
    Services.obs.notifyObservers(null, "memory-pressure", "heap-minimize");
    return true;
  } catch {
    return false;
  }
}

function sweepIdleTabs() {
  const settings = DragonSettings.getSettings();
  const minutes = Number(settings.tabSleepMinutes);
  if (!settings.tabSleepEnabled || !Number.isFinite(minutes) || minutes <= 0) {
    return 0;
  }

  const thresholdMs = minutes * 60 * 1000;
  const now = Date.now();
  let discardedCount = 0;

  for (const win of getWindows()) {
    const gb = win?.gBrowser;
    if (!gb || !gb.tabs) {
      continue;
    }
    for (const tab of Array.from(gb.tabs)) {
      if (!tab) {
        continue;
      }
      if (tab.selected || tab.soundPlaying) {
        lastActiveByTab.set(tab, now);
        continue;
      }
      if (isTabExempt(tab)) {
        continue;
      }

      const lastSeen = lastActiveByTab.get(tab);
      if (typeof lastSeen !== "number") {
        lastActiveByTab.set(tab, now);
        continue;
      }

      if (now - lastSeen >= thresholdMs && typeof gb.discardBrowser === "function") {
        try {
          if (gb.discardBrowser(tab, false)) {
            discardedCount += 1;
          }
        } catch {
          // Firefox may refuse to discard tabs with active beforeunload
        }
      }
    }
  }

  if (discardedCount > 0) {
    minimizeMemoryNow(false);
    try {
      Services.obs.notifyObservers(null, "dragon-tabs-slept");
    } catch {}
  }

  return discardedCount;
}

function getSleepStats() {
  let sleepingCount = 0;
  for (const win of getWindows()) {
    const tabs = win?.gBrowser?.tabs;
    if (!tabs) {
      continue;
    }
    for (const tab of tabs) {
      if (isTabAlreadySleeping(tab)) {
        sleepingCount += 1;
      }
    }
  }
  return {
    sleepingCount,
    estimatedRamSavedMb: sleepingCount * ESTIMATED_RAM_PER_TAB_MB,
  };
}

function sleepInactiveNow() {
  let discardedCount = 0;
  for (const win of getWindows()) {
    const gb = win?.gBrowser;
    if (!gb || !gb.tabs) {
      continue;
    }
    for (const tab of Array.from(gb.tabs)) {
      if (isTabExempt(tab)) {
        continue;
      }
      if (typeof gb.discardBrowser === "function") {
        try {
          if (gb.discardBrowser(tab, false)) {
            discardedCount += 1;
          }
        } catch {
          // Ignore tabs refusing discard
        }
      }
    }
  }

  minimizeMemoryNow(true);
  try {
    Services.obs.notifyObservers(null, "dragon-tabs-slept");
  } catch {}

  const stats = getSleepStats();
  return {
    discardedCount,
    sleepingCount: stats.sleepingCount,
    estimatedRamSavedMb: stats.estimatedRamSavedMb,
  };
}

const sleeperObserver = {
  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),

  observe(_subject, topic) {
    if (topic === "dragon-settings-changed") {
      rebuildExcludedDomains(DragonSettings.getSettings());
    } else if (topic === "xpcom-shutdown") {
      if (sweepIntervalId !== null) {
        lazy.clearInterval(sweepIntervalId);
        sweepIntervalId = null;
      }
      try {
        Services.obs.removeObserver(sleeperObserver, "dragon-settings-changed");
        Services.obs.removeObserver(sleeperObserver, "xpcom-shutdown");
      } catch {}
    }
  },
};

export const DragonTabSleeper = {
  ESTIMATED_RAM_PER_TAB_MB,

  init() {
    if (initialized) {
      return;
    }
    initialized = true;

    const settings = DragonSettings.init();
    rebuildExcludedDomains(settings);

    Services.obs.addObserver(sleeperObserver, "dragon-settings-changed");
    Services.obs.addObserver(sleeperObserver, "xpcom-shutdown");

    sweepIntervalId = lazy.setInterval(() => {
      try {
        sweepIdleTabs();
      } catch {}
    }, SWEEP_PERIOD_MS);
  },

  updateSettings(settings) {
    rebuildExcludedDomains(settings || DragonSettings.getSettings());
  },

  touchTab,
  isTabExempt,
  sweepIdleTabs,
  sleepInactiveNow,
  minimizeMemoryNow,
  getSleepStats,
};
