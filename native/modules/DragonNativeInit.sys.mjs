/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DragonSettings } from "resource://dragon/DragonSettings.sys.mjs";
import { DragonAdBlock } from "resource://dragon/DragonAdBlock.sys.mjs";
import { DragonTabSleeper } from "resource://dragon/DragonTabSleeper.sys.mjs";
import { DRAGON_HOME_URL } from "resource://dragon/DragonCoreService.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AboutNewTab: "resource:///modules/AboutNewTab.sys.mjs",
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const LEGACY_EXTENSION_ID = "dragon-core@dragonbrowser.local";
const LEGACY_CLEANED_PREF = "dragon.legacyExtCleaned";

let initialized = false;
let actorRegistered = false;
let startupObserverRegistered = false;

function registerContentActor() {
  if (actorRegistered) {
    return;
  }
  actorRegistered = true;
  try {
    ChromeUtils.registerWindowActor("DragonContent", {
      parent: {
        esModuleURI: "resource://dragon/DragonContentParent.sys.mjs",
      },
      child: {
        esModuleURI: "resource://dragon/DragonContentChild.sys.mjs",
        events: {
          DOMDocElementInserted: { capture: true },
          DOMContentLoaded: { capture: true },
          load: { capture: true },
          hashchange: { capture: true },
        },
      },
      matches: ["http://*/*", "https://*/*"],
      allFrames: true,
    });
  } catch (err) {
    // Already registered or unsupported in current context
    if (!String(err).includes("NS_ERROR_DOM_NOT_SUPPORTED_ERR")) {
      console.error("[Dragon NativeInit] registerWindowActor failed:", err);
    }
  }
}

function applyNewTabOverride() {
  try {
    if (lazy.AboutNewTab && lazy.AboutNewTab.newTabURL !== DRAGON_HOME_URL) {
      lazy.AboutNewTab.newTabURL = DRAGON_HOME_URL;
    }
  } catch (err) {
    console.error("[Dragon NativeInit] AboutNewTab override failed:", err);
  }
}

function migrateLegacyProfilePrefs() {
  try {
    const currentHome = Services.prefs.getStringPref("browser.startup.homepage", "");
    if (!currentHome || currentHome.startsWith("moz-extension://")) {
      Services.prefs.setStringPref("browser.startup.homepage", DRAGON_HOME_URL);
    }
    for (const prefName of [
      "browser.startup.homepage_override.extensionControlled",
      "browser.startup.homepage_override.privateAllowed",
      "browser.newtab.extensionControlled",
      "browser.newtab.privateAllowed",
    ]) {
      if (Services.prefs.prefHasUserValue(prefName)) {
        Services.prefs.clearUserPref(prefName);
      }
    }
    const uiStateRaw = Services.prefs.getStringPref("browser.uiCustomization.state", "");
    if (uiStateRaw && uiStateRaw.includes("dragon-core_dragonbrowser_local-browser-action")) {
      const uiState = JSON.parse(uiStateRaw);
      if (uiState && typeof uiState === "object") {
        if (uiState.placements && typeof uiState.placements === "object") {
          for (const key of Object.keys(uiState.placements)) {
            if (Array.isArray(uiState.placements[key])) {
              uiState.placements[key] = uiState.placements[key].filter(
                (id) => id !== "dragon-core_dragonbrowser_local-browser-action"
              );
            }
          }
        }
        if (Array.isArray(uiState.seen)) {
          uiState.seen = uiState.seen.filter(
            (id) => id !== "dragon-core_dragonbrowser_local-browser-action"
          );
        }
        Services.prefs.setStringPref("browser.uiCustomization.state", JSON.stringify(uiState));
      }
    }
  } catch {}
}

function reconcileOptionalAndLegacyAddons() {
  const needsLegacyCleanup = !Services.prefs.getBoolPref(LEGACY_CLEANED_PREF, false);
  const settings = DragonSettings.getSettings();
  const optedInBuiltins = Array.isArray(settings.enabledOptionalBuiltins)
    ? settings.enabledOptionalBuiltins
    : [];

  // Skip loading AddonManager entirely at startup when already clean and no optional built-ins are opted in
  if (!needsLegacyCleanup && optedInBuiltins.length === 0) {
    return;
  }

  lazy.setTimeout(async () => {
    try {
      if (needsLegacyCleanup) {
        const addon = await lazy.AddonManager.getAddonByID(LEGACY_EXTENSION_ID);
        if (addon && typeof addon.uninstall === "function") {
          await addon.uninstall();
          migrateLegacyProfilePrefs();
          applyNewTabOverride();
        }
        Services.prefs.setBoolPref(LEGACY_CLEANED_PREF, true);
      }
      for (const id of optedInBuiltins) {
        try {
          const existing = await lazy.AddonManager.getAddonByID(id);
          if (!existing) {
            const slug = id === "addons-search-detection@mozilla.com"
              ? "search-detection"
              : id.split("@")[0];
            await lazy.AddonManager.installBuiltinAddon(`resource://builtin-addons/${slug}/`);
          }
        } catch {
          // Ignore individual optional addon errors
        }
      }
    } catch {
      // AddonManager unavailable
    }
  }, 1500);
}

const startupObserver = {
  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),

  observe(_subject, topic) {
    if (topic === "browser-delayed-startup-finished") {
      applyNewTabOverride();
      try {
        Services.obs.removeObserver(startupObserver, "browser-delayed-startup-finished");
      } catch {}
    }
  },
};

export const DragonNativeInit = {
  init() {
    if (initialized) {
      return;
    }
    initialized = true;

    DragonSettings.init();
    DragonAdBlock.init();
    DragonTabSleeper.init();
    registerContentActor();
    migrateLegacyProfilePrefs();
    applyNewTabOverride();

    if (!startupObserverRegistered) {
      startupObserverRegistered = true;
      try {
        Services.obs.addObserver(startupObserver, "browser-delayed-startup-finished");
      } catch {}
    }

    reconcileOptionalAndLegacyAddons();
  },
};
