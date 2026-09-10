# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

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
