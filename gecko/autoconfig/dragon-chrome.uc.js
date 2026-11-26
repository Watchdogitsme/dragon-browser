// ============================================================================
// Dragon Browser — Chrome UI Controller (dragon-chrome.uc.js)
// Loaded into chrome://browser/content/browser.xhtml via AutoConfig
// Features:
//   1. Adaptive Zero-Top-Bar Home Mode (dragon-home-mode="true")
//   2. Split-Screen View (Ctrl+Alt+S & #dragon-split-button; native + flex fallback)
//   3. Reader Mode shortcut (Ctrl+Alt+R)
//   4. Quick URL Bar Summon (Ctrl+Shift+L)
//   5. Sleeping Tab Observer (dragon-sleeping="true")
// ============================================================================

(function dragonChromeBootstrap() {
  "use strict";

  if (window.__dragonChromeInitialized) {
    return;
  }
  window.__dragonChromeInitialized = true;

  const ServicesRef = typeof Services !== "undefined" ? Services : null;
  let DragonNativeInit = null;
  let DragonCoreService = null;
  let DRAGON_HOME_URL = "chrome://dragon/content/home/home.html";
  let DRAGON_PRIVATE_HOME_URL = "chrome://dragon/content/home/home.html?private=1";
  let DRAGON_SETTINGS_URL = "chrome://dragon/content/settings/settings.html";

  try {
    if (typeof ChromeUtils !== "undefined" && typeof ChromeUtils.importESModule === "function") {
      ({ DragonNativeInit } = ChromeUtils.importESModule("resource://dragon/DragonNativeInit.sys.mjs"));
      ({
        DragonCoreService,
        DRAGON_HOME_URL,
        DRAGON_PRIVATE_HOME_URL,
        DRAGON_SETTINGS_URL,
      } = ChromeUtils.importESModule("resource://dragon/DragonCoreService.sys.mjs"));
    }
  } catch (err) {
    logError("Failed to import native Dragon modules", err);
  }

  try {
    if (DragonNativeInit && typeof DragonNativeInit.init === "function") {
      DragonNativeInit.init();
    }
  } catch (err) {
    logError("DragonNativeInit.init failed", err);
  }

  try {
    if (Array.isArray(window.gInitialPages)) {
      if (!window.gInitialPages.includes(DRAGON_HOME_URL)) {
        window.gInitialPages.push(DRAGON_HOME_URL);
      }
      if (!window.gInitialPages.includes(DRAGON_PRIVATE_HOME_URL)) {
        window.gInitialPages.push(DRAGON_PRIVATE_HOME_URL);
      }
    }
  } catch (err) {
    logError("Failed to register Dragon gInitialPages", err);
  }

  let initialized = false;

  function logError(context, err) {
    try {
      if (typeof Components !== "undefined" && Components.utils && Components.utils.reportError) {
        Components.utils.reportError("[Dragon Chrome] " + context + ": " + err);
      } else if (typeof console !== "undefined" && console.error) {
        console.error("[Dragon Chrome] " + context + ":", err);
      }
    } catch (_ignored) {}
  }

  function initDragonChrome() {
    if (initialized || !window.gBrowser) {
      return;
    }
    initialized = true;

    const root = document.documentElement;
    const tabContainer = gBrowser.tabContainer;
    const pendingTimers = new Set();
    let activePopover = null;
    let shieldPopoverEl = null;
    let bookmarksPopoverEl = null;
    let historyPopoverEl = null;
    let downloadsPopoverEl = null;
    let shieldBtnEl = null;
    let shieldBadgeEl = null;
    let bookmarksBtnEl = null;
    let historyBtnEl = null;
    let downloadsBtnEl = null;
    let shieldRefreshTimer = null;
    let bookmarksSearchTimer = null;
    let historySearchTimer = null;
    let downloadsRefreshTimer = null;
    let shieldStatsObserver = null;
    let shieldSettingsObserver = null;
    let tabsSleptObserver = null;

    let placesUtilsRef = null;
    let placesUiUtilsRef = null;
    let downloadsModRef = null;
    let downloadsListRef = null;
    let downloadsViewRef = null;
    let bookmarksReqId = 0;
    let historyReqId = 0;
    let downloadsReqId = 0;

    const splitState = {
      active: false,
      nativeActive: false,
      leftTab: null,
      rightTab: null,
      focusedSide: "left",
      ratioPercent: 50,
      resizerEl: null,
      paneCleanups: [],
      dragCleanup: null,
    };

    function scheduleTimer(fn, delayMs) {
      const id = window.setTimeout(() => {
        pendingTimers.delete(id);
        try {
          fn();
        } catch (err) {
          logError("Scheduled task error", err);
        }
      }, delayMs);
      pendingTimers.add(id);
      return id;
    }

    // ------------------------------------------------------------------------
    // 1. Adaptive Zero-Top-Bar Home Mode
    // ------------------------------------------------------------------------

    function getActiveVisibleTabs() {
      try {
        const rawTabs = gBrowser.visibleTabs || Array.from(gBrowser.tabs || []);
        return Array.from(rawTabs).filter((tab) => tab && !tab.closing && !tab.hidden);
      } catch (_err) {
        return [];
      }
    }

    function getTabURI(tab) {
      if (!tab) {
        return "";
      }
      try {
        const browser =
          (typeof gBrowser.getBrowserForTab === "function" && gBrowser.getBrowserForTab(tab)) ||
          tab.linkedBrowser;
        if (!browser) {
          return "";
        }
        const directSpec =
          (browser.currentURI && browser.currentURI.spec) ||
          (browser.documentURI && browser.documentURI.spec) ||
          "";
        if (directSpec && directSpec.trim().toLowerCase() !== "about:blank") {
          return directSpec;
        }
        if (typeof browser.userTypedValue === "string" && browser.userTypedValue.length > 0) {
          return browser.userTypedValue;
        }
        if (
          tab === gBrowser.selectedTab &&
          window.gURLBar &&
          typeof window.gURLBar.value === "string" &&
          isDragonHomeURI(window.gURLBar.value)
        ) {
          return window.gURLBar.value;
        }
        return directSpec;
      } catch (_err) {
        return "";
      }
    }

    function isDragonHomeURI(uriSpec) {
      if (!uriSpec || typeof uriSpec !== "string") {
        return false;
      }
      const lower = uriSpec.trim().toLowerCase();
      if (
        lower === "about:home" ||
        lower === "about:newtab" ||
        lower === "about:privatebrowsing" ||
        lower.startsWith("about:home?") ||
        lower.startsWith("about:home#") ||
        lower.startsWith("about:newtab?") ||
        lower.startsWith("about:newtab#") ||
        lower.startsWith("about:privatebrowsing?") ||
        lower.startsWith("about:privatebrowsing#")
      ) {
        return true;
      }
      if (lower.startsWith("chrome://dragon/content/home/home.html")) {
        const pathOnly = lower.split(/[?#]/)[0];
        return pathOnly === "chrome://dragon/content/home/home.html";
      }
      return false;
    }

    const privateRedirectTimestamps = new WeakMap();

    function maybeRedirectPrivateHome(browser, uriSpec) {
      try {
        if (root.getAttribute("privatebrowsingmode") !== "temporary" || !browser) {
          return false;
        }
        const spec = typeof uriSpec === "string" ? uriSpec.trim().toLowerCase() : "";
        if (!spec.startsWith("about:privatebrowsing")) {
          return false;
        }
        const now = Date.now();
        const prev = privateRedirectTimestamps.get(browser) || 0;
        if (now - prev < 500) {
          return false;
        }
        const homeUrl = DRAGON_PRIVATE_HOME_URL;
        if (!homeUrl || !ServicesRef || !ServicesRef.io) {
          return false;
        }
        privateRedirectTimestamps.set(browser, now);

        const CiRef = typeof Ci !== "undefined" ? Ci : (typeof Components !== "undefined" ? Components.interfaces : null);
        const loadFlags =
          CiRef && CiRef.nsIWebNavigation ? CiRef.nsIWebNavigation.LOAD_FLAGS_REPLACE_HISTORY : 0;
        const principal = ServicesRef.scriptSecurityManager
          ? ServicesRef.scriptSecurityManager.getSystemPrincipal()
          : undefined;

        if (typeof browser.loadURI === "function") {
          browser.loadURI(ServicesRef.io.newURI(homeUrl), {
            triggeringPrincipal: principal,
            loadFlags,
          });
          return true;
        }
      } catch (err) {
        logError("maybeRedirectPrivateHome failed", err);
      }
      return false;
    }

    function getActiveNativeSplitView() {
      try {
        if (
          gBrowser.activeSplitView &&
          gBrowser.selectedTab &&
          gBrowser.selectedTab.splitview === gBrowser.activeSplitView
        ) {
          return gBrowser.activeSplitView;
        }
        if (gBrowser.selectedTab && gBrowser.selectedTab.splitview) {
          return gBrowser.selectedTab.splitview;
        }
      } catch (_err) {}
      return null;
    }

    function isSplitViewActive() {
      if (splitState.active) {
        return true;
      }
      return Boolean(getActiveNativeSplitView());
    }

    let homeModeReady = false;
    let extFlipAnim = null;

    function clearExtMorphState(extBtn) {
      extFlipAnim = null;
      if (extBtn) {
        extBtn.removeAttribute("dragon-ext-morphing");
      }
    }

    function animateExtensionsMorph(toHomeMode, firstRect) {
      try {
        const extBtn = document.getElementById("unified-extensions-button");
        if (
          !extBtn ||
          extBtn.hidden ||
          !firstRect ||
          firstRect.width < 4 ||
          firstRect.height < 4 ||
          typeof extBtn.animate !== "function"
        ) {
          return;
        }
        if (
          typeof window.matchMedia === "function" &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ) {
          return;
        }
        const lastRect = extBtn.getBoundingClientRect();
        if (!lastRect || lastRect.width < 4 || lastRect.height < 4) {
          return;
        }
        const firstCx = firstRect.left + firstRect.width / 2;
        const firstCy = firstRect.top + firstRect.height / 2;
        const lastCx = lastRect.left + lastRect.width / 2;
        const lastCy = lastRect.top + lastRect.height / 2;
        const dx = firstCx - lastCx;
        const dy = firstCy - lastCy;
        if (Math.hypot(dx, dy) < 2) {
          return;
        }
        const rawScale = Math.sqrt(
          (firstRect.width * firstRect.height) / (lastRect.width * lastRect.height)
        );
        const scale = Math.max(0.68, Math.min(1.42, rawScale));

        extBtn.setAttribute("dragon-ext-morphing", "true");
        const fromTransform =
          "translate(" + dx.toFixed(1) + "px, " + dy.toFixed(1) + "px) scale(" + scale.toFixed(3) + ")";
        const keyframes = !toHomeMode
          ? [
              {
                transform: fromTransform,
                borderRadius: "999px",
                borderLeftColor: "var(--dragon-border)",
                opacity: 0.94,
              },
              {
                transform: "translate(0px, 0px) scale(1)",
                borderRadius: "0 999px 999px 0",
                borderLeftColor: "transparent",
                opacity: 1,
              },
            ]
          : [
              {
                transform: fromTransform,
                opacity: 0.94,
              },
              {
                transform: "translate(0px, 0px) scale(1)",
                opacity: 1,
              },
            ];

        extFlipAnim = extBtn.animate(keyframes, {
          duration: 320,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          fill: "none",
        });
        const cleanup = () => clearExtMorphState(extBtn);
        extFlipAnim.onfinish = cleanup;
        extFlipAnim.oncancel = cleanup;
      } catch (err) {
        logError("animateExtensionsMorph failed", err);
      }
    }

    function updateHomeMode(overrideUriSpec) {
      try {
        const visibleTabs = getActiveVisibleTabs();
        const activeTab = gBrowser.selectedTab || visibleTabs[0];
        const uriSpec =
          typeof overrideUriSpec === "string" && overrideUriSpec.length > 0
            ? overrideUriSpec
            : getTabURI(activeTab);
        const nextHomeMode =
          visibleTabs.length === 1 && !isSplitViewActive() && isDragonHomeURI(uriSpec);
        const wasHomeMode = root.getAttribute("dragon-home-mode") === "true";

        let firstRect = null;
        if (homeModeReady && wasHomeMode !== nextHomeMode) {
          const extBtn = document.getElementById("unified-extensions-button");
          if (extBtn && !extBtn.hidden) {
            firstRect = extBtn.getBoundingClientRect();
          }
          if (extFlipAnim) {
            try {
              extFlipAnim.cancel();
            } catch (_cancelErr) {}
            clearExtMorphState(extBtn);
          }
        }

        if (nextHomeMode) {
          root.setAttribute("dragon-home-mode", "true");
          if (root.getAttribute("dragon-urlbar-summoned") !== "true") {
            const barInput = document.getElementById("urlbar-input");
            if (barInput && document.activeElement === barInput) {
              barInput.blur();
              if (gBrowser.selectedBrowser && typeof gBrowser.selectedBrowser.focus === "function") {
                gBrowser.selectedBrowser.focus();
              }
            }
          }
        } else {
          root.removeAttribute("dragon-home-mode");
          root.removeAttribute("dragon-urlbar-summoned");
        }

        if (homeModeReady && wasHomeMode !== nextHomeMode && firstRect) {
          animateExtensionsMorph(nextHomeMode, firstRect);
        }
      } catch (err) {
        logError("updateHomeMode failed", err);
      }
    }

    // ------------------------------------------------------------------------
    // 2. Sleeping Tab Observer
    // ------------------------------------------------------------------------

    function isTabSleeping(tab) {
      if (!tab || tab.selected || tab.closing) {
        return false;
      }
      try {
        const isDiscarded = Boolean(tab.discarded);
        const isPending = tab.hasAttribute("pending");
        const browserDisconnected = Boolean(tab.linkedBrowser && !tab.linkedBrowser.isConnected);
        return isDiscarded || isPending || browserDisconnected;
      } catch (_err) {
        return false;
      }
    }

    function syncTabSleepingState(tab) {
      if (!tab) {
        return;
      }
      try {
        if (isTabSleeping(tab)) {
          if (tab.getAttribute("dragon-sleeping") !== "true") {
            tab.setAttribute("dragon-sleeping", "true");
          }
        } else if (tab.hasAttribute("dragon-sleeping")) {
          tab.removeAttribute("dragon-sleeping");
        }
      } catch (_err) {}
    }

    function syncAllSleepingTabs() {
      try {
        const tabs = Array.from(gBrowser.tabs || []);
        let sleepingCount = 0;
        for (const tab of tabs) {
          syncTabSleepingState(tab);
          if (isTabSleeping(tab)) {
            sleepingCount += 1;
          }
        }
        const sleepLabel = document.getElementById("dragon-dock-sleep-label");
        if (sleepLabel) {
          sleepLabel.textContent = sleepingCount > 0 ? sleepingCount + " sleeping" : "Sleep";
        }
      } catch (err) {
        logError("syncAllSleepingTabs failed", err);
      }
    }

    // ------------------------------------------------------------------------
    // 3. Split-Screen View (Native API + Dual-Pane Flex Fallback)
    // ------------------------------------------------------------------------

    function syncNativeSplitViewState() {
      const nativeSplit = getActiveNativeSplitView();
      splitState.nativeActive = Boolean(nativeSplit);
      if (!splitState.active) {
        if (splitState.nativeActive) {
          root.removeAttribute("dragon-home-mode");
          root.removeAttribute("dragon-urlbar-summoned");
          root.setAttribute("dragon-split-active", "true");
          root.setAttribute("dragon-split-mode", "native");
        } else {
          root.removeAttribute("dragon-split-active");
          root.removeAttribute("dragon-split-mode");
        }
      }
      updateSplitButtonState();
    }

    function updateSplitButtonState() {
      const btn = document.getElementById("dragon-split-button");
      if (!btn) {
        return;
      }
      const active = isSplitViewActive();
      if (active) {
        btn.setAttribute("dragon-active", "true");
        btn.setAttribute("checked", "true");
        btn.setAttribute("aria-pressed", "true");
      } else {
        btn.removeAttribute("dragon-active");
        btn.removeAttribute("checked");
        btn.setAttribute("aria-pressed", "false");
      }
    }

    function getPanelForTab(tab) {
      if (!tab || !tab.linkedPanel) {
        return null;
      }
      return document.getElementById(tab.linkedPanel);
    }

    function setBrowserActive(tab, active) {
      if (!tab || !tab.linkedBrowser) {
        return;
      }
      try {
        const browser = tab.linkedBrowser;
        if ("docShellIsActive" in browser) {
          browser.docShellIsActive = active;
        }
        if (typeof browser.preserveLayers === "function") {
          browser.preserveLayers(active);
        }
      } catch (_err) {}
    }

    function wakeTabIfDiscarded(tab) {
      if (!tab) {
        return;
      }
      try {
        if (tab.discarded || tab.hasAttribute("pending")) {
          const prevTab = gBrowser.selectedTab;
          gBrowser.selectedTab = tab;
          if (prevTab && prevTab !== tab) {
            scheduleTimer(() => {
              if (splitState.active && prevTab && !prevTab.closing) {
                gBrowser.selectedTab = prevTab;
                keepSplitPanesAlive();
              }
            }, 60);
          }
        }
      } catch (_err) {}
    }

    function keepSplitPanesAlive() {
      if (!splitState.active) {
        return;
      }
      setBrowserActive(splitState.leftTab, true);
      setBrowserActive(splitState.rightTab, true);
    }

    function applySplitRatio(percent) {
      const clamped = Math.max(20, Math.min(80, percent));
      splitState.ratioPercent = clamped;
      const tabpanels = document.getElementById("tabbrowser-tabpanels");
      const tabbox = document.getElementById("tabbrowser-tabbox");
      if (tabpanels) {
        tabpanels.style.setProperty("--dragon-split-left", String(clamped));
        tabpanels.style.setProperty("--dragon-split-right", String(100 - clamped));
      }
      if (tabbox) {
        tabbox.style.setProperty("--dragon-split-left", String(clamped));
      }
    }

    function updateFocusedPaneAttributes() {
      if (!splitState.active) {
        return;
      }
      const leftPanel = getPanelForTab(splitState.leftTab);
      const rightPanel = getPanelForTab(splitState.rightTab);
      if (leftPanel) {
        if (splitState.focusedSide === "left") {
          leftPanel.setAttribute("dragon-split-focused", "true");
        } else {
          leftPanel.removeAttribute("dragon-split-focused");
        }
      }
      if (rightPanel) {
        if (splitState.focusedSide === "right") {
          rightPanel.setAttribute("dragon-split-focused", "true");
        } else {
          rightPanel.removeAttribute("dragon-split-focused");
        }
      }
    }

    function attachPaneFocusListeners() {
      clearPaneFocusListeners();
      const pairs = [
        { side: "left", tab: splitState.leftTab },
        { side: "right", tab: splitState.rightTab },
      ];
      for (const pair of pairs) {
        const panel = getPanelForTab(pair.tab);
        if (!panel) {
          continue;
        }
        const onPointerDown = () => {
          if (!splitState.active) {
            return;
          }
          splitState.focusedSide = pair.side;
          if (pair.tab && !pair.tab.closing && gBrowser.selectedTab !== pair.tab) {
            gBrowser.selectedTab = pair.tab;
          }
          updateFocusedPaneAttributes();
          scheduleTimer(keepSplitPanesAlive, 0);
        };
        panel.addEventListener("pointerdown", onPointerDown, true);
        splitState.paneCleanups.push(() => {
          try {
            panel.removeEventListener("pointerdown", onPointerDown, true);
          } catch (_err) {}
        });
      }
    }

    function clearPaneFocusListeners() {
      while (splitState.paneCleanups.length > 0) {
        const cleanupFn = splitState.paneCleanups.pop();
        try {
          cleanupFn();
        } catch (_err) {}
      }
    }

    function findOrCreateSecondaryTab(primaryTab, forNative) {
      const visibleTabs = getActiveVisibleTabs();
      const candidates = visibleTabs.filter(
        (t) =>
          t !== primaryTab &&
          !t.closing &&
          !t.hidden &&
          (!forNative || (!t.pinned && !t.splitview))
      );

      if (candidates.length > 0) {
        const isLive = (t) => !t.discarded && !t.hasAttribute("pending");
        const idx = visibleTabs.indexOf(primaryTab);
        const adjacent = [];
        if (idx >= 0 && idx + 1 < visibleTabs.length) {
          adjacent.push(visibleTabs[idx + 1]);
        }
        if (idx > 0) {
          adjacent.push(visibleTabs[idx - 1]);
        }
        for (const adj of adjacent) {
          if (candidates.includes(adj) && isLive(adj)) {
            return { tab: adj, created: false };
          }
        }
        const firstLive = candidates.find(isLive);
        if (firstLive) {
          return { tab: firstLive, created: false };
        }
        for (const adj of adjacent) {
          if (candidates.includes(adj)) {
            return { tab: adj, created: false };
          }
        }
        return { tab: candidates[0], created: false };
      }

      const targetUrl =
        root.getAttribute("privatebrowsingmode") === "temporary"
          ? DRAGON_PRIVATE_HOME_URL
          : DRAGON_HOME_URL;

      try {
        if (typeof gBrowser.addTrustedTab === "function") {
          const tab = gBrowser.addTrustedTab(targetUrl, { inBackground: false });
          if (tab) {
            return { tab, created: true };
          }
        }
        const principal =
          ServicesRef && ServicesRef.scriptSecurityManager
            ? ServicesRef.scriptSecurityManager.getSystemPrincipal()
            : undefined;
        const tab = gBrowser.addTab(targetUrl, {
          triggeringPrincipal: principal,
          inBackground: false,
        });
        return tab ? { tab, created: true } : null;
      } catch (_err) {
        return null;
      }
    }

    function mountSplitResizer(tabbox) {
      const existing = document.getElementById("dragon-split-resizer");
      if (existing) {
        existing.remove();
      }

      const resizer = document.createElement("div");
      resizer.id = "dragon-split-resizer";
      resizer.setAttribute("role", "separator");
      resizer.setAttribute("aria-orientation", "vertical");
      resizer.setAttribute("title", "Drag to resize split panes (double-click to reset)");

      let dragging = false;
      let activePointerId = null;

      const onPointerMove = (evt) => {
        if (!dragging || !splitState.active) {
          return;
        }
        const rect = tabbox.getBoundingClientRect();
        if (rect.width <= 0) {
          return;
        }
        const pct = ((evt.clientX - rect.left) / rect.width) * 100;
        applySplitRatio(pct);
      };

      const onPointerUp = () => {
        if (!dragging) {
          return;
        }
        dragging = false;
        resizer.removeAttribute("dragging");
        if (activePointerId !== null && typeof resizer.releasePointerCapture === "function") {
          try {
            resizer.releasePointerCapture(activePointerId);
          } catch (_capErr) {}
        }
        activePointerId = null;
        window.removeEventListener("pointermove", onPointerMove, true);
        window.removeEventListener("pointerup", onPointerUp, true);
        window.removeEventListener("pointercancel", onPointerUp, true);
      };

      const onPointerDown = (evt) => {
        if (evt.button !== 0) {
          return;
        }
        evt.preventDefault();
        evt.stopPropagation();
        dragging = true;
        activePointerId = evt.pointerId;
        resizer.setAttribute("dragging", "true");
        if (typeof resizer.setPointerCapture === "function") {
          try {
            resizer.setPointerCapture(evt.pointerId);
          } catch (_capErr) {}
        }
        window.addEventListener("pointermove", onPointerMove, true);
        window.addEventListener("pointerup", onPointerUp, true);
        window.addEventListener("pointercancel", onPointerUp, true);
      };

      const onDblClick = (evt) => {
        evt.preventDefault();
        applySplitRatio(50);
      };

      resizer.addEventListener("pointerdown", onPointerDown);
      resizer.addEventListener("dblclick", onDblClick);
      tabbox.appendChild(resizer);

      splitState.resizerEl = resizer;
      splitState.dragCleanup = () => {
        onPointerUp();
        try {
          resizer.removeEventListener("pointerdown", onPointerDown);
          resizer.removeEventListener("dblclick", onDblClick);
          resizer.remove();
        } catch (_err) {}
        splitState.resizerEl = null;
      };
    }

    function clearFlexSplitAttributes() {
      const tabpanels = document.getElementById("tabbrowser-tabpanels");
      const tabbox = document.getElementById("tabbrowser-tabbox");
      if (tabpanels) {
        const markedPanels = tabpanels.querySelectorAll("[dragon-split-pane], [dragon-split-focused]");
        for (const panel of markedPanels) {
          panel.removeAttribute("dragon-split-pane");
          panel.removeAttribute("dragon-split-focused");
        }
        tabpanels.style.removeProperty("--dragon-split-left");
        tabpanels.style.removeProperty("--dragon-split-right");
      }
      if (tabbox) {
        tabbox.style.removeProperty("--dragon-split-left");
      }
    }

    function applyFlexSplitPanels() {
      const leftPanel = getPanelForTab(splitState.leftTab);
      const rightPanel = getPanelForTab(splitState.rightTab);
      if (!leftPanel || !rightPanel || leftPanel === rightPanel) {
        return false;
      }
      clearFlexSplitAttributes();
      leftPanel.setAttribute("dragon-split-pane", "left");
      rightPanel.setAttribute("dragon-split-pane", "right");
      applySplitRatio(splitState.ratioPercent);
      updateFocusedPaneAttributes();
      attachPaneFocusListeners();
      wakeTabIfDiscarded(splitState.leftTab);
      wakeTabIfDiscarded(splitState.rightTab);
      keepSplitPanesAlive();
      scheduleTimer(keepSplitPanesAlive, 50);
      return true;
    }

    function activateFlexSplitView() {
      const primaryTab = gBrowser.selectedTab;
      if (!primaryTab) {
        return false;
      }
      const found = findOrCreateSecondaryTab(primaryTab, false);
      const secondaryTab = found && found.tab;
      if (!secondaryTab || secondaryTab === primaryTab) {
        return false;
      }
      try {
        if (typeof gBrowser._insertBrowser === "function") {
          gBrowser._insertBrowser(secondaryTab);
        }
      } catch (_insertErr) {}
      const tabbox = document.getElementById("tabbrowser-tabbox");
      const tabpanels = document.getElementById("tabbrowser-tabpanels");
      if (!tabbox || !tabpanels) {
        return false;
      }

      splitState.active = true;
      splitState.leftTab = primaryTab;
      splitState.rightTab = secondaryTab;
      splitState.focusedSide = found.created ? "right" : "left";
      splitState.ratioPercent = 50;

      root.removeAttribute("dragon-home-mode");
      root.removeAttribute("dragon-urlbar-summoned");
      root.setAttribute("dragon-split-active", "true");
      root.setAttribute("dragon-split-mode", "flex");

      if (!applyFlexSplitPanels()) {
        deactivateFlexSplitView();
        return false;
      }

      mountSplitResizer(tabbox);
      updateSplitButtonState();
      return true;
    }

    function deactivateFlexSplitView() {
      const prevLeft = splitState.leftTab;
      const prevRight = splitState.rightTab;

      splitState.active = false;
      splitState.leftTab = null;
      splitState.rightTab = null;
      splitState.focusedSide = "left";

      clearPaneFocusListeners();
      if (typeof splitState.dragCleanup === "function") {
        splitState.dragCleanup();
        splitState.dragCleanup = null;
      }
      clearFlexSplitAttributes();
      root.removeAttribute("dragon-split-active");
      root.removeAttribute("dragon-split-mode");

      const currentTab = gBrowser.selectedTab;
      if (prevLeft && prevLeft !== currentTab && !prevLeft.closing) {
        setBrowserActive(prevLeft, false);
      }
      if (prevRight && prevRight !== currentTab && !prevRight.closing) {
        setBrowserActive(prevRight, false);
      }

      syncNativeSplitViewState();
      updateHomeMode();
    }

    function tryNativeSplitViewToggle() {
      if (typeof gBrowser.addTabSplitView !== "function") {
        return false;
      }

      try {
        const activeTab = gBrowser.selectedTab;
        if (!activeTab) {
          return false;
        }

        const existingSplit = getActiveNativeSplitView();
        if (existingSplit) {
          if (typeof existingSplit.unsplitTabs === "function") {
            existingSplit.unsplitTabs("icon_separate");
          }
          splitState.nativeActive = false;
          root.removeAttribute("dragon-split-active");
          root.removeAttribute("dragon-split-mode");
          updateSplitButtonState();
          scheduleTimer(() => {
            syncNativeSplitViewState();
            updateHomeMode();
          }, 0);
          return true;
        }

        if (activeTab.pinned) {
          return false;
        }

        const found = findOrCreateSecondaryTab(activeTab, true);
        if (!found || !found.tab || found.tab === activeTab) {
          return false;
        }

        const secondaryTab = found.tab;
        const wasDiscarded = Boolean(secondaryTab.discarded || secondaryTab.hasAttribute("pending"));
        if (wasDiscarded && typeof gBrowser._insertBrowser === "function") {
          gBrowser._insertBrowser(secondaryTab);
        }

        const splitView = gBrowser.addTabSplitView([activeTab, secondaryTab], {
          insertBefore: activeTab,
        });
        if (!splitView || !splitView.tabs || splitView.tabs.length < 2) {
          if (splitView && typeof splitView.unsplitTabs === "function") {
            splitView.unsplitTabs("icon_separate");
          }
          return false;
        }

        if (found.created) {
          gBrowser.selectedTab = secondaryTab;
        } else if (wasDiscarded) {
          gBrowser.selectedTab = secondaryTab;
          scheduleTimer(() => {
            if (activeTab && !activeTab.closing && getActiveNativeSplitView()) {
              gBrowser.selectedTab = activeTab;
            }
          }, 40);
        }

        syncNativeSplitViewState();
        updateHomeMode();
        return true;
      } catch (err) {
        logError("Native Split View unavailable or rejected, falling back to flex dual-pane", err);
        splitState.nativeActive = false;
        return false;
      }
    }

    function toggleSplitView() {
      if (splitState.active) {
        deactivateFlexSplitView();
        return;
      }
      if (tryNativeSplitViewToggle()) {
        return;
      }
      activateFlexSplitView();
    }

    const XHTML_NS = "http://www.w3.org/1999/xhtml";
    const SVG_NS = "http://www.w3.org/2000/svg";
    let dockEl = null;
    let dockToggleBtn = null;
    let dockPanelEl = null;
    let onDockDocClick = null;

    function createHtmlEl(tag, attrs) {
      const el = document.createElementNS(XHTML_NS, tag);
      if (attrs) {
        for (const [key, val] of Object.entries(attrs)) {
          if (val !== undefined && val !== null) {
            el.setAttribute(key, String(val));
          }
        }
      }
      return el;
    }

    function createSvgEl(viewBox, shapes, className, strokeWidth) {
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("viewBox", viewBox);
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", strokeWidth || "1.6");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("class", className || "dragon-dock-icon");
      for (const spec of shapes) {
        const node = document.createElementNS(SVG_NS, spec.tag);
        for (const [key, val] of Object.entries(spec)) {
          if (key !== "tag") {
            node.setAttribute(key, String(val));
          }
        }
        svg.appendChild(node);
      }
      return svg;
    }

    function isDockExpanded() {
      return Boolean(dockEl && dockEl.getAttribute("data-expanded") === "true");
    }

    function setDockExpanded(expanded) {
      if (!dockEl || !dockToggleBtn || !dockPanelEl) {
        return;
      }
      if (expanded) {
        dockEl.setAttribute("data-expanded", "true");
      } else {
        dockEl.removeAttribute("data-expanded");
      }
      dockToggleBtn.setAttribute("aria-expanded", String(Boolean(expanded)));
      dockPanelEl.setAttribute("aria-hidden", String(!expanded));
    }

    function toggleBrowserSidebar(commandId) {
      try {
        if (typeof SidebarController !== "undefined" && typeof SidebarController.toggle === "function") {
          SidebarController.toggle(commandId);
          return;
        }
        if (typeof SidebarUI !== "undefined" && typeof SidebarUI.toggle === "function") {
          SidebarUI.toggle(commandId);
        }
      } catch (err) {
        logError("toggleBrowserSidebar(" + commandId + ") failed", err);
      }
    }

    function sleepEligibleInactiveTabs() {
      try {
        if (DragonCoreService && typeof DragonCoreService.sleepInactiveNow === "function") {
          DragonCoreService.sleepInactiveNow();
        } else {
          const tabs = Array.from(gBrowser.tabs || []);
          for (const tab of tabs) {
            if (
              tab &&
              !tab.selected &&
              !tab.pinned &&
              !tab.closing &&
              !tab.soundPlaying &&
              !isTabSleeping(tab) &&
              typeof gBrowser.discardBrowser === "function"
            ) {
              try {
                gBrowser.discardBrowser(tab);
              } catch (_discardErr) {}
            }
          }
        }
        scheduleTimer(syncAllSleepingTabs, 50);
        scheduleShieldRefresh(60);
      } catch (err) {
        logError("sleepEligibleInactiveTabs failed", err);
      }
    }

    function openDownloadsView() {
      try {
        if (typeof switchToTabHavingURI === "function") {
          switchToTabHavingURI("about:downloads", true);
        } else if (typeof BrowserDownloadsUI === "function") {
          BrowserDownloadsUI();
        } else if (typeof openTrustedLinkIn === "function") {
          openTrustedLinkIn("about:downloads", "tab");
        }
      } catch (err) {
        logError("openDownloadsView failed", err);
      }
    }

    function openPrivateBrowserWindow() {
      try {
        if (typeof OpenBrowserWindow === "function") {
          OpenBrowserWindow({ private: true });
        }
      } catch (err) {
        logError("openPrivateBrowserWindow failed", err);
      }
    }

    function openDragonSettingsTab() {
      try {
        if (DragonCoreService && typeof DragonCoreService.openSettingsTab === "function") {
          DragonCoreService.openSettingsTab(window);
          return;
        }
        if (typeof switchToTabHavingURI === "function") {
          switchToTabHavingURI(DRAGON_SETTINGS_URL, true);
        } else if (typeof openTrustedLinkIn === "function") {
          openTrustedLinkIn(DRAGON_SETTINGS_URL, "tab");
        }
      } catch (err) {
        logError("openDragonSettingsTab failed", err);
      }
    }

    const shieldUi = {
      currentDomain: "",
      domainEl: null,
      statusPillEl: null,
      tabBlockedEl: null,
      totalBlockedEl: null,
      sleepingEl: null,
      adblockBtn: null,
      adblockStateEl: null,
      allowlistBtn: null,
      allowlistStateEl: null,
      darkBtn: null,
      darkStateEl: null,
      darkSiteBtn: null,
      darkSiteStateEl: null,
    };

    const bookmarksUi = {
      countPillEl: null,
      subtitleEl: null,
      searchEl: null,
      listEl: null,
      togglePageBtn: null,
      activePageUrl: "",
      activeBookmarkGuid: null,
    };

    const historyUi = {
      countPillEl: null,
      subtitleEl: null,
      searchEl: null,
      listEl: null,
    };

    const downloadsUi = {
      countPillEl: null,
      subtitleEl: null,
      listEl: null,
      clearBtn: null,
    };

    function getPlacesUtils() {
      if (!placesUtilsRef) {
        try {
          if (typeof PlacesUtils !== "undefined") {
            placesUtilsRef = PlacesUtils;
          } else if (typeof ChromeUtils !== "undefined" && typeof ChromeUtils.importESModule === "function") {
            ({ PlacesUtils: placesUtilsRef } = ChromeUtils.importESModule(
              "resource://gre/modules/PlacesUtils.sys.mjs"
            ));
          }
        } catch (err) {
          logError("Failed to load PlacesUtils", err);
        }
      }
      return placesUtilsRef;
    }

    function getPlacesUIUtils() {
      if (!placesUiUtilsRef) {
        try {
          if (typeof PlacesUIUtils !== "undefined") {
            placesUiUtilsRef = PlacesUIUtils;
          } else if (typeof ChromeUtils !== "undefined" && typeof ChromeUtils.importESModule === "function") {
            ({ PlacesUIUtils: placesUiUtilsRef } = ChromeUtils.importESModule(
              "moz-src:///browser/components/places/PlacesUIUtils.sys.mjs"
            ));
          }
        } catch (_err) {
          try {
            ({ PlacesUIUtils: placesUiUtilsRef } = ChromeUtils.importESModule(
              "resource:///modules/PlacesUIUtils.sys.mjs"
            ));
          } catch (_err2) {}
        }
      }
      return placesUiUtilsRef;
    }

    function getDownloadsModule() {
      if (!downloadsModRef) {
        try {
          if (typeof ChromeUtils !== "undefined" && typeof ChromeUtils.importESModule === "function") {
            ({ Downloads: downloadsModRef } = ChromeUtils.importESModule(
              "resource://gre/modules/Downloads.sys.mjs"
            ));
          }
        } catch (err) {
          logError("Failed to load Downloads module", err);
        }
      }
      return downloadsModRef;
    }

    function formatHostname(urlStr) {
      if (!urlStr || typeof urlStr !== "string") {
        return "";
      }
      try {
        const parsed = new URL(urlStr);
        if (parsed.protocol === "file:") {
          return "Local file";
        }
        return (parsed.hostname || parsed.protocol.replace(":", "")).replace(/^www\./i, "");
      } catch (_err) {
        return urlStr;
      }
    }

    function formatRelativeTime(timestampMs) {
      if (!timestampMs || !Number.isFinite(timestampMs)) {
        return "";
      }
      const diffMs = Date.now() - timestampMs;
      if (diffMs < 60000) {
        return "Just now";
      }
      const mins = Math.floor(diffMs / 60000);
      if (mins < 60) {
        return mins + "m ago";
      }
      const hours = Math.floor(mins / 60);
      if (hours < 24) {
        return hours + "h ago";
      }
      const days = Math.floor(hours / 24);
      if (days === 1) {
        return "Yesterday";
      }
      if (days < 7) {
        return days + "d ago";
      }
      try {
        return new Date(timestampMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      } catch (_err) {
        return "";
      }
    }

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) {
        return "";
      }
      if (bytes === 0) {
        return "0 B";
      }
      const units = ["B", "KB", "MB", "GB", "TB"];
      let idx = 0;
      let val = bytes;
      while (val >= 1024 && idx < units.length - 1) {
        val /= 1024;
        idx += 1;
      }
      return (val >= 10 || idx === 0 ? val.toFixed(0) : val.toFixed(1)) + " " + units[idx];
    }

    function normalizeBookmarkUrl(item) {
      if (!item || !item.url) {
        return "";
      }
      if (typeof item.url === "string") {
        return item.url;
      }
      if (typeof item.url.href === "string") {
        return item.url.href;
      }
      return String(item.url);
    }

    function createFaviconBadge(urlStr, fallbackText) {
      const box = createHtmlEl("span", { class: "dragon-pop-icon-box" });
      const letter = createHtmlEl("span", { class: "dragon-pop-icon-fallback" });
      const host = formatHostname(urlStr);
      letter.textContent = (fallbackText || (host ? host[0] : "•")).toUpperCase();
      box.appendChild(letter);

      if (typeof urlStr === "string" && /^https?:\/\//i.test(urlStr)) {
        const img = createHtmlEl("img", {
          class: "dragon-pop-favicon",
          alt: "",
          loading: "lazy",
          src: "page-icon:" + urlStr,
        });
        letter.setAttribute("hidden", "true");
        img.addEventListener("error", () => {
          img.setAttribute("hidden", "true");
          letter.removeAttribute("hidden");
        });
        box.appendChild(img);
      }
      return box;
    }

    function createPopoverShell(opts) {
      const existing = document.getElementById(opts.id);
      if (existing) {
        existing.remove();
      }
      const section = createHtmlEl("section", {
        id: opts.id,
        class: "dragon-popover",
        role: "dialog",
        "aria-label": opts.ariaLabel || opts.title,
        hidden: "true",
      });
      section.addEventListener("click", (evt) => {
        evt.stopPropagation();
      });

      const header = createHtmlEl("div", { class: "dragon-sp-header" });
      const titleGroup = createHtmlEl("div", { class: "dragon-sp-title-group" });
      const titleRow = createHtmlEl("div", { class: "dragon-sp-title-row" });
      const titleEl = createHtmlEl("span", { class: "dragon-sp-title" });
      titleEl.textContent = opts.title;
      const pillEl = createHtmlEl("span", {
        id: opts.pillId,
        class: "dragon-sp-pill",
        "data-state": opts.pillState || "neutral",
      });
      pillEl.textContent = opts.pillText;
      titleRow.appendChild(titleEl);
      titleRow.appendChild(pillEl);

      const subtitleEl = createHtmlEl("div", {
        id: opts.subtitleId,
        class: "dragon-sp-domain",
      });
      subtitleEl.textContent = opts.subtitleText;
      titleGroup.appendChild(titleRow);
      titleGroup.appendChild(subtitleEl);

      const closeBtn = createHtmlEl("button", {
        type: "button",
        id: opts.closeId,
        class: "dragon-sp-close",
        "aria-label": "Close " + opts.title,
      });
      closeBtn.textContent = "\u00D7";
      closeBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        setActivePopover(null);
      });

      header.appendChild(titleGroup);
      header.appendChild(closeBtn);
      section.appendChild(header);

      return { section, pillEl, subtitleEl };
    }

    function openPopoverUrl(url, forceNewTab) {
      if (!url || typeof url !== "string") {
        return;
      }
      try {
        const useCurrent = !forceNewTab && isDragonHomeURI(getTabURI(gBrowser.selectedTab));
        const where = useCurrent ? "current" : "tab";
        if (typeof window.openWebLinkIn === "function") {
          window.openWebLinkIn(url, where, { relatedToCurrent: true });
          return;
        }
        if (typeof window.openTrustedLinkIn === "function") {
          window.openTrustedLinkIn(url, where);
          return;
        }
        if (!useCurrent && DragonCoreService && typeof DragonCoreService.navigateFromPage === "function") {
          DragonCoreService.navigateFromPage(window, url, true);
          return;
        }
        const principal =
          ServicesRef && ServicesRef.scriptSecurityManager
            ? ServicesRef.scriptSecurityManager.getNullPrincipal({})
            : undefined;
        if (useCurrent && gBrowser.selectedBrowser && typeof gBrowser.selectedBrowser.loadURI === "function") {
          gBrowser.selectedBrowser.loadURI(ServicesRef.io.newURI(url), { triggeringPrincipal: principal });
        } else if (typeof gBrowser.addTab === "function") {
          gBrowser.selectedTab = gBrowser.addTab(url, { triggeringPrincipal: principal });
        }
      } catch (err) {
        logError("openPopoverUrl failed", err);
      }
    }

    function clearChildren(node) {
      if (!node) {
        return;
      }
      while (node.firstChild) {
        node.firstChild.remove();
      }
    }

    function renderPopoverEmpty(listEl, text) {
      clearChildren(listEl);
      const empty = createHtmlEl("div", { class: "dragon-pop-empty" });
      empty.textContent = text;
      listEl.appendChild(empty);
    }

    function detachDownloadsView() {
      if (downloadsListRef && downloadsViewRef && typeof downloadsListRef.removeView === "function") {
        try {
          downloadsListRef.removeView(downloadsViewRef);
        } catch (_err) {}
      }
      downloadsViewRef = null;
    }

    function isShieldOpen() {
      return activePopover === "shield";
    }

    function setShieldOpen(open) {
      setActivePopover(open ? "shield" : null);
    }

    function setActivePopover(name) {
      const target = name && name !== activePopover ? name : null;
      const prev = activePopover;
      if (prev === "downloads" && target !== "downloads") {
        detachDownloadsView();
      }
      activePopover = target;

      if (target && typeof setDockExpanded === "function") {
        setDockExpanded(false);
      }

      const map = [
        { key: "shield", el: shieldPopoverEl, btn: shieldBtnEl },
        { key: "bookmarks", el: bookmarksPopoverEl, btn: bookmarksBtnEl },
        { key: "history", el: historyPopoverEl, btn: historyBtnEl },
        { key: "downloads", el: downloadsPopoverEl, btn: downloadsBtnEl },
      ];

      for (const entry of map) {
        const isOpen = target === entry.key;
        if (entry.el) {
          if (isOpen) {
            entry.el.removeAttribute("hidden");
          } else {
            entry.el.setAttribute("hidden", "true");
          }
        }
        if (entry.btn) {
          if (isOpen) {
            entry.btn.setAttribute("open", "true");
            entry.btn.setAttribute("aria-expanded", "true");
          } else {
            entry.btn.removeAttribute("open");
            entry.btn.setAttribute("aria-expanded", "false");
          }
        }
      }

      if (target === "shield") {
        refreshShieldUI();
      } else if (target === "bookmarks") {
        refreshBookmarksPopover();
        if (bookmarksUi.searchEl) {
          scheduleTimer(() => {
            try {
              bookmarksUi.searchEl.focus();
            } catch (_err) {}
          }, 20);
        }
      } else if (target === "history") {
        refreshHistoryPopover();
        if (historyUi.searchEl) {
          scheduleTimer(() => {
            try {
              historyUi.searchEl.focus();
            } catch (_err) {}
          }, 20);
        }
      } else if (target === "downloads") {
        attachAndRefreshDownloadsPopover();
      }
    }

    function scheduleBookmarksRefresh(delayMs = 140) {
      if (bookmarksSearchTimer !== null) {
        window.clearTimeout(bookmarksSearchTimer);
        pendingTimers.delete(bookmarksSearchTimer);
        bookmarksSearchTimer = null;
      }
      bookmarksSearchTimer = scheduleTimer(() => {
        bookmarksSearchTimer = null;
        if (activePopover === "bookmarks") {
          refreshBookmarksPopover();
        }
      }, delayMs);
    }

    function scheduleHistoryRefresh(delayMs = 140) {
      if (historySearchTimer !== null) {
        window.clearTimeout(historySearchTimer);
        pendingTimers.delete(historySearchTimer);
        historySearchTimer = null;
      }
      historySearchTimer = scheduleTimer(() => {
        historySearchTimer = null;
        if (activePopover === "history") {
          refreshHistoryPopover();
        }
      }, delayMs);
    }

    function scheduleDownloadsRefresh(delayMs = 80) {
      if (downloadsRefreshTimer !== null) {
        window.clearTimeout(downloadsRefreshTimer);
        pendingTimers.delete(downloadsRefreshTimer);
        downloadsRefreshTimer = null;
      }
      downloadsRefreshTimer = scheduleTimer(() => {
        downloadsRefreshTimer = null;
        if (activePopover === "downloads") {
          refreshDownloadsList();
        }
      }, delayMs);
    }

    async function refreshBookmarksPopover() {
      if (!bookmarksUi.listEl) {
        return;
      }
      const reqId = ++bookmarksReqId;
      const pu = getPlacesUtils();
      if (!pu || !pu.bookmarks) {
        renderPopoverEmpty(bookmarksUi.listEl, "Bookmarks service unavailable");
        return;
      }

      try {
        const currentUri = getTabURI(gBrowser.selectedTab);
        const bookmarkable = /^https?:\/\/|^file:\/\//i.test(currentUri);
        bookmarksUi.activePageUrl = bookmarkable ? currentUri : "";
        bookmarksUi.activeBookmarkGuid = null;

        if (bookmarkable) {
          try {
            const existing = await pu.bookmarks.fetch({ url: currentUri });
            if (reqId !== bookmarksReqId) {
              return;
            }
            if (existing && existing.guid) {
              bookmarksUi.activeBookmarkGuid = existing.guid;
            }
          } catch (_fetchErr) {}
        }

        if (bookmarksUi.togglePageBtn) {
          if (!bookmarkable) {
            bookmarksUi.togglePageBtn.setAttribute("disabled", "true");
            bookmarksUi.togglePageBtn.removeAttribute("data-bookmarked");
            bookmarksUi.togglePageBtn.textContent = "Bookmark Page";
          } else {
            bookmarksUi.togglePageBtn.removeAttribute("disabled");
            if (bookmarksUi.activeBookmarkGuid) {
              bookmarksUi.togglePageBtn.setAttribute("data-bookmarked", "true");
              bookmarksUi.togglePageBtn.textContent = "Remove Bookmark";
            } else {
              bookmarksUi.togglePageBtn.removeAttribute("data-bookmarked");
              bookmarksUi.togglePageBtn.textContent = "Bookmark Page";
            }
          }
        }

        const query = bookmarksUi.searchEl ? bookmarksUi.searchEl.value.trim() : "";
        const rawItems = query
          ? await pu.bookmarks.search({ query })
          : await pu.bookmarks.getRecent(40);
        if (reqId !== bookmarksReqId) {
          return;
        }

        const typeBookmark = pu.bookmarks.TYPE_BOOKMARK || 1;
        const items = [];
        for (const item of Array.isArray(rawItems) ? rawItems : []) {
          if (!item || (item.type && item.type !== typeBookmark)) {
            continue;
          }
          const urlStr = normalizeBookmarkUrl(item);
          if (!urlStr || urlStr.startsWith("place:")) {
            continue;
          }
          items.push({ guid: item.guid, title: item.title, url: urlStr });
          if (items.length >= 40) {
            break;
          }
        }

        if (bookmarksUi.countPillEl) {
          bookmarksUi.countPillEl.textContent = items.length + " SAVED";
        }
        if (bookmarksUi.subtitleEl) {
          bookmarksUi.subtitleEl.textContent = query ? "Search results" : "Recent & saved pages";
        }

        if (items.length === 0) {
          renderPopoverEmpty(
            bookmarksUi.listEl,
            query ? "No bookmarks match \"" + query + "\"" : "No saved bookmarks yet"
          );
          return;
        }

        clearChildren(bookmarksUi.listEl);
        for (const entry of items) {
          const hostName = formatHostname(entry.url);
          const row = createHtmlEl("div", {
            class: "dragon-pop-item",
            role: "button",
            tabindex: "0",
            title: entry.url,
          });
          row.appendChild(createFaviconBadge(entry.url));

          const textWrap = createHtmlEl("div", { class: "dragon-pop-item-text" });
          const titleEl = createHtmlEl("span", { class: "dragon-pop-item-title" });
          titleEl.textContent = entry.title || hostName || entry.url;
          const metaEl = createHtmlEl("span", { class: "dragon-pop-item-meta" });
          metaEl.textContent = hostName || entry.url;
          textWrap.appendChild(titleEl);
          textWrap.appendChild(metaEl);
          row.appendChild(textWrap);

          const actions = createHtmlEl("div", { class: "dragon-pop-item-actions" });
          const removeBtn = createHtmlEl("button", {
            type: "button",
            class: "dragon-pop-action-btn dragon-pop-action-danger",
            title: "Remove bookmark",
            "aria-label": "Remove bookmark",
          });
          removeBtn.textContent = "\u00D7";
          removeBtn.addEventListener("click", async (evt) => {
            evt.stopPropagation();
            evt.preventDefault();
            try {
              await pu.bookmarks.remove(entry.guid);
              refreshBookmarksPopover();
            } catch (err) {
              logError("Failed removing bookmark", err);
            }
          });
          actions.appendChild(removeBtn);
          row.appendChild(actions);

          const openRow = (forceNewTab) => {
            setActivePopover(null);
            openPopoverUrl(entry.url, forceNewTab);
          };
          row.addEventListener("click", (evt) => {
            evt.stopPropagation();
            openRow(evt.ctrlKey || evt.metaKey);
          });
          row.addEventListener("auxclick", (evt) => {
            if (evt.button === 1) {
              evt.stopPropagation();
              evt.preventDefault();
              openRow(true);
            }
          });
          row.addEventListener("keydown", (evt) => {
            if (evt.key === "Enter" || evt.key === " ") {
              evt.preventDefault();
              evt.stopPropagation();
              openRow(evt.ctrlKey || evt.metaKey);
            }
          });
          bookmarksUi.listEl.appendChild(row);
        }
      } catch (err) {
        if (reqId === bookmarksReqId) {
          logError("refreshBookmarksPopover failed", err);
          renderPopoverEmpty(bookmarksUi.listEl, "Could not load bookmarks");
        }
      }
    }

    async function refreshHistoryPopover() {
      if (!historyUi.listEl) {
        return;
      }
      const reqId = ++historyReqId;
      const pu = getPlacesUtils();
      if (!pu || typeof pu.promiseDBConnection !== "function") {
        renderPopoverEmpty(historyUi.listEl, "History database unavailable");
        return;
      }

      try {
        const db = await pu.promiseDBConnection();
        if (reqId !== historyReqId) {
          return;
        }
        const query = historyUi.searchEl ? historyUi.searchEl.value.trim() : "";
        let rows;
        if (query) {
          const escaped = query.toLowerCase().replace(/[\\%_]/g, "\\$&");
          rows = await db.executeCached(
            `SELECT MAX(v.visit_date) AS visit_date, h.title, h.url, h.guid
             FROM moz_historyvisits v
             JOIN moz_places h ON v.place_id = h.id
             WHERE h.hidden = 0
               AND h.url NOT LIKE 'chrome://%'
               AND h.url NOT LIKE 'about:%'
               AND (LOWER(COALESCE(h.title, '')) LIKE :pat ESCAPE '\\' OR LOWER(h.url) LIKE :pat ESCAPE '\\')
             GROUP BY h.url
             ORDER BY visit_date DESC
             LIMIT 40`,
            { pat: "%" + escaped + "%" }
          );
        } else {
          rows = await db.executeCached(
            `SELECT MAX(v.visit_date) AS visit_date, h.title, h.url, h.guid
             FROM moz_historyvisits v
             JOIN moz_places h ON v.place_id = h.id
             WHERE h.hidden = 0
               AND h.url NOT LIKE 'chrome://%'
               AND h.url NOT LIKE 'about:%'
             GROUP BY h.url
             ORDER BY visit_date DESC
             LIMIT 40`
          );
        }
        if (reqId !== historyReqId) {
          return;
        }

        const list = Array.isArray(rows) ? rows : [];
        if (historyUi.countPillEl) {
          historyUi.countPillEl.textContent = list.length > 0 ? list.length + " VISITS" : "EMPTY";
        }
        if (historyUi.subtitleEl) {
          historyUi.subtitleEl.textContent = query ? "Filtered visits" : "Recently visited pages";
        }

        if (list.length === 0) {
          renderPopoverEmpty(
            historyUi.listEl,
            query ? "No history matching \"" + query + "\"" : "No recent browsing history"
          );
          return;
        }

        clearChildren(historyUi.listEl);
        for (const r of list) {
          const urlStr = r.getResultByName("url");
          const pageTitle = r.getResultByName("title");
          const visitMicro = Number(r.getResultByName("visit_date")) || 0;
          const hostName = formatHostname(urlStr);
          const relTime = visitMicro > 0 ? formatRelativeTime(visitMicro / 1000) : "";

          const row = createHtmlEl("div", {
            class: "dragon-pop-item",
            role: "button",
            tabindex: "0",
            title: urlStr,
          });
          row.appendChild(createFaviconBadge(urlStr));

          const textWrap = createHtmlEl("div", { class: "dragon-pop-item-text" });
          const titleEl = createHtmlEl("span", { class: "dragon-pop-item-title" });
          titleEl.textContent = pageTitle || hostName || urlStr;
          const metaEl = createHtmlEl("span", { class: "dragon-pop-item-meta" });
          metaEl.textContent = relTime ? hostName + " \u00B7 " + relTime : hostName;
          textWrap.appendChild(titleEl);
          textWrap.appendChild(metaEl);
          row.appendChild(textWrap);

          const actions = createHtmlEl("div", { class: "dragon-pop-item-actions" });
          const removeBtn = createHtmlEl("button", {
            type: "button",
            class: "dragon-pop-action-btn dragon-pop-action-danger",
            title: "Delete from history",
            "aria-label": "Delete from history",
          });
          removeBtn.textContent = "\u00D7";
          removeBtn.addEventListener("click", async (evt) => {
            evt.stopPropagation();
            evt.preventDefault();
            try {
              if (pu.history && typeof pu.history.remove === "function") {
                await pu.history.remove(urlStr);
                refreshHistoryPopover();
              }
            } catch (err) {
              logError("Failed deleting history item", err);
            }
          });
          actions.appendChild(removeBtn);
          row.appendChild(actions);

          const openRow = (forceNewTab) => {
            setActivePopover(null);
            openPopoverUrl(urlStr, forceNewTab);
          };
          row.addEventListener("click", (evt) => {
            evt.stopPropagation();
            openRow(evt.ctrlKey || evt.metaKey);
          });
          row.addEventListener("auxclick", (evt) => {
            if (evt.button === 1) {
              evt.stopPropagation();
              evt.preventDefault();
              openRow(true);
            }
          });
          row.addEventListener("keydown", (evt) => {
            if (evt.key === "Enter" || evt.key === " ") {
              evt.preventDefault();
              evt.stopPropagation();
              openRow(evt.ctrlKey || evt.metaKey);
            }
          });
          historyUi.listEl.appendChild(row);
        }
      } catch (err) {
        if (reqId === historyReqId) {
          logError("refreshHistoryPopover failed", err);
          renderPopoverEmpty(historyUi.listEl, "Could not load history");
        }
      }
    }

    function getDownloadFileName(download) {
      try {
        const path = download && download.target && download.target.path;
        if (path) {
          const parts = path.split(/[\\/]/).filter(Boolean);
          if (parts.length > 0) {
            return parts[parts.length - 1];
          }
        }
        const url = download && download.source && download.source.url;
        if (url) {
          const parsed = new URL(url);
          const segs = parsed.pathname.split("/").filter(Boolean);
          if (segs.length > 0) {
            return decodeURIComponent(segs[segs.length - 1]);
          }
          return parsed.hostname;
        }
      } catch (_err) {}
      return "Download";
    }

    async function refreshDownloadsList() {
      if (!downloadsUi.listEl || !downloadsListRef) {
        return;
      }
      const reqId = ++downloadsReqId;
      try {
        const all = await downloadsListRef.getAll();
        if (reqId !== downloadsReqId) {
          return;
        }
        const items = Array.from(all || []).sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
        const activeCount = items.filter((d) => !d.stopped).length;
        const finishedCount = items.filter((d) => d.stopped).length;

        if (downloadsUi.countPillEl) {
          if (activeCount > 0) {
            downloadsUi.countPillEl.setAttribute("data-state", "active");
            downloadsUi.countPillEl.textContent = activeCount + " ACTIVE";
          } else {
            downloadsUi.countPillEl.setAttribute("data-state", "neutral");
            downloadsUi.countPillEl.textContent = items.length > 0 ? items.length + " FILES" : "EMPTY";
          }
        }
        if (downloadsUi.clearBtn) {
          if (finishedCount > 0) {
            downloadsUi.clearBtn.removeAttribute("disabled");
          } else {
            downloadsUi.clearBtn.setAttribute("disabled", "true");
          }
        }

        if (items.length === 0) {
          renderPopoverEmpty(downloadsUi.listEl, "No recent downloads");
          return;
        }

        clearChildren(downloadsUi.listEl);
        for (const dl of items.slice(0, 30)) {
          const fileName = getDownloadFileName(dl);
          const sourceUrl = (dl.source && dl.source.url) || "";
          const hostName = formatHostname(sourceUrl);
          const isRunning = !dl.stopped;
          const isSucceeded = Boolean(dl.succeeded);
          const isCanceled = Boolean(dl.canceled);
          const isError = Boolean(dl.error);
          const total = Number(dl.totalBytes) || 0;
          const current = Number(dl.currentBytes) || 0;
          const pct = Number.isFinite(dl.progress)
            ? dl.progress
            : total > 0
              ? Math.round((current / total) * 100)
              : 0;

          let statusText = "Completed";
          let sizeText = formatBytes(total > 0 ? total : current);
          if (isRunning) {
            statusText = total > 0 ? pct + "%" : "Downloading";
            sizeText = total > 0 ? formatBytes(current) + " / " + formatBytes(total) : formatBytes(current);
          } else if (isCanceled) {
            statusText = dl.hasPartialData ? "Paused" : "Canceled";
          } else if (isError) {
            statusText = "Failed";
          } else if (!isSucceeded) {
            statusText = "Stopped";
          }

          const row = createHtmlEl("div", {
            class: "dragon-pop-item dragon-dl-item",
            role: isSucceeded ? "button" : "listitem",
            tabindex: isSucceeded ? "0" : "-1",
            title: (dl.target && dl.target.path) || sourceUrl || fileName,
          });

          const iconBox = createHtmlEl("span", {
            class: "dragon-pop-icon-box dragon-dl-state-icon",
            "data-dl-state": isRunning ? "running" : isSucceeded ? "done" : "error",
          });
          const iconShapes = isRunning
            ? [{ tag: "path", d: "M9 3.5V11.2M6.2 8.5L9 11.4L11.8 8.5M4.5 14H13.5" }]
            : isSucceeded
              ? [{ tag: "path", d: "M4.5 9.2L7.5 12.2L13.5 6" }]
              : [{ tag: "path", d: "M5.5 5.5L12.5 12.5M12.5 5.5L5.5 12.5" }];
          iconBox.appendChild(createSvgEl("0 0 18 18", iconShapes, "dragon-dock-icon", "1.8"));
          row.appendChild(iconBox);

          const textWrap = createHtmlEl("div", { class: "dragon-pop-item-text" });
          const titleEl = createHtmlEl("span", { class: "dragon-pop-item-title" });
          titleEl.textContent = fileName;
          const metaParts = [sizeText, statusText, hostName].filter(Boolean);
          const metaEl = createHtmlEl("span", { class: "dragon-pop-item-meta" });
          metaEl.textContent = metaParts.join(" \u00B7 ");
          textWrap.appendChild(titleEl);
          textWrap.appendChild(metaEl);

          if (isRunning) {
            const barTrack = createHtmlEl("div", { class: "dragon-dl-progress" });
            const barFill = createHtmlEl("div", { class: "dragon-dl-progress-bar" });
            barFill.style.width = Math.max(6, Math.min(100, pct)) + "%";
            barTrack.appendChild(barFill);
            textWrap.appendChild(barTrack);
          }
          row.appendChild(textWrap);

          const actions = createHtmlEl("div", { class: "dragon-pop-item-actions" });
          if (isRunning) {
            const cancelBtn = createHtmlEl("button", {
              type: "button",
              class: "dragon-pop-action-btn dragon-pop-action-danger",
              title: "Cancel download",
              "aria-label": "Cancel download",
            });
            cancelBtn.textContent = "\u00D7";
            cancelBtn.addEventListener("click", (evt) => {
              evt.stopPropagation();
              evt.preventDefault();
              try {
                dl.cancel();
              } catch (_err) {}
            });
            actions.appendChild(cancelBtn);
          } else {
            if (isSucceeded) {
              const folderBtn = createHtmlEl("button", {
                type: "button",
                class: "dragon-pop-action-btn",
                title: "Show in folder",
                "aria-label": "Show in folder",
              });
              folderBtn.appendChild(
                createSvgEl(
                  "0 0 18 18",
                  [{ tag: "path", d: "M3 5.2C3 4.4 3.6 3.8 4.4 3.8H7.3L8.8 5.4H13.6C14.4 5.4 15 6 15 6.8V12.8C15 13.6 14.4 14.2 13.6 14.2H4.4C3.6 14.2 3 13.6 3 12.8V5.2Z" }],
                  "dragon-dock-icon",
                  "1.5"
                )
              );
              folderBtn.addEventListener("click", (evt) => {
                evt.stopPropagation();
                evt.preventDefault();
                try {
                  dl.showContainingDirectory();
                } catch (err) {
                  logError("showContainingDirectory failed", err);
                }
              });
              actions.appendChild(folderBtn);
            } else if (isCanceled || isError) {
              const retryBtn = createHtmlEl("button", {
                type: "button",
                class: "dragon-pop-action-btn",
                title: "Retry download",
                "aria-label": "Retry download",
              });
              retryBtn.appendChild(
                createSvgEl(
                  "0 0 18 18",
                  [
                    { tag: "path", d: "M14 9A5 5 0 1 1 12.5 5.4" },
                    { tag: "path", d: "M14 3.5V6.2H11.3" },
                  ],
                  "dragon-dock-icon",
                  "1.6"
                )
              );
              retryBtn.addEventListener("click", (evt) => {
                evt.stopPropagation();
                evt.preventDefault();
                try {
                  dl.start();
                } catch (err) {
                  logError("Retry download failed", err);
                }
              });
              actions.appendChild(retryBtn);
            }

            const removeBtn = createHtmlEl("button", {
              type: "button",
              class: "dragon-pop-action-btn dragon-pop-action-danger",
              title: "Remove from list",
              "aria-label": "Remove download from list",
            });
            removeBtn.textContent = "\u00D7";
            removeBtn.addEventListener("click", async (evt) => {
              evt.stopPropagation();
              evt.preventDefault();
              try {
                await downloadsListRef.remove(dl);
                refreshDownloadsList();
              } catch (err) {
                logError("Remove download failed", err);
              }
            });
            actions.appendChild(removeBtn);
          }

          row.appendChild(actions);

          if (isSucceeded) {
            const launchRow = () => {
              setActivePopover(null);
              try {
                dl.launch();
              } catch (err) {
                logError("Download launch failed", err);
              }
            };
            row.addEventListener("click", (evt) => {
              evt.stopPropagation();
              launchRow();
            });
            row.addEventListener("keydown", (evt) => {
              if (evt.key === "Enter" || evt.key === " ") {
                evt.preventDefault();
                evt.stopPropagation();
                launchRow();
              }
            });
          }

          downloadsUi.listEl.appendChild(row);
        }
      } catch (err) {
        if (reqId === downloadsReqId) {
          logError("refreshDownloadsList failed", err);
          renderPopoverEmpty(downloadsUi.listEl, "Could not load downloads");
        }
      }
    }

    async function attachAndRefreshDownloadsPopover() {
      if (!downloadsUi.listEl) {
        return;
      }
      const DownloadsMod = getDownloadsModule();
      if (!DownloadsMod || typeof DownloadsMod.getList !== "function") {
        renderPopoverEmpty(downloadsUi.listEl, "Downloads service unavailable");
        return;
      }
      try {
        downloadsListRef = await DownloadsMod.getList(DownloadsMod.ALL);
        if (activePopover !== "downloads") {
          return;
        }
        detachDownloadsView();
        downloadsViewRef = {
          onDownloadAdded: () => scheduleDownloadsRefresh(60),
          onDownloadChanged: () => scheduleDownloadsRefresh(80),
          onDownloadRemoved: () => scheduleDownloadsRefresh(40),
        };
        downloadsListRef.addView(downloadsViewRef);
        await refreshDownloadsList();
      } catch (err) {
        logError("attachAndRefreshDownloadsPopover failed", err);
        renderPopoverEmpty(downloadsUi.listEl, "Could not load downloads");
      }
    }

    function refreshShieldUI() {
      try {
        if (!DragonCoreService) {
          return;
        }
        const browser = typeof gBrowser !== "undefined" ? gBrowser.selectedBrowser : null;

        // Fast path when popover is hidden: update only badge + shield icon state without deep-cloning full state
        if (!isShieldOpen() && typeof DragonCoreService.getBrowserBlockedCount === "function") {
          const tabBlocked = Number(DragonCoreService.getBrowserBlockedCount(browser)) || 0;
          if (shieldBadgeEl) {
            if (tabBlocked > 0) {
              shieldBadgeEl.textContent = tabBlocked > 99 ? "99+" : String(tabBlocked);
              shieldBadgeEl.removeAttribute("hidden");
            } else {
              shieldBadgeEl.textContent = "";
              shieldBadgeEl.setAttribute("hidden", "true");
            }
          }
          return;
        }

        if (typeof DragonCoreService.getStateForBrowser !== "function") {
          return;
        }
        const state = DragonCoreService.getStateForBrowser(browser);
        if (!state || !state.settings || !state.stats) {
          return;
        }

        const { settings, stats } = state;
        const tabBlocked = Number(stats.tabBlocked) || 0;
        const totalBlocked = Number(stats.totalBlocked) || 0;
        const sleepingCount = Number(stats.sleepingCount) || 0;
        const ramSavedMb = Number(stats.estimatedRamSavedMb) || 0;
        const domain = typeof stats.currentDomain === "string" ? stats.currentDomain : "";

        shieldUi.currentDomain = domain;

        const shieldState = !settings.adblockEnabled
          ? "paused"
          : stats.isAllowlisted
            ? "allowlisted"
            : "active";

        if (shieldBtnEl) {
          shieldBtnEl.setAttribute("data-shield-state", shieldState);
        }

        if (shieldBadgeEl) {
          if (tabBlocked > 0) {
            shieldBadgeEl.textContent = tabBlocked > 99 ? "99+" : String(tabBlocked);
            shieldBadgeEl.removeAttribute("hidden");
          } else {
            shieldBadgeEl.textContent = "";
            shieldBadgeEl.setAttribute("hidden", "true");
          }
        }

        if (!shieldPopoverEl) {
          return;
        }

        if (shieldUi.domainEl) {
          shieldUi.domainEl.textContent = domain || "Browser / Internal Page";
        }
        if (shieldUi.statusPillEl) {
          shieldUi.statusPillEl.setAttribute("data-state", shieldState);
          shieldUi.statusPillEl.textContent =
            shieldState === "paused"
              ? "Paused"
              : shieldState === "allowlisted"
                ? "Allowlisted"
                : "Active";
        }
        if (shieldUi.tabBlockedEl) {
          shieldUi.tabBlockedEl.textContent = String(tabBlocked);
        }
        if (shieldUi.totalBlockedEl) {
          shieldUi.totalBlockedEl.textContent = totalBlocked.toLocaleString();
        }
        if (shieldUi.sleepingEl) {
          shieldUi.sleepingEl.textContent =
            sleepingCount > 0 ? sleepingCount + " (~" + ramSavedMb + " MB)" : "0 tabs";
        }

        if (shieldUi.adblockBtn && shieldUi.adblockStateEl) {
          shieldUi.adblockBtn.setAttribute("data-active", settings.adblockEnabled ? "true" : "false");
          shieldUi.adblockStateEl.textContent = settings.adblockEnabled ? "ON" : "OFF";
        }

        if (shieldUi.allowlistBtn && shieldUi.allowlistStateEl) {
          if (!domain) {
            shieldUi.allowlistBtn.setAttribute("disabled", "true");
            shieldUi.allowlistBtn.setAttribute("data-active", "false");
            shieldUi.allowlistStateEl.textContent = "N/A";
          } else {
            shieldUi.allowlistBtn.removeAttribute("disabled");
            shieldUi.allowlistBtn.setAttribute("data-active", stats.isAllowlisted ? "false" : "true");
            shieldUi.allowlistStateEl.textContent = stats.isAllowlisted ? "Allowlisted" : "Protected";
          }
        }

        if (shieldUi.darkBtn && shieldUi.darkStateEl) {
          shieldUi.darkBtn.setAttribute("data-active", settings.forceDarkEnabled ? "true" : "false");
          shieldUi.darkStateEl.textContent = settings.forceDarkEnabled ? "ON" : "OFF";
        }

        if (shieldUi.darkSiteBtn && shieldUi.darkSiteStateEl) {
          if (!domain) {
            shieldUi.darkSiteBtn.setAttribute("disabled", "true");
            shieldUi.darkSiteBtn.setAttribute("data-active", "false");
            shieldUi.darkSiteStateEl.textContent = "N/A";
          } else {
            shieldUi.darkSiteBtn.removeAttribute("disabled");
            shieldUi.darkSiteBtn.setAttribute(
              "data-active",
              stats.isForceDarkExcluded ? "false" : "true"
            );
            shieldUi.darkSiteStateEl.textContent = stats.isForceDarkExcluded ? "Excluded" : "Active";
          }
        }
      } catch (err) {
        logError("refreshShieldUI failed", err);
      }
    }

    function scheduleShieldRefresh(delayMs = 50) {
      if (shieldRefreshTimer !== null) {
        window.clearTimeout(shieldRefreshTimer);
        pendingTimers.delete(shieldRefreshTimer);
        shieldRefreshTimer = null;
      }
      shieldRefreshTimer = scheduleTimer(() => {
        shieldRefreshTimer = null;
        refreshShieldUI();
      }, delayMs);
    }

    function createDockButton(opts) {
      const btn = createHtmlEl("button", {
        type: "button",
        id: opts.id,
        class: "dragon-dock-btn",
        title: opts.title,
        "aria-label": opts.ariaLabel || opts.label,
      });
      if (opts.ariaPressed !== undefined) {
        btn.setAttribute("aria-pressed", String(opts.ariaPressed));
      }
      btn.appendChild(createSvgEl(opts.viewBox || "0 0 18 18", opts.shapes, "dragon-dock-icon"));
      const labelEl = createHtmlEl(
        "span",
        opts.labelId ? { id: opts.labelId, class: "dragon-dock-label" } : { class: "dragon-dock-label" }
      );
      labelEl.textContent = opts.label;
      btn.appendChild(labelEl);
      btn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        opts.onClick();
      });
      return btn;
    }

    function mountDockPopovers(host) {
      // 1. Dragon Shield Popover (Ask AI removed)
      const shieldShell = createPopoverShell({
        id: "dragon-shield-popover",
        title: "Dragon Shield",
        pillId: "dragon-shield-status-pill",
        pillState: "active",
        pillText: "Active",
        subtitleId: "dragon-shield-domain",
        subtitleText: "Browser / Internal Page",
        closeId: "dragon-shield-close-btn",
      });
      shieldPopoverEl = shieldShell.section;
      shieldUi.statusPillEl = shieldShell.pillEl;
      shieldUi.domainEl = shieldShell.subtitleEl;

      const spStats = createHtmlEl("div", { class: "dragon-sp-stats" });
      const makeStatCard = (valId, labelText) => {
        const card = createHtmlEl("div", { class: "dragon-sp-stat-card" });
        const valEl = createHtmlEl("span", { id: valId, class: "dragon-sp-stat-val" });
        valEl.textContent = "0";
        const lblEl = createHtmlEl("span", { class: "dragon-sp-stat-lbl" });
        lblEl.textContent = labelText;
        card.appendChild(valEl);
        card.appendChild(lblEl);
        spStats.appendChild(card);
        return valEl;
      };
      shieldUi.tabBlockedEl = makeStatCard("dragon-shield-tab-blocked", "This Tab");
      shieldUi.totalBlockedEl = makeStatCard("dragon-shield-total-blocked", "Total Blocked");
      shieldUi.sleepingEl = makeStatCard("dragon-shield-sleeping-info", "Sleeping Tabs");
      shieldPopoverEl.appendChild(spStats);

      const spControls = createHtmlEl("div", { class: "dragon-sp-controls" });
      const makeControlRow = (btnId, labelText, onToggle) => {
        const btn = createHtmlEl("button", {
          type: "button",
          id: btnId,
          class: "dragon-sp-control-btn",
        });
        const labelSpan = createHtmlEl("span");
        labelSpan.textContent = labelText;
        const stateSpan = createHtmlEl("span", { class: "dragon-sp-control-state" });
        stateSpan.textContent = "ON";
        btn.appendChild(labelSpan);
        btn.appendChild(stateSpan);
        btn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          onToggle();
        });
        spControls.appendChild(btn);
        return { btn, stateSpan };
      };

      const adblockRow = makeControlRow("dragon-shield-adblock-toggle", "Ad & Tracker Blocker", () => {
        if (!DragonCoreService) {
          return;
        }
        const cur = DragonCoreService.getSettings();
        DragonCoreService.updateSettings({ adblockEnabled: !cur.adblockEnabled });
        refreshShieldUI();
      });
      shieldUi.adblockBtn = adblockRow.btn;
      shieldUi.adblockStateEl = adblockRow.stateSpan;

      const allowRow = makeControlRow("dragon-shield-allowlist-btn", "Shield on This Site", () => {
        if (!DragonCoreService || !shieldUi.currentDomain) {
          return;
        }
        DragonCoreService.toggleAllowlist(shieldUi.currentDomain);
        refreshShieldUI();
      });
      shieldUi.allowlistBtn = allowRow.btn;
      shieldUi.allowlistStateEl = allowRow.stateSpan;

      const darkRow = makeControlRow("dragon-shield-dark-toggle", "Obsidian Force Dark", () => {
        if (!DragonCoreService) {
          return;
        }
        const cur = DragonCoreService.getSettings();
        DragonCoreService.updateSettings({ forceDarkEnabled: !cur.forceDarkEnabled });
        refreshShieldUI();
      });
      shieldUi.darkBtn = darkRow.btn;
      shieldUi.darkStateEl = darkRow.stateSpan;

      const darkSiteRow = makeControlRow("dragon-shield-dark-site-btn", "Force Dark on Site", () => {
        if (!DragonCoreService || !shieldUi.currentDomain) {
          return;
        }
        DragonCoreService.toggleForceDarkSite(shieldUi.currentDomain);
        refreshShieldUI();
      });
      shieldUi.darkSiteBtn = darkSiteRow.btn;
      shieldUi.darkSiteStateEl = darkSiteRow.stateSpan;
      shieldPopoverEl.appendChild(spControls);

      const spFooter = createHtmlEl("div", { class: "dragon-sp-footer" });
      const spSleepBtn = createHtmlEl("button", {
        type: "button",
        id: "dragon-shield-sleep-btn",
        class: "dragon-sp-footer-btn",
      });
      spSleepBtn.textContent = "Sleep Inactive";
      spSleepBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        sleepEligibleInactiveTabs();
      });
      const spSettingsBtn = createHtmlEl("button", {
        type: "button",
        id: "dragon-shield-settings-btn",
        class: "dragon-sp-footer-btn",
      });
      spSettingsBtn.textContent = "Dragon Settings";
      spSettingsBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        setActivePopover(null);
        openDragonSettingsTab();
      });
      spFooter.appendChild(spSleepBtn);
      spFooter.appendChild(spSettingsBtn);
      shieldPopoverEl.appendChild(spFooter);
      host.appendChild(shieldPopoverEl);

      // 2. Bookmarks Popover
      const bmShell = createPopoverShell({
        id: "dragon-bookmarks-popover",
        title: "Bookmarks",
        pillId: "dragon-bookmarks-count-pill",
        pillState: "neutral",
        pillText: "0 SAVED",
        subtitleId: "dragon-bookmarks-subtitle",
        subtitleText: "Recent & saved pages",
        closeId: "dragon-bookmarks-close-btn",
      });
      bookmarksPopoverEl = bmShell.section;
      bookmarksUi.countPillEl = bmShell.pillEl;
      bookmarksUi.subtitleEl = bmShell.subtitleEl;

      bookmarksUi.searchEl = createHtmlEl("input", {
        id: "dragon-bookmarks-search",
        class: "dragon-pop-search",
        type: "search",
        placeholder: "Search bookmarks...",
        autocomplete: "off",
      });
      bookmarksUi.searchEl.addEventListener("input", () => scheduleBookmarksRefresh(140));
      bookmarksPopoverEl.appendChild(bookmarksUi.searchEl);

      bookmarksUi.listEl = createHtmlEl("div", {
        id: "dragon-bookmarks-list",
        class: "dragon-pop-list",
      });
      bookmarksPopoverEl.appendChild(bookmarksUi.listEl);

      const bmFooter = createHtmlEl("div", { class: "dragon-sp-footer" });
      bookmarksUi.togglePageBtn = createHtmlEl("button", {
        type: "button",
        id: "dragon-bookmarks-toggle-page-btn",
        class: "dragon-sp-footer-btn",
      });
      bookmarksUi.togglePageBtn.textContent = "Bookmark Page";
      bookmarksUi.togglePageBtn.addEventListener("click", async (evt) => {
        evt.stopPropagation();
        const pu = getPlacesUtils();
        if (!pu || !pu.bookmarks || !bookmarksUi.activePageUrl) {
          return;
        }
        try {
          if (bookmarksUi.activeBookmarkGuid) {
            await pu.bookmarks.remove(bookmarksUi.activeBookmarkGuid);
          } else {
            const pui = getPlacesUIUtils();
            let parentGuid = pu.bookmarks.unfiledGuid;
            try {
              if (pui && pui.defaultParentGuid) {
                parentGuid = (await pui.defaultParentGuid) || parentGuid;
              }
            } catch (_parentErr) {}
            const pageTitle =
              (gBrowser.selectedTab && gBrowser.selectedTab.label) ||
              formatHostname(bookmarksUi.activePageUrl) ||
              bookmarksUi.activePageUrl;
            await pu.bookmarks.insert({
              parentGuid,
              url: bookmarksUi.activePageUrl,
              title: pageTitle,
            });
          }
          refreshBookmarksPopover();
        } catch (err) {
          logError("Toggle bookmark current page failed", err);
        }
      });

      const bmManageBtn = createHtmlEl("button", {
        type: "button",
        id: "dragon-bookmarks-manage-btn",
        class: "dragon-sp-footer-btn",
      });
      bmManageBtn.textContent = "Manage All";
      bmManageBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        setActivePopover(null);
        try {
          if (typeof PlacesCommandHook !== "undefined" && typeof PlacesCommandHook.showPlacesOrganizer === "function") {
            PlacesCommandHook.showPlacesOrganizer("BookmarksMenu");
            return;
          }
        } catch (_err) {}
        toggleBrowserSidebar("viewBookmarksSidebar");
      });

      bmFooter.appendChild(bookmarksUi.togglePageBtn);
      bmFooter.appendChild(bmManageBtn);
      bookmarksPopoverEl.appendChild(bmFooter);
      host.appendChild(bookmarksPopoverEl);

      // 3. History Popover
      const histShell = createPopoverShell({
        id: "dragon-history-popover",
        title: "History",
        pillId: "dragon-history-count-pill",
        pillState: "neutral",
        pillText: "RECENT",
        subtitleId: "dragon-history-subtitle",
        subtitleText: "Recently visited pages",
        closeId: "dragon-history-close-btn",
      });
      historyPopoverEl = histShell.section;
      historyUi.countPillEl = histShell.pillEl;
      historyUi.subtitleEl = histShell.subtitleEl;

      historyUi.searchEl = createHtmlEl("input", {
        id: "dragon-history-search",
        class: "dragon-pop-search",
        type: "search",
        placeholder: "Search history...",
        autocomplete: "off",
      });
      historyUi.searchEl.addEventListener("input", () => scheduleHistoryRefresh(140));
      historyPopoverEl.appendChild(historyUi.searchEl);

      historyUi.listEl = createHtmlEl("div", {
        id: "dragon-history-list",
        class: "dragon-pop-list",
      });
      historyPopoverEl.appendChild(historyUi.listEl);

      const histFooter = createHtmlEl("div", { class: "dragon-sp-footer" });
      const histClearBtn = createHtmlEl("button", {
        type: "button",
        id: "dragon-history-clear-btn",
        class: "dragon-sp-footer-btn",
      });
      histClearBtn.textContent = "Clear Last Hour";
      histClearBtn.addEventListener("click", async (evt) => {
        evt.stopPropagation();
        const pu = getPlacesUtils();
        if (!pu || !pu.history || typeof pu.history.removeByFilter !== "function") {
          return;
        }
        try {
          const now = new Date();
          await pu.history.removeByFilter({
            beginDate: new Date(now.getTime() - 3600 * 1000),
            endDate: now,
          });
          refreshHistoryPopover();
        } catch (err) {
          logError("Clear last hour history failed", err);
        }
      });

      const histManageBtn = createHtmlEl("button", {
        type: "button",
        id: "dragon-history-manage-btn",
        class: "dragon-sp-footer-btn",
      });
      histManageBtn.textContent = "Full History";
      histManageBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        setActivePopover(null);
        try {
          if (typeof PlacesCommandHook !== "undefined" && typeof PlacesCommandHook.showPlacesOrganizer === "function") {
            PlacesCommandHook.showPlacesOrganizer("History");
            return;
          }
        } catch (_err) {}
        toggleBrowserSidebar("viewHistorySidebar");
      });

      histFooter.appendChild(histClearBtn);
      histFooter.appendChild(histManageBtn);
      historyPopoverEl.appendChild(histFooter);
      host.appendChild(historyPopoverEl);

      // 4. Downloads Popover
      const dlShell = createPopoverShell({
        id: "dragon-downloads-popover",
        title: "Downloads",
        pillId: "dragon-downloads-count-pill",
        pillState: "neutral",
        pillText: "EMPTY",
        subtitleId: "dragon-downloads-subtitle",
        subtitleText: "Recent & active downloads",
        closeId: "dragon-downloads-close-btn",
      });
      downloadsPopoverEl = dlShell.section;
      downloadsUi.countPillEl = dlShell.pillEl;
      downloadsUi.subtitleEl = dlShell.subtitleEl;

      downloadsUi.listEl = createHtmlEl("div", {
        id: "dragon-downloads-list",
        class: "dragon-pop-list",
      });
      downloadsPopoverEl.appendChild(downloadsUi.listEl);

      const dlFooter = createHtmlEl("div", { class: "dragon-sp-footer" });
      downloadsUi.clearBtn = createHtmlEl("button", {
        type: "button",
        id: "dragon-downloads-clear-btn",
        class: "dragon-sp-footer-btn",
        disabled: "true",
      });
      downloadsUi.clearBtn.textContent = "Clear Finished";
      downloadsUi.clearBtn.addEventListener("click", async (evt) => {
        evt.stopPropagation();
        if (!downloadsListRef || typeof downloadsListRef.removeFinished !== "function") {
          return;
        }
        try {
          await downloadsListRef.removeFinished();
          refreshDownloadsList();
        } catch (err) {
          logError("Clear finished downloads failed", err);
        }
      });

      const dlAllBtn = createHtmlEl("button", {
        type: "button",
        id: "dragon-downloads-all-btn",
        class: "dragon-sp-footer-btn",
      });
      dlAllBtn.textContent = "All Downloads";
      dlAllBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        setActivePopover(null);
        openDownloadsView();
      });

      dlFooter.appendChild(downloadsUi.clearBtn);
      dlFooter.appendChild(dlAllBtn);
      downloadsPopoverEl.appendChild(dlFooter);
      host.appendChild(downloadsPopoverEl);
    }

    function mountCornerDock() {
      const existing = document.getElementById("dragon-corner-dock");
      if (existing) {
        dockEl = existing;
        dockToggleBtn = document.getElementById("dragon-dock-toggle");
        dockPanelEl = document.getElementById("dragon-dock-panel");
        updateSplitButtonState();
        syncAllSleepingTabs();
        return;
      }

      const host =
        document.getElementById("tabbrowser-tabbox") ||
        document.getElementById("browser") ||
        document.body;
      if (!host) {
        return;
      }

      dockEl = createHtmlEl("div", {
        id: "dragon-corner-dock",
        class: "dragon-corner-dock",
        role: "region",
        "aria-label": "Quick utilities",
      });

      dockToggleBtn = createHtmlEl("button", {
        type: "button",
        id: "dragon-dock-toggle",
        class: "dragon-dock-toggle",
        "aria-expanded": "false",
        "aria-controls": "dragon-dock-panel",
        "aria-label": "Toggle quick utilities",
        title: "Quick tools & navigation",
      });
      dockToggleBtn.appendChild(
        createSvgEl(
          "0 0 18 18",
          [
            { tag: "rect", x: "3", y: "3", width: "4.5", height: "4.5", rx: "1.2" },
            { tag: "rect", x: "10.5", y: "3", width: "4.5", height: "4.5", rx: "1.2" },
            { tag: "rect", x: "3", y: "10.5", width: "4.5", height: "4.5", rx: "1.2" },
            { tag: "rect", x: "10.5", y: "10.5", width: "4.5", height: "4.5", rx: "1.2" },
          ],
          "dragon-dock-icon-open",
          "1.7"
        )
      );
      dockToggleBtn.appendChild(
        createSvgEl(
          "0 0 16 16",
          [{ tag: "path", d: "M4 4l8 8M12 4l-8 8" }],
          "dragon-dock-icon-close",
          "1.8"
        )
      );
      dockToggleBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        setDockExpanded(!isDockExpanded());
      });

      dockPanelEl = createHtmlEl("div", {
        id: "dragon-dock-panel",
        class: "dragon-dock-panel",
        "aria-hidden": "true",
      });
      const inner = createHtmlEl("div", { class: "dragon-dock-panel-inner" });

      const appendSep = () => {
        inner.appendChild(createHtmlEl("span", { class: "dragon-dock-sep", "aria-hidden": "true" }));
      };

      inner.appendChild(
        createDockButton({
          id: "dragon-split-button",
          label: "Split View",
          title: "Toggle Split-Screen View (Ctrl+Alt+S)",
          ariaLabel: "Toggle Split-Screen View",
          ariaPressed: false,
          viewBox: "0 0 16 16",
          shapes: [
            { tag: "rect", x: "1.5", y: "2.5", width: "13", height: "11", rx: "2" },
            { tag: "line", x1: "8", y1: "2.5", x2: "8", y2: "13.5" },
          ],
          onClick: toggleSplitView,
        })
      );

      shieldBtnEl = createDockButton({
        id: "dragon-dock-shield-btn",
        label: "Shield",
        title: "Open Dragon Shield, AdBlock & Force Dark controls",
        ariaLabel: "Open Dragon Shield controls",
        shapes: [
          {
            tag: "path",
            d: "M9 2.3L14.5 4.4V8.7C14.5 12.1 12.1 14.9 9 15.8C5.9 14.9 3.5 12.1 3.5 8.7V4.4L9 2.3Z",
          },
          { tag: "path", d: "M9 5.4V12.4M6.2 8.9H11.8" },
        ],
        onClick: () => setActivePopover("shield"),
      });
      shieldBtnEl.setAttribute("aria-expanded", "false");
      shieldBadgeEl = createHtmlEl("span", {
        id: "dragon-dock-shield-badge",
        class: "dragon-dock-badge",
        hidden: "true",
      });
      shieldBtnEl.appendChild(shieldBadgeEl);
      inner.appendChild(shieldBtnEl);

      inner.appendChild(
        createDockButton({
          id: "dragon-dock-sleep-btn",
          label: "Sleep",
          labelId: "dragon-dock-sleep-label",
          title: "Put inactive tabs to sleep",
          ariaLabel: "Sleep inactive background tabs",
          shapes: [
            { tag: "path", d: "M14.3 11.2A5.8 5.8 0 0 1 6.8 3.7A5.8 5.8 0 1 0 14.3 11.2Z" },
          ],
          onClick: sleepEligibleInactiveTabs,
        })
      );

      appendSep();

      bookmarksBtnEl = createDockButton({
        id: "dragon-dock-bookmarks-btn",
        label: "Bookmarks",
        title: "Open Bookmarks",
        shapes: [{ tag: "path", d: "M4.5 3H13.5V15.5L9 12.4L4.5 15.5V3Z" }],
        onClick: () => setActivePopover("bookmarks"),
      });
      bookmarksBtnEl.setAttribute("aria-expanded", "false");
      inner.appendChild(bookmarksBtnEl);

      historyBtnEl = createDockButton({
        id: "dragon-dock-history-btn",
        label: "History",
        title: "Open History",
        shapes: [
          { tag: "circle", cx: "9", cy: "9", r: "6.2" },
          { tag: "path", d: "M9 5.5V9.2L11.5 10.8" },
        ],
        onClick: () => setActivePopover("history"),
      });
      historyBtnEl.setAttribute("aria-expanded", "false");
      inner.appendChild(historyBtnEl);

      downloadsBtnEl = createDockButton({
        id: "dragon-dock-downloads-btn",
        label: "Downloads",
        title: "Open Downloads",
        shapes: [
          { tag: "path", d: "M9 3V11.2M5.8 8.3L9 11.5L12.2 8.3M3.5 14.2H14.5" },
        ],
        onClick: () => setActivePopover("downloads"),
      });
      downloadsBtnEl.setAttribute("aria-expanded", "false");
      inner.appendChild(downloadsBtnEl);

      appendSep();

      inner.appendChild(
        createDockButton({
          id: "dragon-dock-private-btn",
          label: "Private",
          title: "Open a Private Window",
          shapes: [
            { tag: "path", d: "M2.5 8.5H15.5" },
            { tag: "path", d: "M5 8.5L6.2 4.3C6.4 3.6 7 3.2 7.7 3.2H10.3C11 3.2 11.6 3.6 11.8 4.3L13 8.5" },
            { tag: "circle", cx: "6.2", cy: "12.2", r: "2.1" },
            { tag: "circle", cx: "11.8", cy: "12.2", r: "2.1" },
            { tag: "path", d: "M8.3 12.2H9.7" },
          ],
          onClick: openPrivateBrowserWindow,
        })
      );

      inner.appendChild(
        createDockButton({
          id: "dragon-dock-settings-btn",
          label: "Settings",
          title: "Open Dragon Settings",
          shapes: [
            { tag: "circle", cx: "9", cy: "9", r: "2.4" },
            {
              tag: "path",
              d: "M14.7 9a5.7 5.7 0 0 0-.1-1l1.5-1.1-1.4-2.4-1.8.6a5.8 5.8 0 0 0-1.7-1L10.9 2.3H8.1L7.8 4.1a5.8 5.8 0 0 0-1.7 1l-1.8-.6-1.4 2.4 1.5 1.1a5.7 5.7 0 0 0 0 2l-1.5 1.1 1.4 2.4 1.8-.6a5.8 5.8 0 0 0 1.7 1l.3 1.8h2.8l.3-1.8a5.8 5.8 0 0 0 1.7-1l1.8.6 1.4-2.4-1.5-1.1c.1-.3.1-.7.1-1Z",
            },
          ],
          onClick: openDragonSettingsTab,
        })
      );

      dockPanelEl.appendChild(inner);
      dockEl.appendChild(dockToggleBtn);
      dockEl.appendChild(dockPanelEl);
      host.appendChild(dockEl);

      mountDockPopovers(host);

      if (ServicesRef && ServicesRef.obs) {
        shieldStatsObserver = {
          observe(_subject, topic) {
            if (topic === "dragon-stats-changed") {
              scheduleShieldRefresh(60);
            }
          },
        };
        shieldSettingsObserver = {
          observe(_subject, topic) {
            if (topic === "dragon-settings-changed") {
              scheduleShieldRefresh(20);
            }
          },
        };
        tabsSleptObserver = {
          observe(_subject, topic) {
            if (topic === "dragon-tabs-slept") {
              syncAllSleepingTabs();
              scheduleShieldRefresh(40);
            }
          },
        };
        try {
          ServicesRef.obs.addObserver(shieldStatsObserver, "dragon-stats-changed", false);
          ServicesRef.obs.addObserver(shieldSettingsObserver, "dragon-settings-changed", false);
          ServicesRef.obs.addObserver(tabsSleptObserver, "dragon-tabs-slept", false);
        } catch (_obsErr) {}
      }

      onDockDocClick = (evt) => {
        if (isDockExpanded() && dockEl && !dockEl.contains(evt.target)) {
          setDockExpanded(false);
        }
        if (activePopover) {
          const popMap = {
            shield: shieldPopoverEl,
            bookmarks: bookmarksPopoverEl,
            history: historyPopoverEl,
            downloads: downloadsPopoverEl,
          };
          const activeEl = popMap[activePopover];
          const inActivePopover = Boolean(activeEl && activeEl.contains(evt.target));
          const inDock = Boolean(dockEl && dockEl.contains(evt.target));
          if (!inActivePopover && !inDock) {
            setActivePopover(null);
          }
        }
      };
      document.addEventListener("click", onDockDocClick);

      updateSplitButtonState();
      syncAllSleepingTabs();
      refreshShieldUI();
    }

    // ------------------------------------------------------------------------
    // 4. Reader Mode (Ctrl+Alt+R)
    // ------------------------------------------------------------------------

    function toggleReaderMode() {
      try {
        const readerBtn = document.getElementById("reader-mode-button");
        if (readerBtn && !readerBtn.hidden) {
          readerBtn.click();
          return true;
        }
        if (typeof ReaderParent !== "undefined" && typeof ReaderParent.toggleReaderMode === "function") {
          ReaderParent.toggleReaderMode({ target: gBrowser.selectedBrowser });
          return true;
        }

        const currentUri = getTabURI(gBrowser.selectedTab);
        if (currentUri.startsWith("about:reader?url=")) {
          const originalUrl = decodeURIComponent(currentUri.slice("about:reader?url=".length));
          if (typeof openTrustedLinkIn === "function") {
            openTrustedLinkIn(originalUrl, "current");
            return true;
          }
        } else if (currentUri.startsWith("http://") || currentUri.startsWith("https://")) {
          if (ServicesRef && ServicesRef.io && ServicesRef.scriptSecurityManager) {
            gBrowser.selectedBrowser.loadURI(
              ServicesRef.io.newURI("about:reader?url=" + encodeURIComponent(currentUri)),
              { triggeringPrincipal: ServicesRef.scriptSecurityManager.getSystemPrincipal() }
            );
            return true;
          }
        }
      } catch (err) {
        logError("toggleReaderMode failed", err);
      }
      return false;
    }

    // ------------------------------------------------------------------------
    // 5. Floating URL Bar Command Summon (Ctrl+L / Alt+D / F6 / Ctrl+Shift+L)
    // ------------------------------------------------------------------------

    const urlbarInput = document.getElementById("urlbar-input");

    function dismissSummonedUrlBar() {
      root.removeAttribute("dragon-urlbar-summoned");
      try {
        if (urlbarInput && document.activeElement === urlbarInput) {
          urlbarInput.blur();
          if (gBrowser && gBrowser.selectedBrowser && typeof gBrowser.selectedBrowser.focus === "function") {
            gBrowser.selectedBrowser.focus();
          }
        }
      } catch (_err) {}
    }

    function summonUrlBar() {
      try {
        root.setAttribute("dragon-urlbar-summoned", "true");

        scheduleTimer(() => {
          if (window.gURLBar) {
            const val = typeof window.gURLBar.value === "string" ? window.gURLBar.value : "";
            const selectedUri = getTabURI(gBrowser.selectedTab);
            if (
              isDragonHomeURI(val) ||
              (isDragonHomeURI(selectedUri) &&
                (val.startsWith("chrome://dragon/") || val.startsWith("about:")))
            ) {
              window.gURLBar.value = "";
            }
            window.gURLBar.focus();
            window.gURLBar.select();
          } else if (urlbarInput) {
            urlbarInput.focus();
            urlbarInput.select();
          }
        }, 16);
      } catch (err) {
        logError("summonUrlBar failed", err);
      }
    }

    const onUrlbarFocus = () => {
      if (root.getAttribute("dragon-urlbar-summoned") !== "true") {
        if (urlbarInput) {
          urlbarInput.blur();
        }
        scheduleTimer(() => {
          try {
            if (gBrowser && gBrowser.selectedBrowser && typeof gBrowser.selectedBrowser.focus === "function") {
              gBrowser.selectedBrowser.focus();
            }
          } catch (_err) {}
        }, 0);
      }
    };

    const onUrlbarBlur = () => {
      if (root.getAttribute("dragon-urlbar-summoned") === "true") {
        // Delay slightly so clicks inside URL bar results don't dismiss prematurely
        scheduleTimer(() => {
          const urlbarEl = document.getElementById("urlbar");
          const stillOpen = urlbarEl && (urlbarEl.hasAttribute("focused") || urlbarEl.hasAttribute("open"));
          if (!stillOpen) {
            dismissSummonedUrlBar();
          }
        }, 120);
      }
    };
    if (urlbarInput) {
      urlbarInput.addEventListener("focus", onUrlbarFocus);
      urlbarInput.addEventListener("blur", onUrlbarBlur);
    }

    // ------------------------------------------------------------------------
    // 6. Unified Top Loading Progress Hairline & Event Listeners
    // ------------------------------------------------------------------------

    let loadProgressEl = null;
    let loadDoneTimer = null;

    function mountLoadProgressBar() {
      const existing = document.getElementById("dragon-load-progress");
      if (existing) {
        loadProgressEl = existing;
        return existing;
      }
      const host = document.getElementById("tabbrowser-tabbox") || document.getElementById("browser") || document.body;
      if (!host) {
        return null;
      }
      const bar = document.createElement("div");
      bar.id = "dragon-load-progress";
      bar.setAttribute("aria-hidden", "true");
      host.appendChild(bar);
      loadProgressEl = bar;
      return bar;
    }

    function setLoadProgress(pct, state) {
      if (!loadProgressEl) {
        return;
      }
      if (loadDoneTimer) {
        window.clearTimeout(loadDoneTimer);
        pendingTimers.delete(loadDoneTimer);
        loadDoneTimer = null;
      }
      loadProgressEl.style.setProperty("--dragon-load-pct", Math.max(0, Math.min(100, pct)) + "%");
      if (state) {
        loadProgressEl.setAttribute("data-state", state);
      } else {
        loadProgressEl.removeAttribute("data-state");
      }
    }

    const onTabSelect = (evt) => {
      const selectedTab = (evt && evt.target) || gBrowser.selectedTab;

      if (splitState.active && selectedTab) {
        if (selectedTab === splitState.leftTab) {
          splitState.focusedSide = "left";
          updateFocusedPaneAttributes();
        } else if (selectedTab === splitState.rightTab) {
          splitState.focusedSide = "right";
          updateFocusedPaneAttributes();
        } else {
          // Selecting a third tab seamlessly loads it into the focused split slot
          const previousTab =
            splitState.focusedSide === "left" ? splitState.leftTab : splitState.rightTab;
          if (splitState.focusedSide === "left") {
            splitState.leftTab = selectedTab;
          } else {
            splitState.rightTab = selectedTab;
          }
          if (previousTab && previousTab !== selectedTab && !previousTab.closing) {
            setBrowserActive(previousTab, false);
          }
          applyFlexSplitPanels();
        }
        scheduleTimer(keepSplitPanesAlive, 0);
      }

      if (!selectedTab || !selectedTab.hasAttribute("busy")) {
        setLoadProgress(0, "");
      }
      if (selectedTab && DragonCoreService && typeof DragonCoreService.touchTab === "function") {
        DragonCoreService.touchTab(selectedTab);
      }
      syncAllSleepingTabs();
      syncNativeSplitViewState();
      updateHomeMode();
      maybeRedirectPrivateHome(gBrowser.selectedBrowser, getTabURI(selectedTab));
      scheduleShieldRefresh(0);
    };

    const onNativeSplitViewChange = () => {
      syncNativeSplitViewState();
      updateHomeMode();
    };

    const onTabOpen = () => {
      updateHomeMode();
      scheduleTimer(() => {
        syncNativeSplitViewState();
        updateHomeMode();
        syncAllSleepingTabs();
      }, 0);
    };

    const onTabClose = (evt) => {
      const closingTab = evt && evt.target;
      if (splitState.active && (closingTab === splitState.leftTab || closingTab === splitState.rightTab)) {
        deactivateFlexSplitView();
      }
      updateHomeMode();
      scheduleTimer(() => {
        syncNativeSplitViewState();
        updateHomeMode();
        syncAllSleepingTabs();
      }, 0);
    };

    const onTabAttrModified = (evt) => {
      const tab = evt && evt.target;
      if (tab) {
        syncTabSleepingState(tab);
      }
      updateHomeMode();
    };

    const onTabDiscarded = (evt) => {
      const tab = evt && evt.target;
      if (tab) {
        syncTabSleepingState(tab);
      } else {
        syncAllSleepingTabs();
      }
    };

    const onTabRestored = (evt) => {
      const tab = evt && evt.target;
      if (tab) {
        syncTabSleepingState(tab);
      }
      updateHomeMode();
    };

    const progressListener = {
      onLocationChange(webProgress, _request, location) {
        if (webProgress && !webProgress.isTopLevel) {
          return;
        }
        const spec = location && location.spec ? location.spec : "";
        dismissSummonedUrlBar();
        updateHomeMode(spec);
        maybeRedirectPrivateHome(gBrowser.selectedBrowser, spec);
        scheduleShieldRefresh(25);
      },
      onStateChange(webProgress, request, stateFlags) {
        if (webProgress && !webProgress.isTopLevel) {
          return;
        }
        const spec =
          (request && request.URI && request.URI.spec) ||
          getTabURI(gBrowser.selectedTab) ||
          "";
        const lowerSpec = spec.trim().toLowerCase();
        if (
          lowerSpec.startsWith("about:") ||
          lowerSpec.startsWith("chrome:") ||
          lowerSpec.startsWith("resource:")
        ) {
          return;
        }
        const STATE_START = 0x00000001;
        const STATE_STOP = 0x00000010;
        const STATE_IS_NETWORK = 0x00040000;
        if ((stateFlags & STATE_START) && (stateFlags & STATE_IS_NETWORK)) {
          setLoadProgress(12, "loading");
        } else if ((stateFlags & STATE_STOP) && (stateFlags & STATE_IS_NETWORK)) {
          setLoadProgress(100, "done");
          scheduleShieldRefresh(80);
          loadDoneTimer = scheduleTimer(() => {
            loadDoneTimer = null;
            setLoadProgress(0, "");
          }, 260);
        }
      },
      onProgressChange(webProgress, _request, curSelf, maxSelf, curTotal, maxTotal) {
        if (webProgress && !webProgress.isTopLevel) {
          return;
        }
        if (!loadProgressEl || loadProgressEl.getAttribute("data-state") !== "loading") {
          return;
        }
        let ratio = 0;
        if (maxTotal > 0) {
          ratio = curTotal / maxTotal;
        } else if (maxSelf > 0) {
          ratio = curSelf / maxSelf;
        } else {
          return;
        }
        const pct = Math.max(15, Math.min(92, Math.round(ratio * 100)));
        const currentRaw = parseFloat(loadProgressEl.style.getPropertyValue("--dragon-load-pct")) || 0;
        if (pct > currentRaw) {
          loadProgressEl.style.setProperty("--dragon-load-pct", pct + "%");
        }
      },
    };

    const onKeyDown = (evt) => {
      if (!evt) {
        return;
      }
      const key = (evt.key || "").toLowerCase();

      // Ctrl+Alt+S -> Toggle Split-Screen View
      if (evt.ctrlKey && evt.altKey && !evt.shiftKey && !evt.metaKey && key === "s") {
        evt.preventDefault();
        evt.stopPropagation();
        toggleSplitView();
        return;
      }

      // Ctrl+Alt+R -> Toggle Reader Mode
      if (evt.ctrlKey && evt.altKey && !evt.shiftKey && !evt.metaKey && key === "r") {
        evt.preventDefault();
        evt.stopPropagation();
        toggleReaderMode();
        return;
      }

      // Ctrl+L / Ctrl+K / Alt+D / F6 / Ctrl+Shift+L -> Floating URL Bar Summon
      if (
        (evt.ctrlKey && !evt.altKey && !evt.shiftKey && !evt.metaKey && key === "l") ||
        (evt.ctrlKey && !evt.altKey && !evt.shiftKey && !evt.metaKey && key === "k") ||
        (evt.altKey && !evt.ctrlKey && !evt.shiftKey && !evt.metaKey && key === "d") ||
        (!evt.ctrlKey && !evt.altKey && !evt.shiftKey && !evt.metaKey && key === "f6") ||
        (evt.ctrlKey && evt.shiftKey && !evt.altKey && !evt.metaKey && key === "l")
      ) {
        evt.preventDefault();
        evt.stopPropagation();
        summonUrlBar();
        return;
      }

      // Escape dismisses summoned URL bar, open popover, or open utility dock
      if (
        key === "escape" &&
        (root.getAttribute("dragon-urlbar-summoned") === "true" ||
          (urlbarInput && document.activeElement === urlbarInput))
      ) {
        dismissSummonedUrlBar();
      } else if (key === "escape" && activePopover) {
        setActivePopover(null);
      } else if (key === "escape" && isDockExpanded()) {
        setDockExpanded(false);
      }
    };

    if (tabContainer) {
      tabContainer.addEventListener("TabSelect", onTabSelect);
      tabContainer.addEventListener("TabOpen", onTabOpen);
      tabContainer.addEventListener("TabClose", onTabClose);
      tabContainer.addEventListener("TabAttrModified", onTabAttrModified);
      tabContainer.addEventListener("TabBrowserDiscarded", onTabDiscarded);
      tabContainer.addEventListener("SSTabRestored", onTabRestored);
      tabContainer.addEventListener("TabSplitViewActivate", onNativeSplitViewChange);
      tabContainer.addEventListener("TabSplitViewDeactivate", onNativeSplitViewChange);
      tabContainer.addEventListener("SplitViewCreated", onNativeSplitViewChange);
      tabContainer.addEventListener("SplitViewRemoved", onNativeSplitViewChange);
    }

    if (typeof gBrowser.addProgressListener === "function") {
      gBrowser.addProgressListener(progressListener);
    }

    window.addEventListener("keydown", onKeyDown, true);

    // Initial UI wiring
    mountLoadProgressBar();
    mountCornerDock();
    syncAllSleepingTabs();
    syncNativeSplitViewState();
    updateHomeMode();
    maybeRedirectPrivateHome(gBrowser.selectedBrowser, getTabURI(gBrowser.selectedTab));
    scheduleTimer(() => {
      syncNativeSplitViewState();
      updateHomeMode();
      homeModeReady = true;
      maybeRedirectPrivateHome(gBrowser.selectedBrowser, getTabURI(gBrowser.selectedTab));
      refreshShieldUI();
    }, 150);

    // Clean up all listeners & timers on window close
    window.addEventListener(
      "unload",
      () => {
        try {
          if (extFlipAnim) {
            try {
              extFlipAnim.cancel();
            } catch (_cancelErr) {}
            clearExtMorphState(document.getElementById("unified-extensions-button"));
          }
          detachDownloadsView();
          downloadsListRef = null;
          if (shieldRefreshTimer !== null) {
            window.clearTimeout(shieldRefreshTimer);
            shieldRefreshTimer = null;
          }
          if (bookmarksSearchTimer !== null) {
            window.clearTimeout(bookmarksSearchTimer);
            bookmarksSearchTimer = null;
          }
          if (historySearchTimer !== null) {
            window.clearTimeout(historySearchTimer);
            historySearchTimer = null;
          }
          if (downloadsRefreshTimer !== null) {
            window.clearTimeout(downloadsRefreshTimer);
            downloadsRefreshTimer = null;
          }
          if (loadDoneTimer) {
            window.clearTimeout(loadDoneTimer);
            loadDoneTimer = null;
          }
          for (const id of pendingTimers) {
            window.clearTimeout(id);
          }
          pendingTimers.clear();
          if (ServicesRef && ServicesRef.obs) {
            if (shieldStatsObserver) {
              try {
                ServicesRef.obs.removeObserver(shieldStatsObserver, "dragon-stats-changed");
              } catch (_obsErr) {}
              shieldStatsObserver = null;
            }
            if (shieldSettingsObserver) {
              try {
                ServicesRef.obs.removeObserver(shieldSettingsObserver, "dragon-settings-changed");
              } catch (_obsErr) {}
              shieldSettingsObserver = null;
            }
            if (tabsSleptObserver) {
              try {
                ServicesRef.obs.removeObserver(tabsSleptObserver, "dragon-tabs-slept");
              } catch (_obsErr) {}
              tabsSleptObserver = null;
            }
          }
          if (loadProgressEl) {
            loadProgressEl.remove();
            loadProgressEl = null;
          }
          if (onDockDocClick) {
            document.removeEventListener("click", onDockDocClick);
            onDockDocClick = null;
          }
          for (const pop of [shieldPopoverEl, bookmarksPopoverEl, historyPopoverEl, downloadsPopoverEl]) {
            if (pop) {
              pop.remove();
            }
          }
          shieldPopoverEl = null;
          bookmarksPopoverEl = null;
          historyPopoverEl = null;
          downloadsPopoverEl = null;
          if (dockEl) {
            dockEl.remove();
            dockEl = null;
            dockToggleBtn = null;
            dockPanelEl = null;
          }
          shieldBtnEl = null;
          shieldBadgeEl = null;
          bookmarksBtnEl = null;
          historyBtnEl = null;
          downloadsBtnEl = null;

          if (splitState.active) {
            deactivateFlexSplitView();
          }
          if (tabContainer) {
            tabContainer.removeEventListener("TabSelect", onTabSelect);
            tabContainer.removeEventListener("TabOpen", onTabOpen);
            tabContainer.removeEventListener("TabClose", onTabClose);
            tabContainer.removeEventListener("TabAttrModified", onTabAttrModified);
            tabContainer.removeEventListener("TabBrowserDiscarded", onTabDiscarded);
            tabContainer.removeEventListener("SSTabRestored", onTabRestored);
            tabContainer.removeEventListener("TabSplitViewActivate", onNativeSplitViewChange);
            tabContainer.removeEventListener("TabSplitViewDeactivate", onNativeSplitViewChange);
            tabContainer.removeEventListener("SplitViewCreated", onNativeSplitViewChange);
            tabContainer.removeEventListener("SplitViewRemoved", onNativeSplitViewChange);
          }
          if (typeof gBrowser.removeProgressListener === "function") {
            gBrowser.removeProgressListener(progressListener);
          }
          if (urlbarInput) {
            urlbarInput.removeEventListener("focus", onUrlbarFocus);
            urlbarInput.removeEventListener("blur", onUrlbarBlur);
          }
          window.removeEventListener("keydown", onKeyDown, true);
        } catch (err) {
          logError("Cleanup failed", err);
        }
      },
      { once: true }
    );
  }

  // Wait until browser delayed startup finishes so gBrowser and #nav-bar are ready
  if (window.gBrowserInit && window.gBrowserInit.delayedStartupFinished && window.gBrowser) {
    initDragonChrome();
  } else {
    let obsRegistered = false;
    const startupObserver = {
      observe(subject, topic) {
        if (topic === "browser-delayed-startup-finished" && subject === window) {
          if (obsRegistered && ServicesRef && ServicesRef.obs) {
            try {
              ServicesRef.obs.removeObserver(startupObserver, "browser-delayed-startup-finished");
            } catch (_err) {}
            obsRegistered = false;
          }
          initDragonChrome();
        }
      },
    };

    if (ServicesRef && ServicesRef.obs) {
      try {
        ServicesRef.obs.addObserver(startupObserver, "browser-delayed-startup-finished", false);
        obsRegistered = true;
      } catch (_err) {}
    }

    window.addEventListener(
      "load",
      () => {
        if (!initialized && window.gBrowser) {
          if (obsRegistered && ServicesRef && ServicesRef.obs) {
            try {
              ServicesRef.obs.removeObserver(startupObserver, "browser-delayed-startup-finished");
            } catch (_err) {}
            obsRegistered = false;
          }
          initDragonChrome();
        }
      },
      { once: true }
    );
  }
})();
