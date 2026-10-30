const VISIT_WINDOW_DAYS = 30;
const VISIT_KEEP_MIN = 2;
const RESTORE_PROTECT_MIN = 1;
const RESTORE_ACTIVE_PROTECT_MIN_MS = 5 * 60 * 1000;
const ACTIVE_PROTECT_MIN_MS = 30 * 60 * 1000;
const PROTECTED_MAX_AGE_DAYS = 180;
const PROTECTED_MAX_COUNT = 200;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DISCARDED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_ALARM = "trash-cleanup";
importScripts("shared.js");

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

function activityKey(tabId) {
  return `activity:${tabId}`;
}

function persistentActivityKey(tabId) {
  return `metrics:${tabId}`;
}

async function saveTab(tab) {
  await chrome.storage.session.set({
    [tabKey(tab.id)]: {
      url: tab.url || tab.pendingUrl || "", // url can be empty while a tab is still loading
      title: tab.title || "",
    },
  });
}

async function initializeActivity(tab, seeded, createdAt = Date.now()) {
  const active = Boolean(tab.active);
  const focusedWindow = await chrome.windows.getLastFocused();
  const isFocusedActive = active && focusedWindow.id === tab.windowId;
  const pageUrl = normalizeUrl(tab.url || tab.pendingUrl || "");
  const persistentKey = persistentActivityKey(tab.id);
  const stored = await chrome.storage.local.get(persistentKey);
  const previous = stored[persistentKey];
  const now = Date.now();
  const recoveredMs =
    previous?.pageUrl === pageUrl && previous.activeSince !== null
      ? Math.max(0, now - previous.activeSince)
      : 0;
  const activity = {
    totalMs:
      previous?.pageUrl === pageUrl ? (previous.totalMs || 0) + recoveredMs : 0,
    activeSince: isFocusedActive ? now : null,
    createdAt:
      previous?.pageUrl === pageUrl ? previous.createdAt : createdAt,
    seeded: previous?.pageUrl === pageUrl ? previous.seeded : seeded,
    pageUrl,
  };
  await chrome.storage.session.set({ [activityKey(tab.id)]: activity });
  await chrome.storage.local.set({ [persistentKey]: activity });
}

async function seedLiveMap() {
  const tabs = await chrome.tabs.query({}); // {} = no filter = all tabs, all windows
  const seedTime = Date.now();
  for (const tab of tabs) {
    await saveTab(tab);
    await initializeActivity(tab, true, seedTime);
  }
  console.log(`Seeded live map with ${tabs.length} tabs`);
}
chrome.runtime.onInstalled.addListener(seedLiveMap);
chrome.runtime.onStartup.addListener(seedLiveMap);
chrome.tabs.onCreated.addListener(async (tab) => {
  await saveTab(tab);
  await initializeActivity(tab, false);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.title) {
    saveTab(tab);
  }
  if (changeInfo.url) {
    resetActivityForUrlChange(tabId, tab);
  }
});

async function closeActivitySegment(tabId, now = Date.now()) {
  const key = activityKey(tabId);
  const result = await chrome.storage.session.get(key);
  const activity = result[key];
  if (!activity) return null;

  if (activity.activeSince !== null) {
    const elapsedMs = Math.max(0, now - activity.activeSince);
    activity.totalMs += elapsedMs;
    activity.activeSince = null;
    await chrome.storage.session.set({ [key]: activity });
    await persistActivity(tabId, activity);
  }
  return activity;
}

async function persistActivity(tabId, activity) {
  await chrome.storage.local.set({
    [persistentActivityKey(tabId)]: activity,
  });
}

async function startActivitySegment(tabId, windowId, now = Date.now()) {
  const key = activityKey(tabId);
  const result = await chrome.storage.session.get(key);
  const activity = result[key];
  if (!activity || activity.activeSince !== null) return;

  activity.activeSince = now;
  activity.windowId = windowId;
  await chrome.storage.session.set({ [key]: activity });
  await persistActivity(tabId, activity);
}

