const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be"
]);

export function normalizeMusicUrl(input) {
  const value = String(input ?? "").trim();
  if (!value) {
    return "";
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return "";
  }

  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) {
    return "";
  }

  return url.toString();
}

export function buildYoutubeEmbedUrl(input, origin = "") {
  const value = normalizeMusicUrl(input);
  if (!value) {
    return "";
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return "";
  }

  const host = url.hostname.toLowerCase();
  const list = url.searchParams.get("list");
  let videoId = url.searchParams.get("v") ?? "";

  if (!videoId && host === "youtu.be") {
    videoId = url.pathname.replace("/", "");
  }

  if (url.pathname.startsWith("/embed/")) {
    return decorateEmbedUrl(`https://www.youtube.com${url.pathname}${url.search}`, origin);
  }

  if (list && videoId) {
    return decorateEmbedUrl(`https://www.youtube.com/embed/${videoId}?list=${list}`, origin);
  }

  if (list) {
    return decorateEmbedUrl(`https://www.youtube.com/embed/videoseries?list=${list}`, origin);
  }

  if (videoId) {
    return decorateEmbedUrl(`https://www.youtube.com/embed/${videoId}`, origin);
  }

  return "";
}

function decorateEmbedUrl(rawUrl, origin) {
  let embedUrl;
  try {
    embedUrl = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  embedUrl.searchParams.set("playsinline", "1");
  embedUrl.searchParams.set("rel", "0");
  embedUrl.searchParams.set("modestbranding", "1");
  if (origin && origin.startsWith("http")) {
    embedUrl.searchParams.set("origin", origin);
  }
  return embedUrl.toString();
}
