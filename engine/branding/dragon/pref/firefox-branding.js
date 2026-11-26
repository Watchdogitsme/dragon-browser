/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Dragon Browser Default Branding Preferences
// Zero first-run telemetry/welcome redirects and zero background auto-update phoning.

pref("startup.homepage_override_url", "");
pref("startup.homepage_welcome_url", "");
pref("startup.homepage_welcome_url.additional", "");

pref("app.update.auto", false);
pref("app.update.enabled", false);
pref("app.update.interval", 86400);
pref("app.update.download.backgroundInterval", 0);
pref("app.update.url.manual", "https://dragonbrowser.local");
pref("app.update.url.details", "https://dragonbrowser.local");

pref("app.releaseNotesURL", "https://dragonbrowser.local");
pref("app.releaseNotesURL.aboutDialog", "https://dragonbrowser.local");
pref("app.releaseNotesURL.prompt", "https://dragonbrowser.local");
pref("app.vendorURL", "https://dragonbrowser.local");