async function resetActivityForUrlChange(tabId, tab) {
  const key = activityKey(tabId);
  const result = await chrome.storage.session.get(key);
  const activity = result[key];
  if (!activity) return;

  const nextUrl = normalizeUrl(tab.url || tab.pendingUrl || "");
  if (nextUrl === activity.pageUrl) return;

  const now = Date.now();
  const wasActive = activity.activeSince !== null;
  activity.totalMs = 0;
  activity.pageUrl = nextUrl;
  activity.activeSince = wasActive ? now : null;
  await chrome.storage.session.set({ [key]: activity });
  await persistActivity(tabId, activity);
  console.log(`Reset activity for tab ${tabId}: navigated to ${nextUrl}`);
}

async function finalizeActiveActivities() {
  const all = await chrome.storage.session.get(null);
  const activeIds = Object.entries(all)
    .filter(([key, value]) => key.startsWith("activity:") && value.activeSince !== null)
    .map(([key]) => Number(key.slice("activity:".length)));
  for (const tabId of activeIds) {
    await closeActivitySegment(tabId);
  }
}

async function startFocusedWindowActivity(windowId) {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab && tab.id !== undefined) {
    await startActivitySegment(tab.id, windowId);
  }
}

chrome.tabs.onActivated.addListener(async ({ windowId }) => {
  await finalizeActiveActivities();
  const focusedWindow = await chrome.windows.getLastFocused();
  if (focusedWindow.id === windowId) {
    await startFocusedWindowActivity(windowId);
  }
});
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  await finalizeActiveActivities();
  await startFocusedWindowActivity(windowId);
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
  const activity = await closeActivitySegment(tabId);
  const closedAt = Date.now();
  const activeMs = activity ? activity.totalMs : null;
  const lifetimeMs = activity ? Math.max(0, closedAt - activity.createdAt) : null;
  const seeded = activity ? Boolean(activity.seeded) : false;

  const result = await chrome.storage.session.get([key, flag]);
  const entry = result[key];
  const isFlagged = Boolean(result[flag]);
  if (!entry) {
    console.log(`Discarding tab ${tabId}: no saved tab data; activeMs=${activeMs}, lifetimeMs=${lifetimeMs}`);
  } else if (isFlagged) {
    if (!entry.url) {
      console.log(`Discarding tab ${tabId}: rule=no-url; activeMs=${activeMs}, lifetimeMs=${lifetimeMs}`);
      await saveDiscardedEntry(entry, tabId, closedAt, activeMs, lifetimeMs, seeded, "no-url");
    } else {
      console.log(`Keeping tab ${tabId}: rule=flagged; activeMs=${activeMs}, lifetimeMs=${lifetimeMs}`);
      await saveTrashEntry(
        entry,
        tabId,
        closedAt,
        activeMs,
        lifetimeMs,
        seeded,
        null
      );
    }
  } else if (!entry.url) {
    console.log(`Discarding tab ${tabId}: rule=no-url; activeMs=${activeMs}, lifetimeMs=${lifetimeMs}`);
    await saveDiscardedEntry(entry, tabId, closedAt, activeMs, lifetimeMs, seeded, "no-url");
  } else if (isCertainJunk(entry)) {
    console.log(`Discarding tab ${tabId}: rule=internal-page; activeMs=${activeMs}, lifetimeMs=${lifetimeMs}`);
    await saveDiscardedEntry(entry, tabId, closedAt, activeMs, lifetimeMs, seeded, "internal-page");
  } else {
    const score = await visitScore(entry.url);
    if (score === null) {
      console.log(`Keeping tab ${tabId}: rule=visit-unavailable; activeMs=${activeMs}, lifetimeMs=${lifetimeMs}`);
      await saveTrashEntry(
        entry,
        tabId,
        closedAt,
        activeMs,
        lifetimeMs,
        seeded,
        score
      );
    } else if (score >= VISIT_KEEP_MIN) {
      console.log(`Keeping tab ${tabId}: rule=visit-score; activeMs=${activeMs}, lifetimeMs=${lifetimeMs}`);
      await saveTrashEntry(entry, tabId, closedAt, activeMs, lifetimeMs, seeded, score);
    } else if (isSearchResultsPage(normalizeUrl(entry.url))) {
      console.log(`Discarding tab ${tabId}: rule=search-results; activeMs=${activeMs}, lifetimeMs=${lifetimeMs}`);
      await saveDiscardedEntry(entry, tabId, closedAt, activeMs, lifetimeMs, seeded, "search-results");
    } else {
      console.log(`Keeping tab ${tabId}: rule=default; activeMs=${activeMs}, lifetimeMs=${lifetimeMs}`);
      await saveTrashEntry(entry, tabId, closedAt, activeMs, lifetimeMs, seeded, score);
    }
  }
  await chrome.storage.session.remove([key, flag, activityKey(tabId)]);
  await chrome.storage.local.remove(persistentActivityKey(tabId));
});

