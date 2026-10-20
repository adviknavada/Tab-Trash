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

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  const key = tabKey(tabId);
  const result = await chrome.storage.session.get(key);
  const entry = result[key];
  if (!entry) return;
  if (!isCertainJunk(entry)) {
    const closedAt = Date.now();
    await chrome.storage.local.set({
      [`trash:${closedAt}:${tabId}`]: {
        url: entry.url,
        title: entry.title,
        closedAt,
      },
    });
  }
  await chrome.storage.session.remove(key);
});

const RETENTION_MS = 30*24*60*60*1000; 
const CLEANUP_ALARM = "trash-cleanup";
async function cleanupTrash() {
  const all = await chrome.storage.local.get(null);
  const cutoff = Date.now() - RETENTION_MS;
   const expiredKeys = Object.entries(all)
    .filter(([key, value]) => key.startsWith("trash:") && value.closedAt < cutoff)
    .map(([key]) => key);

  if (expiredKeys.length > 0) {
    await chrome.storage.local.remove(expiredKeys);
  }
  console.log(`Cleanup removed ${expiredKeys.length} expired entries`);
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



