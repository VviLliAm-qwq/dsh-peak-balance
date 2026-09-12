# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.3] - 2026-09-12

### Performance

- **Opening `/hist` no longer waits for a scan.** The plugin reads the
  incremental cache at activation and publishes the grid from it, so the scene
  paints finished numbers on the first frame instead of a spinner; the scan that
  follows only refreshes what changed and leaves the figures on screen (the
  status line gains a `刷新中` / `refreshing` chip) instead of dropping back to a
  loading state. Reading the cache, folding it into records and building the view
  measured 4 ms against the 20–30 ms of an incremental scan.
- **A fully cached scan no longer pays per file.** The loop yielded to the event
  loop and reported progress for *every* file, cached ones included, and each
  report re-rendered the whole scene: 344 files meant 344 round trips and 344
  full re-renders. On this machine's corpus that cost 614–857 ms *inside the TUI*
  for a scan whose actual work was 20 ms, and the grid only appeared when it
  finished. Only a decoded file yields or reports now, and reports are coalesced
  to one per 60 ms — the same cached corpus completes in one turn with a single
  store update.
- **A rebuild checkpoint the cache and survive an interruption.** The cache was
  written once, at the very end, so a host restart or dispose during the
  multi-second first scan threw all of it away; an aborted scan even wrote back
  only the files it had reached, discarding the rest. The scan now checkpoints
  every 64 decoded files and merges instead of truncating when it is cut short,
  so the work already paid for is resumed rather than repeated.

### Fixed

- **An empty `~/.dsh-tui/resume.txt` no longer mutes the status line.** The host
  writes that marker empty both on `/new` and when it exits a session it cannot
  resume (`clearResumeTarget`), so an empty marker is a normal resting state. The
  fallback focus poll re-applied its reading once per second; after a conversation
  claimed the line, the next tick cleared the focus again — and because the
  cleared-focus guard then skipped that conversation's own events, its figure
  stayed `本轮 —` for good. The poll now applies a reading only when the file's
  content or mtime actually changed (`createMarkerWatcher`), so `/new` still gives
  up the line and a resting empty marker does not.
- **`totalTokens` counts cache reads.** `lib/pricing.js` counted `input +
  output`, while `lib/history.js` and the provider's own `totalTokens` count
  `input + cacheRead + cacheWrite + output`. On a sampled real turn the plugin's
  figure was 61,026 against the provider's 31,282,786, and the `tokens <= 0` guard
  in `estimateCostCny` read a cache-only report as "nothing spent" (no figure at
  all). The CNY total was never affected — it prices the buckets directly.
- **A turn that reported no tokens clears the line** instead of leaving the
  previous figure in place under a "this turn" label. About 2.5% of 448 sampled
  real turns end this way (interrupted rounds, tool-only rounds); `forgetSettled`
  drops the remembered figure as well.
- **The balance is labelled with its own currency.** `cnyBalance` falls back to
  the first reported entry, so a USD account rendered as `余额 ¥5.00`; the state
  object now carries `currency` and `formatMoney` picks the matching symbol.
- **A usage report is filed under the tier its request STARTED in.** Bucketing
  used the assistant message's own timestamp — the instant the answer landed —
  while the comment claimed "the request's own timestamp". `step/start` carries
  the request's instant, so a request issued at 11:59 and answered at 12:01 stays
  off-peak. A turn's rates and model now come from its first report
  (`turnModel` / `turnAt`), so a mid-turn `/model` switch or the 2026-09-14
  Pro→Flash route change cannot reprice a whole turn.
- **Subagent spend is folded into the parent turn.** Child sessions
  (`origin: subagent` / `delegationDepth > 0`) were dropped entirely, so a
  delegation-heavy turn under-reported by the child's whole share (6.76% of
  tokens across this machine's logs). Child usage now lands in the parent
  conversation's open turn through `parentSession`, and a background child
  finishing after the turn closed cannot reopen it.

### Changed

- **The status line reports the running turn live.** While a turn is in flight
  the figure is `本轮·计费中 ¥…` (`Turn · live`), refreshed on every usage
  report; the settled `本轮 ¥…` appears once the turn closes. Previously the line
  only ever showed a settled figure, so a turn in progress read `本轮 —` — or,
  worse, the previous turn's number.
- Part order is phase → countdown → turn → balance: a narrow terminal truncates
  the tail, and the balance can also be had from `/balance`, while the turn cost
  is the figure being watched.
- `beginTurn()` (`turn/start`) drops a running bucket left behind by a turn that
  never emitted `turn/end`, so an aborted round cannot be settled into the next
  one.

