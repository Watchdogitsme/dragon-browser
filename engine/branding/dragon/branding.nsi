# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# NSIS branding definitions for Dragon Browser
# NOTE: BrandShortName is intentionally omitted here because defines.nsi defines it
# from MOZ_APP_DISPLAYNAME; redefining it here causes a fatal NSIS compile error.

!define BrandFullNameInternal "Dragon Browser"
!define BrandFullName         "Dragon Browser"
!define CompanyName           "Dragon Browser"
!define URLInfoAbout          "https://dragonbrowser.local"
!define URLUpdateInfo         "https://dragonbrowser.local"
!define HelpLink              "https://dragonbrowser.local"

!define URLStubDownloadX86     "https://dragonbrowser.local"
!define URLStubDownloadAMD64   "https://dragonbrowser.local"
!define URLStubDownloadAArch64 "https://dragonbrowser.local"
!define URLManualDownload      "https://dragonbrowser.local"
!define URLSystemRequirements  "https://dragonbrowser.local"
!define Channel                "release"

!define CertNameDownload   "Dragon Browser"
!define CertIssuerDownload "Dragon Browser"

# Dialog layout units (matching upstream branding.nsi)
!define PROFILE_CLEANUP_LABEL_TOP       "50u"
!define PROFILE_CLEANUP_LABEL_LEFT      "22u"
!define PROFILE_CLEANUP_LABEL_WIDTH     "175u"
!define PROFILE_CLEANUP_LABEL_HEIGHT    "100u"
!define PROFILE_CLEANUP_LABEL_ALIGN     "left"
!define PROFILE_CLEANUP_CHECKBOX_LEFT   "22u"
!define PROFILE_CLEANUP_CHECKBOX_WIDTH  "175u"
!define PROFILE_CLEANUP_BUTTON_LEFT     "22u"
!define INSTALL_HEADER_TOP              "70u"
!define INSTALL_HEADER_LEFT             "22u"
!define INSTALL_HEADER_WIDTH            "180u"
!define INSTALL_HEADER_HEIGHT           "100u"
!define INSTALL_BODY_LEFT               "22u"
!define INSTALL_BODY_WIDTH              "180u"
!define INSTALL_BLURB_TOP               "137u"
!define INSTALL_BLURB_WIDTH             "60u"
!define INSTALL_FOOTER_TOP              "-48u"
!define INSTALL_FOOTER_WIDTH            "250u"
!define INSTALL_INSTALLING_TOP          "115u"
!define INSTALL_INSTALLING_LEFT         "270u"
!define INSTALL_INSTALLING_WIDTH        "150u"
!define INSTALL_PROGRESS_BAR_TOP        "100u"
!define INSTALL_PROGRESS_BAR_LEFT       "270u"
!define INSTALL_PROGRESS_BAR_WIDTH      "150u"
!define INSTALL_PROGRESS_BAR_HEIGHT     "12u"

!define PROFILE_CLEANUP_CHECKBOX_TOP_MARGIN "12u"
!define PROFILE_CLEANUP_BUTTON_TOP_MARGIN   "12u"
!define PROFILE_CLEANUP_BUTTON_X_PADDING    "80u"
!define PROFILE_CLEANUP_BUTTON_Y_PADDING    "8u"
!define INSTALL_BODY_TOP_MARGIN             "20u"

# Font settings
!define INSTALL_HEADER_FONT_SIZE        20
!define INSTALL_HEADER_FONT_WEIGHT      600
!define INSTALL_INSTALLING_FONT_SIZE    15
!define INSTALL_INSTALLING_FONT_WEIGHT  600

# UI Colors (Obsidian & Ember Crimson)
!define COMMON_TEXT_COLOR               0xF8FAFC
!define COMMON_BACKGROUND_COLOR         0x0B0D12
!define INSTALL_INSTALLING_TEXT_COLOR   0xFFFFFF
; COLORREF is 0x00BBGGRR
!define PROGRESS_BAR_BACKGROUND_COLOR   0x356BFF
