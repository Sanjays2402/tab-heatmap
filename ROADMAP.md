# Roadmap

This file is the agent's task queue. Unchecked items get implemented in order. When all items are checked, the agent appends a new batch of 10.

- [x] MV3 manifest + service worker scaffolding
- [x] Track tab last-accessed timestamp in chrome.storage.session
- [x] Track per-tab activation count
- [x] Popup UI: list all tabs with heat score (recency × frequency)
- [x] Color gradient: cold blue → warm amber → hot red
- [x] One-click 'Close all tabs idle > N days'
- [x] Configurable thresholds in options page
- [x] Group tabs by host with rollup heat score
- [x] Export tab snapshot to JSON
- [x] Restore tab snapshot from JSON
- [x] Keyboard shortcut: jump to hottest tab
- [x] Pinned tabs always excluded from cold-close
- [x] Per-domain heat decay rate
- [x] Liquid-glass popup UI (frosted, Phosphor icons)
- [x] Dark/light theme with auto detection
- [x] Search/filter tabs in popup by title or URL
- [x] Sort tabs by heat, recency, frequency, or alphabetical
- [x] Hover tooltip showing last-accessed time + activation count
- [x] Bulk-select tabs with checkboxes and close selected
- [x] Heat-score sparkline (last 24h activity per tab)
- [x] Whitelist domains never to mark as cold
- [x] Settings: reset all heat data with confirmation
- [x] Badge on extension icon showing count of cold tabs
- [x] Context menu: 'Mark tab as hot' to boost heat manually
- [x] Audible/muted tab indicator in popup list
- [x] Heat histogram chart for whole window (distribution of cold→hot)
- [x] Suspend cold tabs (discard via chrome.tabs.discard) instead of closing
- [x] Undo last close action with toast notification
- [x] Tab age column showing time since tab was first opened
- [x] Group selector: filter popup by current tab group
- [x] Copy all cold tab URLs to clipboard before closing
- [x] Daily summary notification: 'X cold tabs ready to close'
- [x] Heat trend arrow (rising/falling) next to each tab
- [x] Quick-action chips in popup: Close Cold, Suspend Cold, Pin Hot
- [ ] Per-window heat scoreboard in popup header
