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
- [ ] Export tab snapshot to JSON
- [ ] Restore tab snapshot from JSON
- [ ] Keyboard shortcut: jump to hottest tab
- [ ] Pinned tabs always excluded from cold-close
- [ ] Per-domain heat decay rate
- [ ] Liquid-glass popup UI (frosted, Phosphor icons)
- [ ] Dark/light theme with auto detection
