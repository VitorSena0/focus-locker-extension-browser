const IPV4_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;
const DOMAIN_REGEX = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

function stripPort(hostname) {
  const index = hostname.indexOf(":");
  if (index === -1) {
    return hostname;
  }
  return hostname.slice(0, index);
}

export function normalizeDomain(raw) {
  if (typeof raw !== "string") {
    return null;
  }

  let input = raw.trim().toLowerCase();
  if (!input) {
    return null;
  }

  if (!input.startsWith("http://") && !input.startsWith("https://")) {
    input = `https://${input}`;
  }

  let hostname;
  try {
    const url = new URL(input);
    hostname = stripPort(url.hostname.replace(/\.$/, "")).trim();
  } catch {
    return null;
  }

  if (!hostname) {
    return null;
  }

  if (hostname.startsWith("www.")) {
    hostname = hostname.slice(4);
  }

  if (hostname === "localhost") {
    return hostname;
  }

  if (IPV4_REGEX.test(hostname)) {
    const valid = hostname
      .split(".")
      .every((part) => Number(part) >= 0 && Number(part) <= 255);
    return valid ? hostname : null;
  }

  if (!DOMAIN_REGEX.test(hostname)) {
    return null;
  }

  if (!hostname.includes(".")) {
    return null;
  }

  return hostname;
}

export function normalizeWhitelist(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];

  for (const item of entries) {
    const domain = normalizeDomain(item);
    if (!domain || seen.has(domain)) {
      continue;
    }
    seen.add(domain);
    normalized.push(domain);
  }

  return normalized;
}

export function hostnameFromUrl(urlString) {
  if (typeof urlString !== "string") {
    return null;
  }

  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isAllowedHostname(hostname, whitelist) {
  if (!hostname || !Array.isArray(whitelist) || whitelist.length === 0) {
    return false;
  }

  const lower = hostname.toLowerCase();
  return whitelist.some((domain) => {
    if (lower === domain) {
      return true;
    }
    return lower.endsWith(`.${domain}`);
  });
}

export function isAllowedUrl(urlString, whitelist) {
  const hostname = hostnameFromUrl(urlString);
  if (!hostname) {
    return false;
  }
  return isAllowedHostname(hostname, whitelist);
}

export function isNavigableHttpUrl(urlString) {
  if (typeof urlString !== "string") {
    return false;
  }
  return urlString.startsWith("http://") || urlString.startsWith("https://");
}