## [0.3.2] - 2026-09-12

### Added

- **The plugin follows dsh-TUI's `/lang` switch.** The status line, the history
  scene and every command reply now repaint in the host's language the moment it
  changes. dsh-TUI mirrors its choice into its own `dsh-tui` settings namespace,
  and the dsh settings service emits `settings/updated(ns, next, prev, source)`
  on every commit — the plugin subscribes to that (a public Cordis event, no host
  internals) and repaints both surfaces. A 1 s poll of `~/.dsh-tui/lang.json`,
  guarded by an mtime/size stamp, covers hosts that serve no `dsh-tui`
  namespace, so `/lang` still lands within about a second there.
- Startup resolution now matches dsh-TUI's own order: `DSH_TUI_LANG` → the live
  `dsh-tui.lang` setting → `~/.dsh-tui/lang.json` → the OS locale. An ABSENT
  locale keeps the historical `zh`, while any other unsupported locale falls
  back to `en` (a German user must not be handed a Chinese UI), exactly as the
  host does.
- `DSH_PEAK_BALANCE_LANG_FILE` overrides the preference-file path for tests and
  diagnostics, mirroring `DSH_PEAK_BALANCE_FOCUS_FILE`.
- Both READMEs now open with a **language switcher** (`English · 中文` /
  `中文 · English`) and cover the same sections: the Chinese one gained the
  "Publishing and versioning" and "Listing" sections it was missing.

### Changed

- `resolveLang()` is still pure and injectable; the host's live language is read
  separately through `settings.get('dsh-tui')`, so a `/lang` switch made after
  the process started is visible to the plugin.

## [0.3.1] - 2026-09-12

### Fixed

- **The model table's columns drifted on a CJK interface.** Every cell was
  padded by `String#length`, which counts CJK and emoji as ONE cell while a
  terminal draws them as TWO — so the header `总 token` (8 cells, 7 code points)
  pushed every column to its right out of line with its values. Cells are now
  laid out as fixed-width `Box`es (the host pads and right-aligns inside them),
  and every fit/truncate decision uses a cell-accurate width
  (`displayWidth` / `clipWidth`), so a wide label can neither shift a neighbour
  nor spill into it.
- The detail card and the totals rows put their labels in one fixed 12-cell
  column instead of a hand-padded one, so both blocks start their values on the
  same cell; the totals row uses the short label (`子代理` / `subagents`) rather
  than a wide sentence.
- `hit rate` (8 cells) no longer truncates in the English header: the hit-rate
  column gained the cell its gap needs.
- Month labels (`9月` / `Sep` are 3-4 cells in a 2-cell week column) claim the
  next column's empty slot, so the axis stays cell-exact above the grid.

## [0.3.0] - 2026-09-12

### Added

- **`/hist` — the short name that actually runs.** A bare `/th` + Enter cannot
  reach this plugin: dsh-tui's slash-completion overlay executes the HIGHLIGHTED
  suggestion, the merged list is built-ins first, and `theme`/`thinking` both
  match the `th` prefix, so `/th` + Enter switched the theme. `/hist` is a
  prefix of no built-in, so the overlay offers exactly one row and Enter runs it.
  `/th` (with a trailing space) and `/tokenhistory` still work.
- **`alt+h` opens the history scene** from the plain chat state, through
  `ctx.tuiShortcuts` (ctrl/alt required; `alt+h` collides with nothing).
- **`Scene layout` setting** (`card` / `plain`): the card frames the scene in a
  rounded box with section separators and an inline day card; plain drops the
  chrome and spends those 2 rows / 4 columns on content. The card degrades to
  plain by itself when the terminal cannot hold it.
- **Subagent-switch feedback**: a permanent `subagents counted/excluded` chip in
  the title bar, a 1.2 s inversion on the `s` key, and a totals row that spells
  out `excluded N sessions / M reports` (the aggregation now reports what the
  filter dropped instead of discarding it silently).

### Changed

- **The arrows move the SELECTED SQUARE, not the calendar**: `←`/`→` step one
  week column (same weekday), `↑`/`↓` step one weekday row (±1 day) inside the
  column, and a move into a future square or past the grid edge is refused. `t`
  jumps back to today. Previously `←`/`→` were ±1 day and `↑`/`↓` were ±7 days.
- **The selected square is lightened and a `▲` row under the grid points at its
  column**, instead of drawing `[]` inside the tile (which obscured the color
  that carries the data).
- **`m` / `w` / `s` now write back to the settings namespace** (they persist and
  survive a restart) instead of changing only the current viewing session. The
  optimistic local override flips the UI immediately; a refused write keeps the
  change for the session and logs once.
