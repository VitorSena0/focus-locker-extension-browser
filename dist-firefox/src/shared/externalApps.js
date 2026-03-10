export function normalizeExternalApps(input) {
  let rawList = [];
  if (Array.isArray(input)) {
    rawList = input;
  } else if (typeof input === "string") {
    rawList = input.split(/\n|,/);
  }

  const seen = new Set();
  const result = [];
  for (const entry of rawList) {
    const name = String(entry ?? "").trim();
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(name);
  }

  return result.slice(0, 50);
}
