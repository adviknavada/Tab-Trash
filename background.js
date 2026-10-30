const VISIT_WINDOW_DAYS = 30;
const VISIT_KEEP_MIN = 2;
const RESTORE_PROTECT_MIN = 1;
const PROTECTED_MAX_AGE_DAYS = 180;
const PROTECTED_MAX_COUNT = 200;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CLEANUP_ALARM = "trash-cleanup";
const TRACKING_PARAM_NAMES = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "_ga",
]);

console.log("Tab Trash service worker started");
chrome.runtime.onInstalled.addListener(() => {
  console.log("onInstalled fired");
});
chrome.runtime.onStartup.addListener(() => {
  console.log("onStartup fired");
});

function tabKey(tabId) {
  return `tab:${tabId}`;
}

function normalizeUrl(url) {
  try {
    const normalized = new URL(url);
    normalized.hash = "";

    for (const name of [...normalized.searchParams.keys()]) {
      if (name.toLowerCase().startsWith("utm_") || TRACKING_PARAM_NAMES.has(name.toLowerCase())) {
        normalized.searchParams.delete(name);
      }
    }

    return normalized.toString();
  } catch {
    return url;
  }
}

async function saveTab(tab) {
  await chrome.storage.session.set({
    [tabKey(tab.id)]: {
      url: tab.url || tab.pendingUrl || "", // url can be empty while a tab is still loading
      title: tab.title || "",
    },
  });
}

async function seedLiveMap() {
  const tabs = await chrome.tabs.query({}); // {} = no filter = all tabs, all windows
  for (const tab of tabs) {
    await saveTab(tab);
  }
  console.log(`Seeded live map with ${tabs.length} tabs`);
}
chrome.runtime.onInstalled.addListener(seedLiveMap);
chrome.runtime.onStartup.addListener(seedLiveMap);
chrome.tabs.onCreated.addListener(saveTab);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.title) {
    saveTab(tab);
  }
});

function isCertainJunk(entry) {
  const url = entry.url;
  if (!url) return true;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("about:")
  );
}

function isSearchResultsPage(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const searchHosts = [
      "google.com",
      "bing.com",
      "duckduckgo.com",
      "search.yahoo.com",
      "search.brave.com",
      "ecosia.org",
      "yandex.com",
      "yandex.ru",
    ];
    const isSearchHost = searchHosts.some((suffix) =>
      host === suffix || host.endsWith(`.${suffix}`)
    );
    if (!isSearchHost) return false;

    const searchParams = ["q", "query", "p", "text", "search_query"];
    return searchParams.some((name) => parsed.searchParams.has(name));
  } catch {
    return false;
  }
}

async function visitScore(url) {
  try {
    const normalizedUrl = normalizeUrl(url);
    const cutoff = Date.now() - VISIT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const visits = await chrome.history.getVisits({ url: normalizedUrl });
    const score = visits.filter(
      (visit) =>
        visit.visitTime >= cutoff && visit.transition !== "reload"
    ).length;
    console.log(`Visit score for ${normalizedUrl}: ${score}`);
    return score;
  } catch (error) {
    console.log("Visit history unavailable; keeping tab:", error);
    return null;
  }
}

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  const key = tabKey(tabId);
  const flag = flagKey(tabId);

  const result = await chrome.storage.session.get([key, flag]);
  const entry = result[key];
  const isFlagged = Boolean(result[flag]);

  if (!entry) {
    console.log(`Discarding tab ${tabId}: no saved tab data`);
  } else if (isFlagged) {
    if (!entry.url) {
      console.log(`Discarding tab ${tabId}: flagged tab has no URL`);
    } else {
      console.log(`Keeping tab ${tabId}: flagged`);
      await saveTrashEntry(entry, tabId);
    }
  } else if (!entry.url) {
    console.log(`Discarding tab ${tabId}: no URL`);
  } else if (isCertainJunk(entry)) {
    console.log(`Discarding tab ${tabId}: internal page`);
  } else {
    const score = await visitScore(entry.url);
    if (score === null) {
      console.log(`Keeping tab ${tabId}: visit score unavailable`);
      await saveTrashEntry(entry, tabId);
    } else if (score >= VISIT_KEEP_MIN) {
      console.log(`Keeping tab ${tabId}: visit score ${score} >= ${VISIT_KEEP_MIN}`);
      await saveTrashEntry(entry, tabId);
    } else if (isSearchResultsPage(normalizeUrl(entry.url))) {
      console.log(`Discarding tab ${tabId}: search results page`);
    } else {
      console.log(`Keeping tab ${tabId}: default rule; visit score ${score}`);
      await saveTrashEntry(entry, tabId);
    }
  }
  await chrome.storage.session.remove([key, flag]);
});

async function saveTrashEntry(entry, tabId) {
  const closedAt = Date.now();
  const normalizedUrl = normalizeUrl(entry.url);
  const restoreKey = `restore:${normalizedUrl}`;
  const restoreData = await chrome.storage.local.get(restoreKey);
  const restoreCount = restoreData[restoreKey]?.count || 0;
  const protectedEntry = restoreCount >= RESTORE_PROTECT_MIN;

  console.log(
    `Saving ${normalizedUrl}: protected=${protectedEntry}, restore count=${restoreCount}`
  );
  await chrome.storage.local.set({
    [`trash:${closedAt}:${tabId}`]: {
      url: entry.url,
      title: entry.title,
      closedAt,
      ...(protectedEntry ? { protected: true } : {}),
    },
  });
}

async function cleanupTrash() {
  const all = await chrome.storage.local.get(null);
  const cutoff = Date.now() - RETENTION_MS;
  const protectedCutoff =
    Date.now() - PROTECTED_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const trashEntries = Object.entries(all).filter(([key]) =>
    key.startsWith("trash:")
  );
  const expiredKeys = trashEntries
    .filter(([key, value]) => {
      if (value.protected) return value.closedAt < protectedCutoff;
      return value.closedAt < cutoff;
    })
    .map(([key]) => key);
  const remainingProtected = trashEntries
    .filter(([key, value]) => !expiredKeys.includes(key) && value.protected)
    .sort(([, a], [, b]) => a.closedAt - b.closedAt);
  const excessProtected = remainingProtected
    .slice(0, Math.max(0, remainingProtected.length - PROTECTED_MAX_COUNT))
    .map(([key]) => key);
  const keysToRemove = [...expiredKeys, ...excessProtected];

  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }
  console.log(
    `Cleanup removed ${expiredKeys.length} expired and ${excessProtected.length} excess protected entries`
  );
}
async function ensureCleanupAlarm() {
  const existing = await chrome.alarms.get(CLEANUP_ALARM);
  if (!existing) {
    await chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: 60 });
  }
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CLEANUP_ALARM) {
    cleanupTrash();
  }
});
ensureCleanupAlarm();
chrome.runtime.onStartup.addListener(cleanupTrash);

function flagKey(tabId) {
  return `flag:${tabId}`;
}
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "flag-tab") return;
  if (!tab || tab.id === undefined) return;

  const key = flagKey(tab.id);
  const existing = await chrome.storage.session.get(key);

  if (existing[key]) {
    await chrome.storage.session.remove(key);
    await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
  } else {
    await chrome.storage.session.set({ [key]: true });
    await chrome.action.setBadgeText({ tabId: tab.id, text: "★" });
  }
});