- **Responsive layout**: rows and columns are budgeted explicitly. Width trims
  week columns (with a `showing 27/53w` chip and a window that scrolls one column
  at a time to follow the selection) rather than shrinking squares; height drops
  the model table, then the day card's fields one by one, then the totals. Under
  12 rows or 40 columns the scene switches to a fallback list. Every row is drawn
  with `truncate`, so nothing depends on the host clipping.
- The model table's column widths are computed from the terminal width, numbers
  are right-aligned, and the rate-source column is dropped on a narrow terminal.

## [0.1.11] - 2026-09-12

### Fixed

- **Leaving a conversation and coming back lost its figure.** A settled turn is
  a fact about the CONVERSATION, but it lived only inside the tracker of the
  session object that reported it — and switching away through `/resume`
  disposes that session. Coming back reuses the conversation id with a fresh
  agent, and the host replays the conversation privately (no `session/event`),
  so nothing rebuilt the tracker and the line showed `—`. Settled turns are now
  also remembered by conversation id (bounded, newest 24), which is what the
  line falls back to for a known focus with no live tracker. An unknown or
  cleared focus still never resurrects a conversation, so `/new` keeps showing
  `—`.

## [0.1.10] - 2026-09-12

### Fixed

- **`/new` kept the previous conversation's per-turn figure.** The host starts a
  fresh conversation by EMPTYING its focus marker, which 0.1.9 read as "no
  information" and answered with the last-event fallback — i.e. it put back the
  very conversation the user had just left. An emptied marker is now read as the
  statement it is (`{ state: 'cleared' }`, not `{ state: 'absent' }`): the line
  gives up the figure, and the first conversation that is not the one left
  behind claims it, so a parked conversation finishing a background turn cannot
  take the line back. A marker that cannot be read at all still falls back to the
  last session event, which is what a host that never writes one needs.

### Added

- Regression tests covering a `/new` the fallback poll notices both before and
  after the fresh conversation's first turn lands.

## [0.1.9] - 2026-09-12

### Fixed

- **The per-turn cost belonged to the wrong conversation after a switch.** The
  line followed "the session that appended last", but switching conversations
  publishes no `session/event`: the host replays the target session straight
  into its own projector, and DSH only fires that event for appends the current
  process makes ("constructor seeds do not emit"). Switching therefore left the
  *previous* conversation's figure on screen, and a parked conversation
  settling a background turn stole it back. The line now follows the
  conversation the host reports as focused.
- **Disposing the shown conversation fell back to the stalest tracker.** The
  tracker map keeps recency order (newest last) and the fallback read its first
  key — the *least* recently active conversation. It now moves to the newest
  survivor.
