import test from "node:test";
import assert from "node:assert/strict";

import {
  isAllowedHostname,
  isAllowedUrl,
  isNavigableHttpUrl,
  normalizeDomain,
  normalizeWhitelist
} from "../src/shared/whitelist.js";

test("normalizeDomain supports raw domain and url", () => {
  assert.equal(normalizeDomain("youtube.com"), "youtube.com");
  assert.equal(normalizeDomain("https://www.docs.google.com/path"), "docs.google.com");
});

test("normalizeDomain rejects invalid hosts", () => {
  assert.equal(normalizeDomain("not-a-domain"), null);
  assert.equal(normalizeDomain(""), null);
  assert.equal(normalizeDomain("http://"), null);
});

test("normalizeWhitelist deduplicates entries", () => {
  const list = normalizeWhitelist(["youtube.com", "www.youtube.com", "docs.google.com"]);
  assert.deepEqual(list, ["youtube.com", "docs.google.com"]);
});

test("isAllowedHostname accepts domain and subdomains", () => {
  const whitelist = ["youtube.com", "docs.google.com"];
  assert.equal(isAllowedHostname("youtube.com", whitelist), true);
  assert.equal(isAllowedHostname("m.youtube.com", whitelist), true);
  assert.equal(isAllowedHostname("drive.google.com", whitelist), false);
  assert.equal(isAllowedHostname("docs.google.com", whitelist), true);
  assert.equal(isAllowedHostname("mail.docs.google.com", whitelist), true);
});

test("isAllowedUrl only for http/https", () => {
  const whitelist = ["youtube.com"];
  assert.equal(isAllowedUrl("https://youtube.com/watch?v=1", whitelist), true);
  assert.equal(isAllowedUrl("https://news.ycombinator.com", whitelist), false);
  assert.equal(isAllowedUrl("chrome://extensions", whitelist), false);

  assert.equal(isNavigableHttpUrl("https://example.com"), true);
  assert.equal(isNavigableHttpUrl("http://example.com"), true);
  assert.equal(isNavigableHttpUrl("about:blank"), false);
});
