# Nixie — Feature Build Plan

## Scope (this build)

1. **Calibration drawer** — one settings home, persisted, with backup/restore/reset.
2. **24-hour clock + optional seconds** — live setting, timer modes always keep seconds.
3. **T-Minus countdowns** — add/delete events, nearest event on the date plate.
4. **Honest status chip** — online/offline, battery, timer state.
5. **Console** — `Ctrl/Cmd+K` command palette, fuzzy commands, calculator, and calculator rows in the search bar.
6. **Brave Shields telemetry** — live blocked/bandwidth/time totals from the active Brave profile, on the date rail, with auto-detection and a manual path override.

## Explicit non-goals

Weather, task due dates, toolbar badge, notifications, search-engine bangs, focus stats, and new remote host permissions. The only host addition is local `file:///*` so the extension can read Brave's Preferences file. No visual redesign; the chassis, tubes, and plasma language stay.

## Data

- `nixie.settings` → `{ clock24, showSeconds, theme, dim, alarmTone, alarmVolume, searchEngine, suggestions }`
- `nixie.events` → `[{ id, label, date: 'YYYY-MM-DD', time: 'HH:MM' | '' }]`
- `nixie.shields` → `{ enabled: boolean, path: string }` — local-only, machine-specific, excluded from archives.
- Existing keys (`sites`, `nixie.tasks`, `nixie.timers`, `nixie.alarm`) are unchanged.
- Storage uses `chrome.storage.local` when the extension runs, `localStorage` for `file://` testing.
- Shields are read from Brave's `brave.stats` (`ads_blocked`, `bandwidth_saved_bytes`); time saved uses Brave's 50 ms/item estimate.

## Acceptance criteria

- [x] Calibration opens from the gear and `,`; all controls save live; Esc/backdrop/close works; focus is restored.
- [x] 12/24h and seconds toggles re-render immediately; AM/PM only appears in 12h clock mode; timer/focus always show seconds.
- [x] Theme changes recolour tubes, glows, focus rings, and accents; dim mode reduces the whole chassis without hiding dialogs.
- [x] Alarm tone/volume changes are used by the page preview, the local fallback, and the offscreen alarm.
- [x] T-Minus add/delete works, persists, shows the nearest upcoming event on the date plate, and handles date-only + timed events.
- [x] Status chip shows ONLINE/OFFLINE, battery %, and timer/alarm state; updates without layout thrash.
- [x] Console opens with Ctrl/Cmd+K (and `:`), lists fuzzy commands, executes timer/focus/task/theme/open/search/settings/toggles.
- [x] Calculator works in the console and the search bar; Enter copies the result; no `eval`; invalid math is ignored.
- [x] Export produces JSON; import validates and restores settings/sites/tasks/countdowns; reset requires a second press.
- [x] Shields rail shows live blocked/bandwidth/time totals from the active Brave profile; auto-detects, accepts a manual path, polls every 12s, and hides cleanly when disabled.
- [x] Detection prefers the most recently active Brave profile and falls back to the highest counter; a missing/locked Preferences file shows a clear error without breaking the page.
- [x] Shields path stays local, is excluded from archives, and reset re-arms auto-detection.
- [x] No regressions: keys, manifest, timer, alarm, search suggestions, and keyboard shortcuts still work.
- [x] Works at 1440×900, 1280×800, 1024×768, 390×844, and reduced motion.

## Tasks

- [x] T001 — Write plan and inspect existing code/CSS.
- [x] T002 — Shared pure helpers (`core.js`) + tests. *(subagent)*
- [x] T003 — Settings-aware offscreen alarm tone/volume. *(subagent)*
- [x] T004 — HTML: header gear/status, T-Minus readout, calibration dialog, console dialog, core script.
- [x] T005 — CSS: theme tokens, dialogs, settings controls, status variants, T-Minus, console, search calc rows, responsive.
- [x] T006 — JS: settings store/apply/sync, clock format/seconds, theme/dim.
- [x] T007 — JS: T-Minus events + date plate + settings list.
- [x] T008 — JS: honest status chip + battery.
- [x] T009 — JS: search engine setting, calculator suggestions, safe copy.
- [x] T010 — JS: console command engine + keyboard wiring.
- [x] T011 — JS: calibration UI, alarm preview, export/import/reset.
- [x] T012 — Boot integration + cross-tab storage sync.
- [x] T013 — Syntax checks, browser smoke tests, responsive screenshots.
- [x] T014 — Adversarial review + fixes: guarded stale offscreen APIs, cancelled path-save timers on reset/detect, invalidated in-flight polls when telemetry is switched off, and added cross-tab Shields sync.
- [x] T015 — Final delivery summary.

## Risks

| Risk | Mitigation |
|---|---|
| Ctrl+K conflicts with browser address bar | Also support `:`; only intercept when a new tab page has focus. |
| Dialog focus/escape fights existing keydown handler | Native `<dialog>.showModal()` for focus trap; guard console/settings shortcuts. |
| Search suggestions overwrite calculator row | Compose calculator + suggestions in one render path; calculator appears instantly before debounce. |
| Theme looks orange because of hard-coded RGBA glows | Replace orange RGBA with `--plasma-rgb` / `--plasma-core-rgb` tokens. |
| Imported data is malformed | Validate every field; skip invalid sites/events; never throw. |
| Seconds hidden but timer needs them | Visibility is mode-aware: clock obeys setting, timer/focus force seconds. |
| Alarm settings not read by offscreen page | Offscreen re-reads on START_BEEP and on storage changes. |
| T-Minus date-only event expires at midnight | Date-only events are valid through the local day; nextEvent handles this. |
| Shields auto-detect picks an old profile with a bigger counter | Rank by `Local State` `active_time` first, then `last_used`, then counters; keep a manual path override. |
| Shields path debounce races reset or Detect | Clear the pending timer on reset/Detect/Test and resync the input after reset. |
| A poll in flight repaints the rail after telemetry is switched off | Invalidate the request token before saving the toggle and re-check `enabled` before rendering. |
| Offscreen document outlives an extension reload with stale APIs | Guard `chrome.runtime` / `chrome.storage` listeners so the page cannot throw; direct `file://` opens are safe too. |
| Brave's estimate differs slightly from its own stats card | Use Brave's documented 50 ms per blocked item and binary byte units; values are labelled as estimates. |

## Verification

- `node tools/test-core.js` — 38/38 passing.
- `node --check core.js newtab.js offscreen.js sw.js` — clean.
- Live Brave read via `file://`: auto-detection followed the active profile. Profile 1 rendered `64,204` / `1.85 GB` / `54 MIN`; after switching to Default it rendered `170,364` / `4.70 GB` / `2.4 HRS`.
- Checked Shields toggle off/on, invalid path error, Detect, Test Link, console `shields` commands, factory reset, cross-tab storage sync, and the date-rail layout at 1440×900, 1280×800, 1024×768, and 390×844.
- Checked the offscreen alarm page in the extension context and as a direct `file://` open: no uncaught exceptions.
- Browser smoke test against the local server (`localStorage` fallback).
- Checked settings persist after reload, theme/dim, 12/24h, seconds, T-Minus add/delete/undo, status chip, console commands, calculator copy, export/import/reset, invalid-archive rejection, and keyboard shortcuts.
- Reduced-motion CSS disables the telemetry flash and all entrance transitions; no horizontal overflow at any tested width.
