const listEl = document.getElementById("list");
const searchEl = document.getElementById("search");

let entries = [];
async function loadTrash() {
  const all = await chrome.storage.local.get(null);
  entries = Object.entries(all)
    .filter(([key]) => key.startsWith("trash:"))
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => b.closedAt - a.closedAt); 
}
function timeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function domainOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

async function restore(entry) {
  await chrome.tabs.create({ url: entry.url });
  await chrome.storage.local.remove(entry.key);
  entries = entries.filter((e) => e.key !== entry.key);
  render();
}

async function deleteEntry(entry) {
  await chrome.storage.local.remove(entry.key);
  entries = entries.filter((e) => e.key !== entry.key);
  render();
}

function render() {
  const query = searchEl.value.trim().toLowerCase();

  const shown = entries.filter(
    (e) =>
      e.title.toLowerCase().includes(query) ||
      e.url.toLowerCase().includes(query)
  );

  listEl.replaceChildren();

  if (shown.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = entries.length === 0 ? "Trash is empty." : "No matches.";
    listEl.append(empty);
    return;
  }

  for (const entry of shown) {
    const row = document.createElement("div");
    row.className = "row";

    const details = document.createElement("div");
    details.className = "details";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = entry.title || entry.url;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${domainOf(entry.url)} · ${timeAgo(entry.closedAt)}`;

    details.append(title, meta);

    const deleteButton = document.createElement("button");
    deleteButton.className = "delete";
    deleteButton.type = "button";
    deleteButton.textContent = "×";
    deleteButton.title = "Delete permanently";
    deleteButton.setAttribute("aria-label", "Delete permanently");
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteEntry(entry);
    });

    row.append(details, deleteButton);
    row.addEventListener("click", () => restore(entry));
    listEl.append(row);
  }
}

searchEl.addEventListener("input", render);

loadTrash().then(render);