# dsh-peak-balance

Peak/off-peak billing clock, live DeepSeek account balance and per-turn cost —
rendered above the prompt in [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI).

```
⚡ 峰时 09:00-12:00 · 距谷时 1h23m · 余额 ¥42.10 · 本轮 ¥0.0234
```

While the peak window is active you can turn the line into a three-row frame
that pulses in one of seven colors:

```
╭──────────────────────────────────────────────────────────╮
│ ⚡ 峰时 · 距谷时 1h23m · 余额 ¥42.10 · 本轮 ¥0.0234   ▂▃▄▅▆▇ │
╰──────────────────────────────────────────────────────────╯
```

## Features

| Feature | What it shows |
| --- | --- |
| Peak / off-peak clock | The billing window currently in force and a live countdown to the next price switch (`09:00-12:00` / `14:00-18:00` Beijing time, Monday–Friday; weekends are off-peak all day). |
| Live balance | Your DeepSeek account balance, refreshed after **every completed turn** and once a minute in the background. |
| Per-turn cost | What the turn that just finished cost, in CNY, priced from the official rate card — peak and off-peak usage are priced separately, by each request's own timestamp. |
| Peak-hour warning | Optional. While peak pricing is active the status contribution becomes a rounded frame whose border, phase label and travelling waveform pulse in the chosen color. |
| Settings card | A new **Peak & Balance** card on the `/settings` screen, with its four switches rendered directly on the card — no subpage to open. |

## Install

```sh
# from npm
dsh plugin --profile dsh-tui add dsh-peak-balance

# ...or straight from a checkout of this repository (pnpm packs the local
# directory, so the profile keeps a real copy instead of a symlink)
dsh plugin --profile dsh-tui add file:/absolute/path/to/dsh-peak-balance
```

The command appends the bundle row to the profile's `dsh.profile.bundles`.
Then restart the TUI (`/restart` inside dsh-tui) so the profile loads the new
row; the settings card appears under `/settings` immediately after the restart.

> Installing by symlink (`link:` or a directory junction) is not recommended:
> Node resolves a plugin's real path, and `@deepseek-ai/*` must stay reachable
> from it. `file:` and npm installs both leave a real directory inside the
> profile, which is the layout the host expects.
>
> Updating a `file:` install: pnpm caches a local directory dependency, so
> `add`/`update` alone will **not** pick up edited sources. Remove and re-add
> it (after a version bump) to refresh the profile copy:
>
> ```sh
> dsh plugin --profile dsh-tui remove dsh-peak-balance
> dsh plugin --profile dsh-tui add file:/absolute/path/to/dsh-peak-balance
> ```

## Settings

`/settings` → the **Peak & Balance** card. Edits are written live; no restart is
needed.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| Show balance | boolean | `true` | Show the account balance on the status line. |
| Show per-turn cost | boolean | `true` | Show the estimated cost of the last completed turn. |
| Peak-hour warning | boolean | `false` | Turn the line into a pulsing frame while peak pricing is active. |
| Warning color | select | `red` | Frame color: `red` `orange` `yellow` `green` `cyan` `blue` `purple`. |

The settings live in the `dsh-peak-balance` namespace of the dsh settings
document, so they can also be edited there directly.

## How the numbers are produced

**Peak window.** Off-peak pricing is half of peak pricing; peak hours are
Beijing time (UTC+8) Monday–Friday `09:00-12:00` and `14:00-18:00`, everything
else — including both weekend days — is off-peak.

**Cost.** DeepSeek's API returns token counts, never money, so the per-turn
figure is an **estimate**:

```
cost = (input − cacheRead) × inputMissRate
     + cacheRead × inputHitRate
     + output × outputRate
```

Each provider usage report is filed into the peak or off-peak bucket using the
timestamp of the request that produced it, so a turn straddling a price
boundary is not priced wholesale at the current window.

Embedded rate card (CNY per million tokens), verified **2026-09-10** against
the official [Models & Pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)
page:

| Model | Bucket | Input (cache hit) | Input (cache miss) | Output |
| --- | --- | --- | --- | --- |
| `deepseek-flash` | off-peak | 0.02 | 1 | 4 |
| `deepseek-flash` | peak | 0.04 | 2 | 8 |
| `deepseek-v4-pro` | off-peak | 0.15 | 4.5 | 13.5 |
| `deepseek-v4-pro` | peak | 0.30 | 9 | 27 |

The legacy ids `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are
served by DeepSeek-V4.1-Flash and priced at the Flash rates;
`deepseek-v4-pro` is rerated to the Flash card from 2026-09-14 12:00 Beijing,
when that route is retired to V4.1-Flash. A model the card does not know is
reported as `费率未知 / unrated model` — the plugin shows tokens instead of a
wrong number.

**Balance.** `GET https://api.deepseek.com/user/balance` (the same read-only
endpoint behind dsh-tui's `/balance` command). The key is resolved through the
`credentials` seam (`DEEPSEEK_API_KEY`) with an environment fallback, is sent
only in the request header, and is never logged or stored by this plugin.

## Compatibility

| Item | Value |
| --- | --- |
| Host | `@deepseek-harness-tui/dsh-tui` 0.10.x (`ctx.tuiStatus.registerView`, `ctx.tuiSettingsSections.register`) |
| Harness | `@deepseek-ai/dsh` 0.1.2-rc.1 or later (`session/event`, `settings`, `credentials`) |
| Runtime | Node `^22.19 \|\| >=24`, pure ESM, no native dependencies |
| Manifest | `manifestVersion` 0.15 · id `com.dsh-tui-ecosystem.dsh-peak-balance` |
| Platform | Anywhere dsh-tui runs (Windows / macOS / Linux) |

Every host seam is optional and probed softly (`ctx.get(name, false)`): without
the TUI extension services, without a credentials service, or without network
access the plugin stays inert instead of failing the host. All registrations are
retried for 30 s while the profile composes, and every timer is cleared from the
activation's effect disposer.

## Known limitations

- **The prompt border itself cannot be recolored by a plugin.** dsh-tui 0.10
  draws the input frame in its own `EffortInputBorder` component and exposes no
  seam for it, so the warning frame is a status contribution rendered directly
  above the prompt — the closest a plugin can get without patching the host.
- Cost figures are estimates from provider-reported tokens; the platform bill
  is authoritative.
- The rate card is embedded in the package. A price change on DeepSeek's side
  requires a plugin update.
- The balance endpoint needs a DeepSeek official API key. Other providers are
  detected and simply show no balance.
- Rich status contributions share a six-row budget with other plugins; this one
  requests three rows, and only while the warning frame is visible.
- Only the most recently active session is displayed; subagent sessions are
  ignored on purpose, so a delegated child never rewrites your turn cost.

## Publishing and versioning

Released from `VviLliAm-qwq/dsh-peak-balance` under MIT. Versions follow
SemVer; the npm `version` and the manifest `version` are kept identical, and a
`v*` tag matching the version drives the release workflow.

## Development

```sh
pnpm install --frozen-lockfile
pnpm check:encoding      # no UTF-8 BOM / damaged sequences (the classic dsh crash)
pnpm validate:manifest   # admission shape + version agreement
pnpm test                # node:test unit + host-stub integration tests
pnpm pack:verify         # every module the entry imports ships in "files"
pnpm verify              # all four, in order
```

The tests cover the peak-window maths at fixed instants, the rate card and
bucket pricing, usage normalization, balance-payload parsing (including
failures), the display model, the status component's element tree, and a full
`apply()` run against a stubbed Cordis context — including the paths where the
host services are missing, refuse, or throw.

## Listing

This plugin is listed on the dsh-tui plugin market. Market listings are a link
directory only; they are not a code review and do not imply endorsement.

## License

MIT — see [LICENSE](LICENSE).
