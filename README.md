# Tab Heatmap

Color-coded tab bar by recency and use frequency. Fade cold tabs, glow hot ones, close stale tabs in one click.

> Status: **v0.1.0 — scaffold**. Features ship every 15 minutes via an autonomous agent. See `ROADMAP.md` for what's next.

## Install (dev)

```
git clone https://github.com/Sanjays2402/tab-heatmap.git
cd tab-heatmap
```

Then in Chrome: `chrome://extensions` → Developer mode → "Load unpacked" → select this folder.

## Permissions

- `tabs`
- `storage`
- `alarms`


## Roadmap

- [ ] MV3 manifest + service worker scaffolding
- [ ] Track tab last-accessed timestamp in chrome.storage.session
- [ ] Track per-tab activation count
- [ ] Popup UI: list all tabs with heat score (recency × frequency)
- [ ] Color gradient: cold blue → warm amber → hot red
- [ ] One-click 'Close all tabs idle > N days'
- [ ] Configurable thresholds in options page
- [ ] Group tabs by host with rollup heat score
- [ ] Export tab snapshot to JSON
- [ ] Restore tab snapshot from JSON
- [ ] Keyboard shortcut: jump to hottest tab
- [ ] Pinned tabs always excluded from cold-close
- [ ] Per-domain heat decay rate
- [ ] Liquid-glass popup UI (frosted, Phosphor icons)
- [ ] Dark/light theme with auto detection

## License

MIT — see [LICENSE](LICENSE).
