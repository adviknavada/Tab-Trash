const TRACKING_PARAM_NAMES = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "_ga",
]);

function normalizeUrl(url) {
  try {
    const normalized = new URL(url);
    normalized.hash = "";

    for (const name of [...normalized.searchParams.keys()]) {
      const lowerName = name.toLowerCase();
      if (lowerName.startsWith("utm_") || TRACKING_PARAM_NAMES.has(lowerName)) {
        normalized.searchParams.delete(name);
      }
    }

    return normalized.toString();
  } catch {
    return url;
  }
}

function protectionScore(activeMs, restoreCount, visitCount) {
  const activePoints =
    typeof activeMs === "number"
      ? Math.min(activeMs / (60 * 60 * 1000), 1) * 45
      : 0;
  const restorePoints = Math.min(restoreCount / 5, 1) * 30;
  const visitPoints =
    typeof visitCount === "number"
      ? Math.min(visitCount / 10, 1) * 25
      : 0;
  return Math.round(activePoints + restorePoints + visitPoints);
}
