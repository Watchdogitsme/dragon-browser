// ============================================================================
// Dragon Browser — Gecko Engine Configuration (user.js)
// Low-RAM, Consolidated-Process, Zero-Bloat, Privacy-First Defaults
// ============================================================================

// --- Process Consolidation (Balanced IsolateHighValue, Sandboxed) ---
user_pref("fission.autostart", true);
user_pref("fission.webContentIsolationStrategy", 2);
user_pref("dom.ipc.processCount", 2);
user_pref("dom.ipc.processCount.webIsolated", 1);
user_pref("dom.ipc.processCount.file", 1);
user_pref("dom.ipc.processCount.privilegedabout", 1);
user_pref("dom.ipc.processCount.privilegedmozilla", 1);
user_pref("dom.ipc.processCount.inference", 0);
user_pref("dom.ipc.processPrelaunch.enabled", false);
user_pref("dom.ipc.processPrelaunch.fission.number", 0);
user_pref("dom.ipc.keepProcessesAlive.web", 0);
user_pref("dom.ipc.keepProcessesAlive.privilegedabout", 0);
user_pref("dom.ipc.processPriorityManager.enabled", true);
user_pref("dom.ipc.processPriorityManager.backgroundUsesEcoQoS", true);
user_pref("dom.ipc.processPriorityManager.backgroundPerceivableUsesEcoQoS", true);
user_pref("browser.launcherProcess.enabled", false);
user_pref("network.process.enabled", false);
user_pref("media.utility-process.enabled", false);
user_pref("widget.windows.utility_process_file_picker", false);
user_pref("layers.gpu-process.enabled", true);
user_pref("media.rdd-process.enabled", true);
user_pref("browser.newtab.preload", false);
user_pref("browser.startup.homepage.abouthome_cache.enabled", false);
user_pref("browser.newtabpage.disableNewTabAsAddon", true);
user_pref("browser.tabs.remote.warmup.enabled", false);

// --- Low-RAM Caches, BFCache, Image/Media & SpiderMonkey GC ---
user_pref("browser.tabs.unloadOnLowMemory", true);
user_pref("browser.tabs.min_inactive_duration_before_unload", 300000);
user_pref("browser.low_commit_space_threshold_mb", 1024);
user_pref("browser.sessionhistory.max_total_viewers", 1);
user_pref("browser.sessionhistory.max_entries", 20);
user_pref("browser.sessionstore.interval", 60000);
user_pref("browser.sessionstore.max_tabs_undo", 5);
user_pref("browser.sessionstore.max_windows_undo", 2);
user_pref("browser.sessionstore.max_serialize_back", 3);
user_pref("browser.sessionstore.max_serialize_forward", 1);
user_pref("browser.cache.memory.enable", true);
user_pref("browser.cache.memory.capacity", 32768);
user_pref("browser.cache.memory.max_entry_size", 5120);
user_pref("browser.cache.disk.enable", true);
user_pref("browser.cache.disk.smart_size.enabled", false);
user_pref("browser.cache.disk.capacity", 131072);
user_pref("gfx.webrender.all", true);
user_pref("gfx.webrender.precache-shaders", true);
user_pref("gfx.webrender.compositor", true);
user_pref("gfx.webrender.compositor.force-enabled", true);
user_pref("gfx.canvas.accelerated", true);
user_pref("gfx.canvas.accelerated.cache-items", 2048);
user_pref("gfx.canvas.accelerated.cache-size", 64);
user_pref("image.mem.discardable", true);
user_pref("image.mem.decode_bytes_at_a_time", 65536);
user_pref("image.mem.surfacecache.max_size_kb", 65536);
user_pref("image.mem.surfacecache.min_expiration_ms", 15000);
user_pref("image.mem.shared.unmap.min_expiration_ms", 15000);
user_pref("media.memory_cache_max_size", 16384);
user_pref("media.memory_caches_combined_limit_kb", 65536);
user_pref("media.memory_caches_combined_limit_pc_sysmem", 2);
user_pref("media.cache_readahead_limit", 30);
user_pref("media.cache_resume_threshold", 15);
user_pref("javascript.options.mem.nursery.max_kb", 16384);
user_pref("javascript.options.mem.gc_balanced_heap_limits", true);
user_pref("javascript.options.mem.gc_high_frequency_heap_growth_max", 150);
user_pref("memory.ghost_window_timeout_seconds", 20);
user_pref("nglayout.initialpaint.delay", 0);
user_pref("nglayout.initialpaint.delay_in_oopif", 0);
user_pref("content.notify.interval", 100000);

