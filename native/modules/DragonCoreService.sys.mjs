/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DragonSettings } from "resource://dragon/DragonSettings.sys.mjs";
import { DragonSearchRouter } from "resource://dragon/DragonSearchRouter.sys.mjs";
import { DragonAdBlock } from "resource://dragon/DragonAdBlock.sys.mjs";
import { DragonTabSleeper } from "resource://dragon/DragonTabSleeper.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
});

export const DRAGON_HOME_URL = "chrome://dragon/content/home/home.html";
export const DRAGON_PRIVATE_HOME_URL = "chrome://dragon/content/home/home.html?private=1";
export const DRAGON_SETTINGS_URL = "chrome://dragon/content/settings/settings.html";

export const OPTIONAL_BUILTIN_ADDONS = Object.freeze([
  {
    id: "webcompat@mozilla.org",
    name: "Web Compatibility Fixes",
    category: "Recommended",
    resUrl: "resource://builtin-addons/webcompat/",
    description:
      "Mozilla site-specific compatibility interventions for websites that misbehave on Gecko.",
  },
  {
    id: "pictureinpicture@mozilla.org",
    name: "Picture-in-Picture Overrides",
    category: "Recommended",
    resUrl: "resource://builtin-addons/pictureinpicture/",
    description:
      "Enhanced video caption and control overrides for Picture-in-Picture on streaming sites.",
  },
  {
    id: "formautofill@mozilla.org",
    name: "Form & Payment Autofill",
    category: "Recommended",
    resUrl: "resource://builtin-addons/formautofill/",
    description: "Automatic address and credit card form autofill.",
  },
  {
    id: "newtab@mozilla.org",
    name: "Mozilla New Tab (Legacy)",
    category: "Optional",
    resUrl: "resource://builtin-addons/newtab/",
    description:
      "Stock Firefox Activity Stream New Tab backend (replaced by Dragon Home by default).",
  },
  {
    id: "addons-search-detection@mozilla.com",
    name: "Add-ons Search Detection",
    category: "Optional",
    resUrl: "resource://builtin-addons/search-detection/",
    description:
      "Mozilla search-hijack detection add-on (uses webRequest on all URLs).",
  },
  {
    id: "ipp-activator@mozilla.com",
    name: "Mozilla IPP Activator",
    category: "Optional",
    resUrl: "resource://builtin-addons/ipp-activator/",
    description:
      "Mozilla IP Protection / VPN activation helper (uses webRequest on all URLs).",
  },
]);

function ensureInitialized() {
  DragonSettings.init();
  DragonAdBlock.init();
  DragonTabSleeper.init();
}

