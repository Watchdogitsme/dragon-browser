/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DragonSettings } from "resource://dragon/DragonSettings.sys.mjs";
import { DragonAdBlock } from "resource://dragon/DragonAdBlock.sys.mjs";

export class DragonContentParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (!message || message.name !== "Dragon:GetPagePolicy") {
      return null;
    }

    const hostname =
      message.data && typeof message.data.hostname === "string"
        ? message.data.hostname
        : "";
    return DragonAdBlock.getPagePolicyForHost(hostname);
  }
}