- **A reused session id could leak turn state between agents.** Trackers were
  keyed by session id, and dsh-tui reuses ids ("A → /new → /resume A lands back
  on the same id with a fresh agent"): an abandoned mid-turn got priced into the
  replacement agent's first settled turn, and disposing the parked agent deleted
  the live one's data. Trackers are now keyed by the session object.

### Added

- Focus tracking from two independent sources: the host-mediated
  `tui/session-switched` DecisionEvents notification (exact, used when the host
  mounts its plugin-interop row) and the launcher marker the host rewrites on
  every switch, polled once a second as the fallback. A conversation with no
  settled turn in this process now shows `—` instead of another conversation's
  amount.
- The manifest requires `tui.dsh/v1alpha1#DecisionEvents` as an **optional**
  contract with the fallback spelled out, so a host without the capability
  degrades (`compatible_degraded`) instead of refusing admission. Admission was
  verified against the host's own parser/validator/negotiator.
- `DSH_PEAK_BALANCE_FOCUS_FILE` overrides the marker path for tests and
  diagnostics, and the seam probe line now reports `host=<n>`.
- Regression tests for the switch, the marker fallback, a refusing host, the
  disposal fallback order and the reused-id case. `test-support/harness.js`
  carries the shared fake context for the wiring tests.

## [0.1.8] - 2026-09-10

### Fixed

- **The cost formula under-priced cached turns by several times.** It mirrored
  the host's estimator and treated `cacheReadTokens` as a subset of
  `inputTokens` (`(input − cacheRead) × miss + cacheRead × hit`). The provider
  reports the cache-miss input, the cache-hit input and the output as three
  *disjoint* counts — its `totalTokens` is their sum, and dsh-tui derives its
  cache-hit rate from `cacheRead / (input + cacheRead + cacheWrite)` — so
  clamping one against the other silently dropped most of the miss-priced
  prompt. Measured against a real balance drop: a turn that cost ¥0.20 was
  estimated at ¥0.03 before and ¥0.23 after.

### Added

- A regression test pinning the disjoint semantics (a large cache read must not
  be capped by a small miss count).

## [0.1.7] - 2026-09-10

### Changed

- Plain line: a blank row above it (so it never touches the transcript) and two
  cells of indent, one past the prompt cursor's column. The warning frame keeps
  the two-cell indent but no top gap — it already fills the host's three-row
  budget, and a margin would push its bottom border into the clipped area.

## [0.1.6] - 2026-09-10

### Changed

- The contribution is indented by one cell so it lines up with the prompt's own
  content column instead of hugging the terminal edge. The warning frame shifts
  as a whole, keeping both shapes on the same column.

## [0.1.5] - 2026-09-10

### Fixed

- **The entry module must export exactly `name`, `Config` and `apply`.** With
  its helpers (`seamServices`, `settingsSection`, …) also exported from
  `lib/index.js`, the loader wrapped the activation differently and every
  dsh-tui seam registration from that activation was rejected with
  `requires a live Cordis activation context`: the settings namespace still
  registered (that service does not verify the caller), so the plugin looked
  half-alive — no settings card, no status line. `lib/index.js` is now a shell
  that re-exports those three symbols from `lib/plugin.js`, the same shape the
  shipped TUI plugins use.
- A rich status view refused once (the first tick can land while the seam row is
  still activating) is no longer treated as final: the view is retried and only
  a run of refusals degrades it.

### Added

- `test/entry.test.js` pins the export shape and the manifest→shell wiring.
- Regression tests for the seam-resolution order, a refusing shadow
  placeholder, and the retry-then-give-up status behaviour.

## [0.1.4] - 2026-09-10

### Fixed

- **The plugin registered nothing on a real dsh-tui boot.** Services were
  resolved with the non-strict `ctx.get(name, false)`, which — in compositions
  where the dsh-tui seam rows are shadowed — hands back a placeholder whose
  method calls the host rejects with `requires a live Cordis activation
  context`. The settings namespace still registered (the settings service does
  not verify the caller), so the plugin looked half-alive: no settings card, no
  status line. `seamServices()` now asks strictly first — the form the shipped
  TUI plugins use — and keeps the non-strict accessor only as a fallback, so
  both host shapes resolve. Reported by the 0.1.3 lifecycle log.

### Added

- Regression tests for the seam resolution order and for a refusing shadow
  placeholder, so the bug cannot come back silently.

## [0.1.3] - 2026-09-10

### Added

- A bounded lifecycle log at `~/.dsh-tui/dsh-peak-balance.log`: one line when
  the module is imported, one when `apply()` starts (with pid and file path),
  the resolved config, a probe of which host seams are mounted, the outcome of
  every registration, and the teardown. Diagnosing a silently inert plugin
  previously required guessing; the host's own diagnostics never reach a file.
  The log trims itself to its newest half past 128 KiB and stays untouched
  under `node --test`.

## [0.1.2] - 2026-09-10

### Added

- `DSH_PEAK_BALANCE_FORCE_PEAK=1` diagnostic override: renders the peak
  presentation (and the warning frame) outside a real peak window, so the
  effect can be previewed without waiting for the next 09:00 Beijing. The
  countdown keeps describing the real clock, and the switch is off unless the
  variable is set.

## [0.1.1] - 2026-09-10

### Changed

- The warning-color setting is validated at use time instead of by the settings
  schema, so a stale or hand-edited value in the settings document can no longer
  fail the namespace registration (which would have rendered the card as
  unavailable and left it unrepairable from the UI). Unknown colors fall back to
  red.

## [0.1.0] - 2026-09-10

### Added

- Peak/off-peak billing clock above the prompt (Beijing time, Mon-Fri
  09:00-12:00 and 14:00-18:00), with a live countdown to the next switch.
- Live DeepSeek account balance, refreshed after every completed turn and on a
  60 s background interval.
- Per-turn cost estimate for the turn that just finished, priced with the
  official 2026-09-10 rate card (idle and peak buckets are priced separately by
  each request's own timestamp).
- Warning mode: while the current window is peak, the status contribution turns
  into a three-row frame that pulses in one of seven selectable colors.
- A settings card ("Peak & Balance") on the `/settings` screen with four
  switches: balance display, per-turn cost display, warning mode, warning color.
- Graceful degradation: with no `tuiStatus` / `tuiSettingsSections` service (or
  no credentials) the plugin stays inert instead of failing the host.