export const DragonCoreService = {
  DRAGON_HOME_URL,
  DRAGON_PRIVATE_HOME_URL,
  DRAGON_SETTINGS_URL,

  ensureInitialized,

  getSettings() {
    ensureInitialized();
    return DragonSettings.getSettings();
  },

  updateSettings(patch) {
    ensureInitialized();
    const next = DragonSettings.updateSettings(patch);
    DragonAdBlock.updateSettings(next);
    DragonTabSleeper.updateSettings(next);
    return next;
  },

  resolveQuery(input, engineId) {
    ensureInitialized();
    const settings = DragonSettings.getSettings();
    return DragonSearchRouter.resolveQuery(input, engineId, settings);
  },

  getEngines() {
    ensureInitialized();
    return DragonSearchRouter.getEngines(DragonSettings.getSettings());
  },

  getAiTargets() {
    ensureInitialized();
    return DragonSearchRouter.getAiTargets(DragonSettings.getSettings());
  },

  getStateForBrowser(browser) {
    ensureInitialized();
    const settings = DragonSettings.getSettings();
    const currentDomain = DragonAdBlock.getBrowserDomain(browser);
    const sleepStats = DragonTabSleeper.getSleepStats();

    return {
      settings,
      stats: {
        totalBlocked: DragonAdBlock.getTotalBlocked(),
        tabBlocked: DragonAdBlock.getBrowserBlockedCount(browser),
        sleepingCount: sleepStats.sleepingCount,
        estimatedRamSavedMb: sleepStats.estimatedRamSavedMb,
        currentDomain,
        isAllowlisted: currentDomain ? DragonAdBlock.isAllowlisted(currentDomain) : false,
        isForceDarkExcluded: currentDomain
          ? DragonSettings.isDomainInList(currentDomain, settings.forceDarkExcludedDomains)
          : false,
      },
      engines: DragonSearchRouter.getEngines(settings),
      aiTargets: DragonSearchRouter.getAiTargets(settings),
    };
  },

  toggleAllowlist(domain) {
    ensureInitialized();
    return DragonAdBlock.toggleAllowlist(domain);
  },

  toggleForceDarkSite(domain) {
    ensureInitialized();
    return DragonSettings.toggleForceDarkSite(domain);
  },

  getBrowserBlockedCount(browser) {
    ensureInitialized();
    return DragonAdBlock.getBrowserBlockedCount(browser);
  },

  resetBrowserCount(browser, urlSpec) {
    ensureInitialized();
    DragonAdBlock.resetBrowserCount(browser, urlSpec);
  },

  touchTab(tab) {
    ensureInitialized();
    DragonTabSleeper.touchTab(tab);
  },

  getSleepStats() {
    ensureInitialized();
    return DragonTabSleeper.getSleepStats();
  },

  sleepInactiveNow() {
    ensureInitialized();
    return DragonTabSleeper.sleepInactiveNow();
  },

  minimizeMemoryNow() {
    ensureInitialized();
    return DragonTabSleeper.minimizeMemoryNow(true);
  },

  async getOptionalBuiltins() {
    ensureInitialized();
    const results = [];
    for (const item of OPTIONAL_BUILTIN_ADDONS) {
      let installed = false;
      try {
        const addon = await lazy.AddonManager.getAddonByID(item.id);
        installed = Boolean(addon && addon.isActive);
      } catch {
        installed = false;
      }
      results.push({
        id: item.id,
        name: item.name,
        category: item.category,
        resUrl: item.resUrl,
        description: item.description,
        installed,
      });
    }
    return results;
  },

  async installOptionalBuiltin(addonId) {
    ensureInitialized();
    const entry = OPTIONAL_BUILTIN_ADDONS.find((item) => item.id === addonId);
    if (!entry) {
      throw new Error(`Unknown optional built-in extension: ${addonId}`);
    }
    await lazy.AddonManager.installBuiltinAddon(entry.resUrl);
    const settings = DragonSettings.getSettings();
    const nextList = Array.from(
      new Set([...(settings.enabledOptionalBuiltins || []), entry.id])
    );
    DragonSettings.updateSettings({ enabledOptionalBuiltins: nextList });
    return this.getOptionalBuiltins();
  },

  async removeOptionalBuiltin(addonId) {
    ensureInitialized();
    const settings = DragonSettings.getSettings();
    const nextList = (settings.enabledOptionalBuiltins || []).filter((id) => id !== addonId);
    DragonSettings.updateSettings({ enabledOptionalBuiltins: nextList });
    try {
      const addon = await lazy.AddonManager.getAddonByID(addonId);
      if (addon) {
        if (typeof addon.uninstall === "function") {
          await addon.uninstall();
        } else if (typeof addon.disable === "function") {
          await addon.disable();
        }
      }
    } catch {
      // Already uninstalled or inactive
    }
    return this.getOptionalBuiltins();
  },

  openAddonsTab(chromeWin) {
    const win = chromeWin || lazy.BrowserWindowTracker?.getTopWindow?.() || null;
    if (!win) {
      return;
    }
    if (typeof win.switchToTabHavingURI === "function") {
      win.switchToTabHavingURI("about:addons", true);
    } else if (typeof win.openTrustedLinkIn === "function") {
      win.openTrustedLinkIn("about:addons", "tab");
    }
  },

  navigateFromPage(contentWin, url, openInNewTab) {
    if (typeof url !== "string" || !url.trim()) {
      return;
    }
    const cleanUrl = url.trim();
    const where = openInNewTab ? "tab" : "current";

    let chromeWin = null;
    try {
      chromeWin =
        contentWin?.browsingContext?.topChromeWindow ||
        lazy.BrowserWindowTracker?.getTopWindow?.() ||
        null;
    } catch {
      chromeWin = lazy.BrowserWindowTracker?.getTopWindow?.() || null;
    }

    const isWeb = /^https?:\/\//i.test(cleanUrl);
    if (chromeWin) {
      if (isWeb && typeof chromeWin.openWebLinkIn === "function") {
        chromeWin.openWebLinkIn(cleanUrl, where);
        return;
      }
      if (typeof chromeWin.openTrustedLinkIn === "function") {
        chromeWin.openTrustedLinkIn(cleanUrl, where);
        return;
      }
    }

    if (contentWin && contentWin.location) {
      contentWin.location.assign(cleanUrl);
    }
  },

  openPrivateWindow() {
    const chromeWin = lazy.BrowserWindowTracker?.getTopWindow?.() || null;
    if (chromeWin && typeof chromeWin.OpenBrowserWindow === "function") {
      chromeWin.OpenBrowserWindow({ private: true });
    }
  },

  openSettingsTab(chromeWin) {
    const win = chromeWin || lazy.BrowserWindowTracker?.getTopWindow?.() || null;
    if (!win) {
      return;
    }
    if (typeof win.switchToTabHavingURI === "function") {
      win.switchToTabHavingURI(DRAGON_SETTINGS_URL, true);
    } else if (typeof win.openTrustedLinkIn === "function") {
      win.openTrustedLinkIn(DRAGON_SETTINGS_URL, "tab");
    }
  },
};