async function saveTrashEntry(
  entry,
  tabId,
  closedAt,
  activeMs,
  lifetimeMs,
  seeded,
  visitCount
) {
  const normalizedUrl = normalizeUrl(entry.url);
  const restoreKey = `restore:${normalizedUrl}`;
  const restoreData = await chrome.storage.local.get(restoreKey);
  const restoreCount = restoreData[restoreKey]?.count || 0;
  const resolvedVisitCount = visitCount;
  const protectedEntry =
    (restoreCount >= RESTORE_PROTECT_MIN &&
      typeof activeMs === "number" &&
      activeMs >= RESTORE_ACTIVE_PROTECT_MIN_MS) ||
    (typeof activeMs === "number" && activeMs >= ACTIVE_PROTECT_MIN_MS);
  const score = protectionScore(activeMs, restoreCount, resolvedVisitCount);

  console.log(
    `Saving ${normalizedUrl}: protected=${protectedEntry}, protection score=${score}, restore count=${restoreCount}, visits=${resolvedVisitCount}, activeMs=${activeMs}`
  );
  await chrome.storage.local.set({
    [`trash:${closedAt}:${tabId}`]: {
      url: entry.url,
      title: entry.title,
      closedAt,
      activeMs,
      lifetimeMs,
      seeded,
      visitCount: resolvedVisitCount,
      protectionScore: score,
      ...(protectedEntry ? { protected: true } : {}),
    },
  });
}

async function saveDiscardedEntry(
  entry,
  tabId,
  closedAt,
  activeMs,
  lifetimeMs,
  seeded,
  rule
) {
  await chrome.storage.local.set({
    [`discarded:${closedAt}:${tabId}`]: {
      url: entry.url,
      title: entry.title,
      closedAt,
      activeMs,
      lifetimeMs,
      seeded,
      rule,
    },
  });
}

async function cleanupTrash() {
  const all = await chrome.storage.local.get(null);
  const cutoff = Date.now() - RETENTION_MS;
  const protectedCutoff =
    Date.now() - PROTECTED_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const discardedCutoff = Date.now() - DISCARDED_RETENTION_MS;
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
  const expiredDiscarded = Object.entries(all)
    .filter(
      ([key, value]) =>
        key.startsWith("discarded:") && value.closedAt < discardedCutoff
    )
    .map(([key]) => key);
  const keysToRemove = [...expiredKeys, ...excessProtected, ...expiredDiscarded];

  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }
  console.log(
    `Cleanup removed ${expiredKeys.length} expired, ${excessProtected.length} excess protected, and ${expiredDiscarded.length} discarded entries`
  );
}

function percentile(values, percentileValue) {
  if (values.length === 0) return null;
  const index = (values.length - 1) * percentileValue;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return values[lower];
  return values[lower] + (values[upper] - values[lower]) * (index - lower);
}

function summarizeStats(records) {
  const activeValues = records
    .map((record) => record.activeMs)
    .filter((value) => typeof value === "number")
    .sort((a, b) => a - b);
  const lifetimeValues = records
    .map((record) => record.lifetimeMs)
    .filter((value) => typeof value === "number")
    .sort((a, b) => a - b);
  const summarize = (values) => ({
    count: values.length,
    p25: percentile(values, 0.25),
    median: percentile(values, 0.5),
    p75: percentile(values, 0.75),
  });
  return {
    activeMs: summarize(activeValues),
    lifetimeMs: summarize(lifetimeValues),
  };
}

async function debugStats() {
  const all = await chrome.storage.local.get(null);
  const trash = Object.entries(all)
    .filter(([key]) => key.startsWith("trash:"))
    .map(([, value]) => value);
  const discarded = Object.entries(all)
    .filter(([key]) => key.startsWith("discarded:"))
    .map(([, value]) => value);
  const stats = {
    trash: summarizeStats(trash),
    discarded: summarizeStats(discarded),
  };
  console.log("Tab Trash debug stats:", stats);
  return stats;
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