// --- Zero Telemetry & Crash Reporting ---
user_pref("toolkit.telemetry.unified", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("toolkit.telemetry.server", "data:,");
user_pref("toolkit.telemetry.archive.enabled", false);
user_pref("toolkit.telemetry.newProfilePing.enabled", false);
user_pref("toolkit.telemetry.shutdownPingSender.enabled", false);
user_pref("toolkit.telemetry.updatePing.enabled", false);
user_pref("toolkit.telemetry.bhrPing.enabled", false);
user_pref("toolkit.telemetry.firstShutdownPing.enabled", false);
user_pref("toolkit.telemetry.coverage.opt-out", true);
user_pref("toolkit.coverage.opt-out", true);
user_pref("toolkit.coverage.endpoint.base", "");
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.usage.uploadEnabled", false);
user_pref("browser.ping-centre.telemetry", false);
user_pref("browser.newtabpage.activity-stream.telemetry", false);
user_pref("browser.newtabpage.activity-stream.feeds.telemetry", false);
user_pref("breakpad.reportURL", "");
user_pref("browser.tabs.crashReporting.sendReport", false);
user_pref("browser.crashReports.unsubmittedCheck.autoSubmit2", false);

// --- Disable Shield, Normandy Studies & Experiments ---
user_pref("app.shield.optoutstudies.enabled", false);
user_pref("app.normandy.enabled", false);
user_pref("app.normandy.api_url", "");
user_pref("messaging-system.rsexperimentloader.enabled", false);

// --- Disable On-Device AI / ML, Translations, Backup & Background Services ---
user_pref("browser.ml.enable", false);
user_pref("browser.ml.chat.enabled", false);
user_pref("browser.ml.chat.sidebar", false);
user_pref("browser.ml.chat.shortcuts", false);
user_pref("browser.ml.chat.page", false);
user_pref("browser.ml.linkPreview.enabled", false);
user_pref("browser.tabs.groups.smart.enabled", false);
user_pref("browser.tabs.groups.smart.userEnabled", false);
user_pref("browser.ai.control.default", "blocked");
user_pref("browser.smartwindow.enabled", false);
user_pref("browser.translations.enable", false);
user_pref("browser.translations.select.enable", false);
user_pref("browser.backup.enabled", false);
user_pref("browser.backup.scheduled.enabled", false);
user_pref("browser.pagethumbnails.capturing_disabled", true);
user_pref("browser.tabs.hoverPreview.showThumbnails", false);
user_pref("browser.profiles.enabled", false);
user_pref("browser.taskbarTabs.enabled", false);
user_pref("accessibility.force_disabled", 1);
user_pref("dom.push.enabled", false);
user_pref("network.captive-portal-service.enabled", false);
user_pref("network.connectivity-service.enabled", false);
user_pref("browser.safebrowsing.malware.enabled", false);
user_pref("browser.safebrowsing.phishing.enabled", false);
user_pref("browser.safebrowsing.downloads.enabled", false);
user_pref("browser.safebrowsing.downloads.remote.enabled", false);

// --- Disable Pocket, Sponsored Top Sites & Activity Stream Bloat ---
user_pref("extensions.pocket.enabled", false);
user_pref("extensions.pocket.api", "");
user_pref("extensions.pocket.site", "");
user_pref("browser.newtabpage.activity-stream.showSponsored", false);
user_pref("browser.newtabpage.activity-stream.showSponsoredTopSites", false);
user_pref("browser.newtabpage.activity-stream.feeds.section.topstories", false);
user_pref("browser.newtabpage.activity-stream.section.highlights.includePocket", false);
user_pref("browser.newtabpage.activity-stream.feeds.topsites", false);
user_pref("browser.newtabpage.activity-stream.default.sites", "");
user_pref("browser.newtabpage.activity-stream.asrouter.userprefs.cfr.addons", false);
user_pref("browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features", false);
user_pref("browser.topsites.contile.enabled", false);
user_pref("browser.urlbar.quicksuggest.enabled", false);
user_pref("browser.urlbar.suggest.quicksuggest.sponsored", false);
user_pref("browser.urlbar.suggest.quicksuggest.nonsponsored", false);
user_pref("browser.shopping.experience2023.enabled", false);

// --- Disable Firefox View, FxA Nags, Welcome & What's New Pages ---
user_pref("browser.tabs.firefox-view", false);
user_pref("browser.tabs.firefox-view-next", false);
user_pref("identity.fxaccounts.enabled", false);
user_pref("identity.fxaccounts.toolbar.enabled", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("trailhead.firstrun.didSeeAboutWelcome", true);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("startup.homepage_welcome_url", "");
user_pref("startup.homepage_welcome_url.additional", "");
user_pref("startup.homepage_override_url", "");
user_pref("browser.messaging-system.whatsNewPanel.enabled", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.uitour.enabled", false);
user_pref("browser.discovery.enabled", false);
user_pref("extensions.htmlaboutaddons.recommendations.enabled", true);

// --- Lean Network Tuning (No Speculative Prefetch or Bloated Pools) ---
user_pref("network.prefetch-next", false);
user_pref("network.predictor.enabled", false);
user_pref("network.predictor.enable-prefetch", false);
user_pref("network.http.http3.enable", true);
user_pref("network.early-hints.enabled", true);
user_pref("network.http.max-connections", 256);
user_pref("network.http.max-persistent-connections-per-server", 6);
user_pref("network.http.max-urgent-start-excessive-connections-per-host", 5);
user_pref("network.dnsCacheEntries", 400);
user_pref("network.dnsCacheExpiration", 1800);
user_pref("network.ssl_tokens_cache_capacity", 1024);
user_pref("network.dns.disablePrefetch", true);
user_pref("network.dns.disablePrefetchFromHTTPS", true);
user_pref("network.http.speculative-parallel-limit", 0);
user_pref("browser.urlbar.speculativeConnect.enabled", false);
user_pref("browser.places.speculativeConnect.enabled", false);

// --- Privacy Defaults ---
user_pref("browser.contentblocking.category", "strict");
user_pref("dom.security.https_only_mode", true);
user_pref("dom.security.https_only_mode_ever_enabled", true);
user_pref("privacy.donottrackheader.enabled", true);
user_pref("privacy.globalprivacycontrol.enabled", true);
user_pref("privacy.trackingprotection.enabled", true);
user_pref("privacy.trackingprotection.socialtracking.enabled", true);
user_pref("privacy.query_stripping.enabled", true);
user_pref("privacy.query_stripping.enabled.pbmode", true);
user_pref("network.http.referer.XOriginTrimmingPolicy", 2);
user_pref("beacon.enabled", false);

// --- Dragon UI & Feature Flags ---
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);
user_pref("layout.css.corner-shape.enabled", true);
user_pref("browser.tabs.splitView.enabled", true);
user_pref("browser.tabs.inTitlebar", 1);
user_pref("browser.tabs.drawInTitlebar", true);
user_pref("browser.uidensity", 1);
user_pref("browser.compactmode.show", true);
user_pref("browser.toolbars.bookmarks.visibility", "never");
user_pref("layout.css.prefers-color-scheme.content-override", 0);
user_pref("ui.systemUsesDarkTheme", 1);
user_pref("reader.color_scheme", "dark");
user_pref("browser.ctrlTab.sortByRecentlyUsed", true);
user_pref("browser.urlbar.trimURLs", true);
user_pref("browser.tabs.tabClipWidth", 0);
user_pref("browser.display.background_color.dark", "#09090d");
user_pref("browser.display.foreground_color.dark", "#f4f4f8");
user_pref("pdfjs.viewerCssTheme", 2);
user_pref("general.smoothScroll", true);
user_pref("general.smoothScroll.msdPhysics.enabled", true);
user_pref("general.smoothScroll.msdPhysics.continuousMotionMaxDeltaMS", 12);
user_pref("general.smoothScroll.msdPhysics.motionBeginSpringConstant", 600);
user_pref("general.smoothScroll.msdPhysics.regularSpringConstant", 650);
user_pref("general.smoothScroll.msdPhysics.slowdownSpringConstant", 250);
user_pref("mousewheel.min_line_scroll_amount", 10);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("xpinstall.signatures.required", false);

// Native Dragon Home Page
user_pref("browser.startup.homepage", "chrome://dragon/content/home/home.html");
