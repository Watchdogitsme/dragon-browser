/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const DEFAULT_ENGINES = {
  google: {
    id: "google",
    name: "Google",
    template: "https://www.google.com/search?q={q}",
    homeUrl: "https://www.google.com/",
    prefixes: ["@google", "!g"],
  },
  duckduckgo: {
    id: "duckduckgo",
    name: "DuckDuckGo",
    template: "https://duckduckgo.com/?q={q}",
    homeUrl: "https://duckduckgo.com/",
    prefixes: ["@ddg", "!ddg"],
  },
  brave: {
    id: "brave",
    name: "Brave",
    template: "https://search.brave.com/search?q={q}",
    homeUrl: "https://search.brave.com/",
    prefixes: ["@brave", "!b"],
  },
  bing: {
    id: "bing",
    name: "Bing",
    template: "https://www.bing.com/search?q={q}",
    homeUrl: "https://www.bing.com/",
    prefixes: ["@bing"],
  },
  startpage: {
    id: "startpage",
    name: "Startpage",
    template: "https://www.startpage.com/do/search?q={q}",
    homeUrl: "https://www.startpage.com/",
    prefixes: ["@sp"],
  },
  custom: {
    id: "custom",
    name: "Custom",
    template: "",
    homeUrl: "https://www.google.com/",
    prefixes: [],
  },
};

export const DEFAULT_AI_TARGETS = {
  gemini: {
    id: "gemini",
    name: "Gemini",
    template: "https://gemini.google.com/app#dragon_q={q}",
    homeUrl: "https://gemini.google.com/app",
    prefixes: ["@gemini", "!gm"],
  },
  claude: {
    id: "claude",
    name: "Claude",
    template: "https://claude.ai/new?q={q}",
    homeUrl: "https://claude.ai/new",
    prefixes: ["@claude", "!cl"],
  },
  chatgpt: {
    id: "chatgpt",
    name: "ChatGPT",
    template: "https://chatgpt.com/?q={q}&hints=search",
    homeUrl: "https://chatgpt.com/",
    prefixes: ["@gpt", "@chatgpt", "!gpt"],
  },
  perplexity: {
    id: "perplexity",
    name: "Perplexity",
    template: "https://www.perplexity.ai/search?q={q}",
    homeUrl: "https://www.perplexity.ai/",
    prefixes: ["@perp", "@perplexity", "!p"],
  },
};

const PREFIX_MAP = new Map();
for (const engine of Object.values(DEFAULT_ENGINES)) {
  for (const prefix of engine.prefixes) {
    PREFIX_MAP.set(prefix.toLowerCase(), { mode: "search", engineId: engine.id });
  }
}
for (const target of Object.values(DEFAULT_AI_TARGETS)) {
  for (const prefix of target.prefixes) {
    PREFIX_MAP.set(prefix.toLowerCase(), { mode: "ai", engineId: target.id });
  }
}

function isValidHttpUrl(candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) {
    return false;
  }
  try {
    const parsed = new URL(candidate.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidIpv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return false;
  }
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    const num = Number(part);
    if (num < 0 || num > 255) {
      return false;
    }
  }
  return true;
}

