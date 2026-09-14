# browser-profile-tool (`bpt`)

![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey)
![CLI](https://img.shields.io/badge/interface-CLI--only-blue)
![License](https://img.shields.io/badge/license-MIT-yellow)
![Telemetry](https://img.shields.io/badge/telemetry-none-brightgreen)
[![GitHub Stars](https://img.shields.io/github/stars/AbdulWaseaDev/browser-profile-tool?style=social)](https://github.com/AbdulWaseaDev/browser-profile-tool/stargazers)
[![GitHub Follow](https://img.shields.io/github/followers/AbdulWaseaDev?style=social)](https://github.com/AbdulWaseaDev)

Built by [**@AbdulWaseaDev**](https://github.com/AbdulWaseaDev). If this tool is useful to you, please consider **starring** the repo, **sharing** it, and **following** for future updates.

A terminal-only CLI for launching isolated, persistent, fingerprinted
Chromium browser profiles behind proxies — one profile per real,
already-existing account (your own Amazon US / eBay US accounts,
agency client social accounts, etc.), driven entirely by a config
file. Every profile is region-matched to where that account actually
operates and reused indefinitely. This tool does not generate
synthetic or unrelated identities, has no platform-specific logic, and
has no GUI, team sharing, telemetry, or auto-update of any kind.

## Verification status

Every command has been run end-to-end against a real fingerprint-chromium
binary and a real paid proxy, not just written to spec:

- `profile add`, `list`, `remove` (with and without `--purge`), `import`,
  `export`, `proxy test`, `engine update`, `config path` — all exercised
  directly.
- `launch` — spawns the real binary, connects over CDP, opens a real
  window through the real proxy, and cleans up correctly on `Ctrl+C`
  (`SIGINT`).
- `profile audit` — all five checks pass against a real profile
  (`navigator.webdriver`, timezone, locale, WebRTC leak, CreepJS load).
- One real bug was found this way and fixed: a hardcoded fingerprint
  brand version caused a `navigator.userAgent` vs. `navigator.userAgentData`
  mismatch, confirmed live via CreepJS and corrected in `src/fingerprints.js`.
- `deviceType: mobile` — run end-to-end against the real binary and fixed
  two real bugs found in the process: (1) the CDP session used for
  `Emulation.setDeviceMetricsOverride` was being detached immediately
  after use, which reverted the override; (2) `context.addInitScript()`
  doesn't run on a page that's already loaded before it's registered, so
  the UA/media-device overrides silently never applied to the initial
  tab. Both fixed in `src/launcher.js`. A third issue was found and
  worked around, not fully fixed: passing `mobile: true` to
  `Emulation.setDeviceMetricsOverride` causes this fingerprint-chromium
  build to ignore the requested viewport size entirely in headless mode
  (confirmed: two different requested widths both produced the same
  wrong result) — worked around by using `mobile: false` with the same
  dimensions, which keeps the viewport correct at the cost of
  `'ontouchstart' in window` reading `false` instead of `true`. See the
  comment above `applyMobileEmulation` in `src/launcher.js`.

Known, non-blocking gaps, left as-is rather than silently assumed fixed:

- No automated test suite; everything above was verified through manual,
  one-off runs during development, not a repeatable CI check.
- `bpt proxy test` against a *completely* unroutable proxy can take
  noticeably longer than its nominal timeout to fail (extra time is
  spent inside `proxy-chain`'s own connection attempt, outside this
  tool's timeout window) — it does fail correctly, just not always
  promptly.
- Launching two profiles concurrently has not been tested (should be
  safe — separate `userDataDir`s and `get-port`-assigned debug ports —
  but unverified in practice).

## Before you trust any profile: proxy stability

**Read this before configuring anything.** This tool's entire design
rests on one assumption: a given profile keeps the same proxy exit
identity (ideally the same exit IP, or at minimum the same
region/city) every time it launches. That consistency is what makes a
profile trustworthy to a site over months of logins.

**This cannot be verified or enforced by the tool itself.** If your
proxy plan rotates the exit IP per request or per session (common with
cheap "rotating residential" plans), every guarantee this tool makes
about consistent identity is broken — regardless of how the config
file is set up, regardless of the fingerprint template chosen. Confirm
directly with your proxy provider that the plan you're using for a
given profile gives you a **static or sticky** exit IP (or at least a
stable city/region) before you point that profile at a real account
login. `bpt proxy test <name>` reports the exit IP/region for a single
run, which is useful for catching a dead or misconfigured proxy — it
is not proof that the same IP is being handed out every launch. Run it
a few times over a few minutes if you're unsure whether the plan is
sticky.

**Stability and reputation are two different properties — check both.**
A proxy can be perfectly *stable* (same IP every launch) and still be
*burned* — datacenter IP ranges are commonly pre-flagged in Cloudflare/
Akamai/DataDome reputation databases regardless of anything the browser
does. In real testing, a $0.9/week datacenter proxy triggered a hard
Cloudflare block on one site and a JS challenge on another, independent
of fingerprint quality — the proxy's own `whatismyipaddress.com` lookup
showed its ISP labeled outright as `Data Center/Transit`. If your real
target site keeps hard-blocking a profile that passes `bpt profile
audit` cleanly, the fix is usually a **residential or mobile** proxy
tier from your provider, not a tool setting — no fingerprint template
fixes a blocklisted IP.

## Setup

1. Get the `fingerprint-chromium` binary for your platform from
   https://github.com/adryfish/fingerprint-chromium/releases (or build
   it yourself per that repo's instructions). This tool never
   downloads, builds, or replaces it for you.
2. Point the tool at it either by setting `binaryPath` at the top of
   your `profiles.yaml`, or by setting the `BPT_BINARY_PATH`
   environment variable (which takes priority over the config field).
3. `npm install`
4. Copy `config/profiles.example.yaml` to `config/profiles.yaml` and
   fill in real values, or run `bpt profile add <name>` to create your
   first profile interactively.

## Config file resolution order

`bpt` resolves the config file path in this order:

1. `--config <path>` CLI flag
2. `BPT_CONFIG_PATH` environment variable
3. `./config/profiles.yaml` (default, relative to your current
   working directory)

Run `bpt config path` at any time to see which file a given invocation
will actually use.

## Config file

See `config/profiles.example.yaml` for a full example. Top-level
fields:

- `binaryPath` — path to the fingerprint-chromium executable.
- `profiles` — list of profile entries (see the example file for the
  full per-profile schema: `proxy`, `fingerprint`, `webrtcPolicy`,
  `timezone`, `locale`, `deviceType`, `headless`, optional
  `userDataDir`).

Config is validated on load. Errors name the offending profile and
field specifically — nothing silently falls back to a default for
proxy or fingerprint fields, since a silently-defaulted proxy or
fingerprint is exactly the kind of mistake that breaks a profile's
consistency without anyone noticing.

**Client profiles: recheck timezone/locale per client, every time.**
If you manage social accounts for agency clients across different
countries, each client's profile `timezone` and `locale` must match
*that specific client's* actual country of operation. This is not a
one-time setup step — it's something to re-verify whenever you
onboard a new client profile or a client's operating country changes,
not just something you get right once and forget.

## Storage

Each profile gets its own `userDataDir` under `./profiles/<name>/`
(auto-derived from the profile name unless overridden in config) —
plain native Chromium profile persistence, no database involved.

## Commands

| Command | Purpose |
|---|---|
| `bpt profile add <name>` | Interactively create a profile (proxy, timezone, locale, device type); generates its fingerprint template + seed once and appends it to the config |
| `bpt profile list` | Table of configured profiles: name, proxy host, timezone, device type, whether `userDataDir` already exists on disk |
| `bpt profile remove <name> [--purge]` | Removes the config entry; without `--purge` the data folder is kept on disk (a warning is printed) |
| `bpt profile import <file>` | Bulk-create profiles from a CSV (`name,host,port,username,password,scheme,timezone,locale,deviceType`); a fresh fingerprint template + seed is generated per new profile |
| `bpt profile export <name>` | Writes one profile's config (not its `userDataDir`) to a portable YAML/JSON file |
| `bpt proxy test <name>` | Connects through the profile's proxy and hits a public IP-check endpoint; reports reachability and resolved IP/region |
| `bpt profile audit <name>` | Launches the profile headless and runs the manual-audit substitute described below |
| `bpt launch <name> [--headless] [--debug-port <n>]` | Spawns the browser, connects over CDP, prints the endpoint, and cleans up the proxy wrapper on exit |
| `bpt engine update` | Manually checks fingerprint-chromium's GitHub releases for a newer version; only reports it, never downloads or installs anything automatically |
| `bpt config path` | Prints the resolved config file path |

**Recommendation: run `bpt profile audit <name>` right after creating
a profile, and again after any proxy or config change to it — before
pointing it at a real account login.** A proxy swap, a timezone edit,
or a fresh proxy-provider IP assignment can each independently break
what previously looked like a consistent identity; the audit is the
cheapest way to catch that before it costs you a real account.

**One profile, one running instance at a time.** Chromium (and so
fingerprint-chromium) only allows a single process to run against a
given `userDataDir` at once. If you run `bpt launch <name>` and leave
the window open, a later `bpt launch`/`bpt profile audit` on that same
profile will fail with a CDP-timeout error — close the existing window
first. This is normal Chromium behavior, not a bug.

## `bpt profile audit` — what it actually checks

This is a deliberate, manual, point-in-time substitute for continuous
vendor-side detection tracking — this tool does **not** attempt to
watch for or auto-adapt to changes in how Cloudflare, DataDome, Akamai
or similar systems detect automation. That kind of continuous tuning
is a live service, not something a static local tool can promise. If
a platform's detection approach shifts, a previously-passing profile
can start failing without anything in this tool noticing — rerun the
audit yourself whenever you have reason to suspect a change.

The audit launches the profile headless and checks:

- **`navigator.webdriver` is not `true`.**
- **Timezone/locale as seen by the page match the config values.**
- **WebRTC does not leak an IP other than the proxy's exit IP** — this
  is checked directly (an in-page `RTCPeerConnection` is opened and
  its ICE candidates are compared against the proxy's resolved exit
  IP), not by scraping a third-party site's UI, since a leak checker's
  page layout can change out from under a scraper.
- **CreepJS loads successfully** as a pointer for you to manually
  review its own trust score — its scoring/DOM output isn't parsed
  here, since that's exactly the kind of "keep up with the detector"
  logic this tool intentionally doesn't attempt to automate.

## Fingerprint model

A profile's fingerprint is not a single opaque seed — it's a named,
internally-consistent **template** (see `src/fingerprints.js`) that
bundles OS, browser brand/version, screen resolution, hardware
concurrency, GPU vendor/renderer, and a plausible font list together,
so a mobile GPU string never ends up paired with a desktop resolution
or vice versa. `deviceType: mobile` picks a template with a matched
mobile resolution, pixel density, and Android-plausible hardware
signature.

**A profile's fingerprint template + seed are generated exactly once**
— at `bpt profile add` or `bpt profile import` time — and never
change automatically on any later launch or config edit. Nothing else
in this tool touches them. If you need a different fingerprint,
remove and re-add the profile deliberately; don't hand-edit the seed.

## Fingerprint coverage: what fingerprint-chromium covers natively vs. what needs a CDP override

fingerprint-chromium patches fingerprinting surfaces at the engine
(C++) level via command-line flags, confirmed against its README
(https://github.com/adryfish/fingerprint-chromium):

| Parameter | Coverage |
|---|---|
| Canvas | Native (`--fingerprint` seed drives canvas noise) |
| Audio | Native (seed-driven) |
| WebGL vendor/renderer | Native, via `--fingerprint-gpu-vendor` / `--fingerprint-gpu-renderer` on pre-Chrome-144 builds. **Chrome 144+ removed these two flags** in favor of a seed-derived value and a `--disable-spoofing=<list>` opt-out flag instead — this tool passes the older flags unconditionally, since a 144+ binary simply ignores unknown flags and spoofs GPU from the seed anyway. Check your binary's actual Chrome version if GPU strings don't match what you expect. |
| Fonts | Native (seed-driven; template font lists in `src/fingerprints.js` are informational/documentation, not separately injected) |
| Screen resolution | Partially native — this tool sets the real Chromium window size via `--window-size` to match the template, which is a real (not spoofed) window size |
| Hardware concurrency | Native, via `--fingerprint-hardware-concurrency` |
| Navigator properties (platform, UA brand) | Native, via `--fingerprint-platform` / `--fingerprint-brand`. **`--fingerprint-brand-version` is deliberately never set** — it only overrides `navigator.userAgentData` (Client Hints), not the real `navigator.userAgent`/`appVersion` string, which always reflects the actual binary version. A hardcoded brand version previously shipped in `src/fingerprints.js` and caused a live, confirmed UA-vs-Client-Hints mismatch (UA said Chrome 148, Client Hints said the hardcoded 128) — a well-known bot-detection signal. Leaving it unset keeps both values naturally in sync on every fingerprint-chromium release. |
| Timezone | Native, via `--timezone` |
| Locale | Native, via `--lang` / `--accept-lang` |
| WebRTC IP leak | Native, via `--disable-non-proxied-udp` (see below) |
| **Media device enumeration** | **Not covered natively.** This tool layers a `navigator.mediaDevices.enumerateDevices` override via a Playwright `addInitScript` CDP-level injection so the real host's camera/mic device list is never exposed. |
| **Battery Status API** | **Not covered natively.** Same mechanism — `navigator.getBattery` is overridden to return fixed plausible values instead of the real host's battery state. |
| Mobile (Android) platform | **Not a native option** — `--fingerprint-platform` only accepts `windows`, `linux`, or `macos` (confirmed in the fork's README; there is no `android` value). `deviceType: mobile` uses a `linux` base plus a CDP `Emulation.setDeviceMetricsOverride`/touch-emulation layer and a `navigator.userAgent`/`platform`/`maxTouchPoints` override, all in `src/launcher.js` — confirmed live to correctly produce the right viewport, pixel ratio, touch point count, UA, and platform. One known remaining gap: `'ontouchstart' in window` reads `false` instead of `true`, a side effect of working around a real viewport bug in this Chromium build when `mobile: true` is set (see comment on `applyMobileEmulation`). Treat mobile profiles as best-effort, not equivalent in rigor to the desktop templates, until you've audited one yourself. |

Anywhere a flag's exact behavior was inferred rather than read
directly off the fork's docs, that's called out in a comment at the
point of use in `src/launcher.js`.

## WebRTC

`webrtcPolicy: proxy-only` (currently the only supported value) maps
directly onto fingerprint-chromium's native `--disable-non-proxied-udp`
flag, confirmed in the fork's README. This forces WebRTC to refuse
non-proxied UDP ICE candidates, so any real WebRTC negotiation must
route through the configured proxy (or fall back to a proxied
TCP/relay path) rather than exposing the machine's real local or
public IP directly. No CDP-level fallback was needed here since a
native flag exists and was confirmed against the project's own
documentation — see the comment above `buildChromiumArgs` in
`src/launcher.js` for the exact reasoning.

## Explicitly out of scope

- No GUI, web interface, or dashboard — terminal-only.
- No team sharing or real-time multi-user profile access.
- No automatic or silent updates of the binary, config, or tool
  itself — `bpt engine update` only reports a newer version and
  requires you to act on it yourself.
- No telemetry, phone-home, license server, or external service
  dependency beyond your own proxy and the fingerprint-chromium binary
  you supply (aside from the public IP-check endpoint used by
  `bpt proxy test` / `bpt profile audit`, and CreepJS for the manual
  audit step).
- No continuous vendor-side detection tracking (auto-adapting to
  Cloudflare/DataDome/Akamai changes) — `bpt profile audit` is the
  deliberate manual substitute; see above.

## Development

```
npm install
node src/cli.js --help
```

No build step; it's plain CommonJS.

## Author

[**@AbdulWaseaDev**](https://github.com/AbdulWaseaDev)

If this project was useful to you, please ⭐ **star** the repo, 🔗 **share** it with others who might need it, and 👤 **follow** for future updates.
