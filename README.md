# Tab Trash

Tab Trash is a Chrome extension that keeps a recently closed-tab list, similar
to a recycling bin for browser tabs.

## Features

- Saves eligible closed tabs to a searchable popup.
- Click a tab to restore it in a new browser tab.
- Permanently delete entries with the `×` button.
- Case-insensitive search by tab title or URL.
- Normalizes URLs by removing fragments and common tracking parameters such as
  `utm_*`, `fbclid`, and `gclid`.
- Filters out internal pages such as `chrome://`, `chrome-extension://`, and
  `about:` pages.
- Keeps frequently visited pages based on Chrome History data.
- Supports a keyboard shortcut to flag a tab so it is kept:
  `Alt+Shift+K`.
- Tracks active time while a tab is active in a focused browser window.
- Preserves activity and restore data across extension updates.
- Shows a protection score out of 100 using:
  - 45 points for active time
  - 30 points for restore count
  - 25 points for visit count
- Marks entries as protected when:
  - they have been restored at least once and were active for at least 5
    minutes, or
  - they were active for at least 30 minutes.
- Handles tab ID replacement events, such as prerendered-page swaps.
- Automatically removes ordinary entries after 30 days.
- Keeps protected entries for up to 180 days, subject to a maximum of 200
  protected entries.
- Stores discarded-entry telemetry for 7 days.

## How filtering works

When a tab closes, the first matching rule is used:

1. Flagged tab: keep it if it has a URL.
2. No URL: discard it.
3. Internal page: discard it.
4. Visit history unavailable: keep it.
5. Visit count meets the keep threshold: keep it.
6. Search-results page: discard it.
7. Otherwise: keep it.

Active time is currently measured and scored, but it does not independently
discard a tab.

## Protection score

The score is calculated as:

```text
active time   = up to 45 points, capped at 60 minutes
restore count = up to 30 points, capped at 5 restores
visit count   = up to 25 points, capped at 10 visits
```

The popup recalculates the score using the current restore count and sorts
entries by protected status, score, active time, restore count, and close time.

## Storage

The extension uses Chrome storage with these main record types:

- `tab:<tabId>`: current live-tab information.
- `activity:<tabId>`: active session activity for a tab.
- `metrics:<tabId>`: persistent per-tab activity used across extension updates.
- `trash:<closedAt>:<tabId>`: entries shown in the popup.
- `restore:<normalizedUrl>`: restore count and last restore timestamp.
- `discarded:<closedAt>:<tabId>`: temporary discarded-entry telemetry.

## Installation for development

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the project folder containing `manifest.json`.
5. Reload the extension after changing files.

## Debugging

Open the service worker console from the extension details page. The extension
logs filtering decisions, visit counts, active time, protection state, and
cleanup activity.

To print active-time and lifetime statistics, run:

```js
debugStats()
```

The output includes counts and the 25th percentile, median, and 75th
percentile for both trash entries and discarded records.

## Project structure

- `background.js` — service worker, tab lifecycle, filtering, activity tracking,
  scoring, protection, and cleanup.
- `popup.html` — popup structure.
- `popup.js` — popup loading, searching, restoring, deleting, and rendering.
- `popup.css` — popup styling.
- `shared.js` — shared URL normalization and protection-score logic.
- `manifest.json` — extension metadata, permissions, commands, and icons.