function detectDirectUrl(rawInput) {
  const trimmed = typeof rawInput === "string" ? rawInput.trim() : "";
  if (!trimmed || /\s/.test(trimmed)) {
    return null;
  }

  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    try {
      return new URL(trimmed).toString();
    } catch {
      return null;
    }
  }

  if (/^about:[a-z0-9._-]+(?:[?#]\S*)?$/i.test(trimmed)) {
    return trimmed;
  }

  if (/^(?:chrome|resource|file|ftp):\/\/\S+$/i.test(trimmed)) {
    return trimmed;
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^localhost:\d/i.test(trimmed)) {
    const colonIdx = trimmed.indexOf(":");
    const afterColon = trimmed.slice(colonIdx + 1);
    if (!/^\d{1,5}(?:[/?#]|$)/.test(afterColon)) {
      return null;
    }
  }

  const localhostMatch = /^localhost(?::(\d{1,5}))?(?:[/?#]\S*)?$/i.exec(trimmed);
  if (localhostMatch) {
    if (localhostMatch[1]) {
      const port = Number(localhostMatch[1]);
      if (port < 1 || port > 65535) {
        return null;
      }
    }
    return "http://" + trimmed;
  }

  const ipv4Match = /^((?:\d{1,3}\.){3}\d{1,3})(?::(\d{1,5}))?(?:[/?#]\S*)?$/.exec(trimmed);
  if (ipv4Match && isValidIpv4(ipv4Match[1])) {
    if (ipv4Match[2]) {
      const port = Number(ipv4Match[2]);
      if (port < 1 || port > 65535) {
        return null;
      }
    }
    return "http://" + trimmed;
  }

  const ipv6Match = /^\[[0-9a-fA-F:]+\](?::(\d{1,5}))?(?:[/?#]\S*)?$/.exec(trimmed);
  if (ipv6Match) {
    if (ipv6Match[1]) {
      const port = Number(ipv6Match[1]);
      if (port < 1 || port > 65535) {
        return null;
      }
    }
    return "http://" + trimmed;
  }

  const domainMatch =
    /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(?::(\d{1,5}))?(?:[/?#]\S*)?$/i.exec(
      trimmed
    );
  if (domainMatch) {
    const host = domainMatch[1];
    const portStr = domainMatch[2];
    const labels = host.split(".");
    const tld = labels[labels.length - 1];
    const validTld = /^[a-z]{2,24}$/i.test(tld) || /^xn--[a-z0-9-]{2,}$/i.test(tld);
    if (!validTld) {
      return null;
    }
    if (portStr) {
      const port = Number(portStr);
      if (port < 1 || port > 65535) {
        return null;
      }
    }
    try {
      return new URL("https://" + trimmed).toString();
    } catch {
      return null;
    }
  }

  return null;
}

function parsePrefix(trimmed) {
  if (!trimmed) {
    return null;
  }
  const firstChar = trimmed[0];
  if (firstChar !== "@" && firstChar !== "!") {
    return null;
  }
  const match = /^([@!][a-z]+)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) {
    return null;
  }
  const token = match[1].toLowerCase();
  const target = PREFIX_MAP.get(token);
  if (!target) {
    return null;
  }
  return {
    mode: target.mode,
    engineId: target.engineId,
    query: (match[2] || "").trim(),
  };
}

function deriveHomeUrl(template, fallbackHomeUrl) {
  if (isValidHttpUrl(template)) {
    try {
      const parsed = new URL(template.replaceAll("{q}", ""));
      return parsed.origin + "/";
    } catch {
      // Fall through
    }
  }
  return fallbackHomeUrl || "https://www.google.com/";
}

function buildUrlFromTemplate(template, query, fallbackHomeUrl) {
  const cleanQuery = typeof query === "string" ? query.trim() : "";
  if (!cleanQuery) {
    return fallbackHomeUrl || deriveHomeUrl(template, "https://www.google.com/");
  }

  const encoded = encodeURIComponent(cleanQuery);
  let url;
  if (typeof template === "string" && template.includes("{q}")) {
    url = template.replaceAll("{q}", encoded);
  } else if (isValidHttpUrl(template)) {
    const separator = template.includes("?") ? "&" : "?";
    url = template + separator + "q=" + encoded;
  } else {
    url = DEFAULT_ENGINES.google.template.replaceAll("{q}", encoded);
  }

  if (!isValidHttpUrl(url)) {
    return DEFAULT_ENGINES.google.template.replaceAll("{q}", encoded);
  }
  return url;
}

function getEngineTemplate(engineId, settings) {
  if (engineId === "custom") {
    const customUrl =
      settings && typeof settings.customSearchUrl === "string"
        ? settings.customSearchUrl.trim()
        : "";
    if (isValidHttpUrl(customUrl.replaceAll("{q}", "test"))) {
      return {
        engineId: "custom",
        template: customUrl,
        homeUrl: deriveHomeUrl(customUrl, DEFAULT_ENGINES.google.homeUrl),
      };
    }
    return {
      engineId: "google",
      template: DEFAULT_ENGINES.google.template,
      homeUrl: DEFAULT_ENGINES.google.homeUrl,
    };
  }

  const engine = DEFAULT_ENGINES[engineId] || DEFAULT_ENGINES.google;
  return {
    engineId: engine.id,
    template: engine.template,
    homeUrl: engine.homeUrl,
  };
}

function getAiTemplate(targetId, settings) {
  const defaults = DEFAULT_AI_TARGETS[targetId] || DEFAULT_AI_TARGETS.gemini;
  const configured =
    settings &&
    settings.aiTargets &&
    typeof settings.aiTargets[defaults.id] === "string"
      ? settings.aiTargets[defaults.id].trim()
      : "";

  const template =
    configured && isValidHttpUrl(configured.replaceAll("{q}", "test"))
      ? configured
      : defaults.template;

  return {
    engineId: defaults.id,
    template,
    homeUrl: defaults.homeUrl,
  };
}

function resolveQuery(rawInput, requestedEngineId, settings) {
  const trimmed = typeof rawInput === "string" ? rawInput.trim() : "";
  const normalizedEngineId =
    typeof requestedEngineId === "string" ? requestedEngineId.trim().toLowerCase() : "";

  const prefixMatch = parsePrefix(trimmed);
  if (prefixMatch) {
    if (prefixMatch.mode === "ai") {
      const ai = getAiTemplate(prefixMatch.engineId, settings);
      return {
        url: buildUrlFromTemplate(ai.template, prefixMatch.query, ai.homeUrl),
        mode: "ai",
        engineId: ai.engineId,
      };
    }
    const engine = getEngineTemplate(prefixMatch.engineId, settings);
    return {
      url: buildUrlFromTemplate(engine.template, prefixMatch.query, engine.homeUrl),
      mode: "search",
      engineId: engine.engineId,
    };
  }

  if (
    normalizedEngineId &&
    Object.prototype.hasOwnProperty.call(DEFAULT_AI_TARGETS, normalizedEngineId)
  ) {
    const ai = getAiTemplate(normalizedEngineId, settings);
    return {
      url: buildUrlFromTemplate(ai.template, trimmed, ai.homeUrl),
      mode: "ai",
      engineId: ai.engineId,
    };
  }

  const directUrl = detectDirectUrl(trimmed);
  if (directUrl) {
    return {
      url: directUrl,
      mode: "url",
      engineId: "direct",
    };
  }

  const fallbackEngineId =
    (normalizedEngineId &&
    Object.prototype.hasOwnProperty.call(DEFAULT_ENGINES, normalizedEngineId)
      ? normalizedEngineId
      : "") ||
    (settings && typeof settings.defaultEngine === "string"
      ? settings.defaultEngine.toLowerCase()
      : "") ||
    "google";

  const engine = getEngineTemplate(fallbackEngineId, settings);
  return {
    url: buildUrlFromTemplate(engine.template, trimmed, engine.homeUrl),
    mode: "search",
    engineId: engine.engineId,
  };
}

function getEngines(settings) {
  const customUrl =
    settings && typeof settings.customSearchUrl === "string"
      ? settings.customSearchUrl.trim()
      : "";

  const result = {};
  for (const [id, engine] of Object.entries(DEFAULT_ENGINES)) {
    result[id] = {
      id: engine.id,
      name: engine.name,
      template: id === "custom" ? customUrl : engine.template,
      prefixes: engine.prefixes.slice(),
    };
  }
  return result;
}

function getAiTargets(settings) {
  const result = {};
  for (const [id, target] of Object.entries(DEFAULT_AI_TARGETS)) {
    const configured =
      settings && settings.aiTargets && typeof settings.aiTargets[id] === "string"
        ? settings.aiTargets[id].trim()
        : "";
    result[id] = {
      id: target.id,
      name: target.name,
      template: configured || target.template,
      prefixes: target.prefixes.slice(),
    };
  }
  return result;
}

function getDefaultAiTargetUrls() {
  return {
    gemini: DEFAULT_AI_TARGETS.gemini.template,
    claude: DEFAULT_AI_TARGETS.claude.template,
    chatgpt: DEFAULT_AI_TARGETS.chatgpt.template,
    perplexity: DEFAULT_AI_TARGETS.perplexity.template,
  };
}

export const DragonSearchRouter = {
  DEFAULT_ENGINES,
  DEFAULT_AI_TARGETS,
  detectDirectUrl,
  parsePrefix,
  resolveQuery,
  getEngines,
  getAiTargets,
  getDefaultAiTargetUrls,
};
