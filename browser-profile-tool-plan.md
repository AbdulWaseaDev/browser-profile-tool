# browser-profile-tool — Plan

CLI tool for launching isolated, fingerprinted Chromium profiles behind
proxies, driven by a config file. No GUI, no team sharing.

## Stack

Node.js CLI (`bpt`), no GUI, no web interface, no license server, no
telemetry.

- `commander` — CLI parsing
- `js-yaml` — config file parsing
- `playwright-core` — drives the browser over CDP after launch
- `proxy-chain` — wraps authenticated proxies into a local
  unauthenticated one (Chromium's `--proxy-server` doesn't support
  inline credentials)
- `get-port` — debug-port allocation per launch

## Engine

[`fingerprint-chromium`](https://github.com/adryfish/fingerprint-chromium)
— open-source ungoogled-chromium fork, engine-level (C++) fingerprint
patching, no JS injection. Binary path supplied via config or
`BPT_BINARY_PATH` env var; the tool does not fetch or build it.

`bpt engine update` checks the project's releases page and downloads a
newer binary on request only — never silently.

## Fingerprint model

Not a single opaque seed — a coherent device-profile template bundling:

- OS + browser version
- screen resolution + hardware concurrency
- font list
- WebGL vendor/renderer
- media device enumeration
- battery API values

Optional `deviceType: mobile` for matched resolution/pixel-density/
Android hardware signature.

Generated once at profile creation, **never regenerated automatically**
— persistence across sessions is what makes the identity trustworthy
over time. A fingerprint that changes between sessions is itself a
detection signal.

## WebRTC

First-class config field (`webrtcPolicy`), not deferred. **Open item:**
confirm fingerprint-chromium's actual flag for this, or fall back to a
CDP `Network`-domain override. Must be resolved before the tool is used
for any real login.

## Config file

Single YAML file (`config/profiles.yaml`), unlimited profiles. Each
profile:

```yaml
profiles:
  - name: amazon-us
    userDataDir: ./profiles/amazon-us       # auto-derived if omitted
    proxy:
      host: <string>
      port: <number>
      username: <string>
      password: <string>
      scheme: http                          # http | socks5
    fingerprint:
      template: <string>                    # e.g. "windows-chrome-1080p"
      seed: <string>                        # generated once, never changes
      gpuVendor: <string optional>
      gpuRenderer: <string optional>
    webrtcPolicy: proxy-only
    timezone: America/New_York
    locale: en-US
    deviceType: desktop                     # desktop | mobile
    headless: false
```

Validated on load — required fields, no duplicate names, clear
per-profile error messages.

## Storage

One `userDataDir` per profile under `./profiles/<name>/` — native
Chromium persistence, no database.

## CLI commands

| Command | Purpose |
|---|---|
| `bpt profile add <name>` | Interactive prompt (proxy, timezone, locale, device type); generates fingerprint template/seed once; writes entry to `profiles.yaml` |
| `bpt profile list` | Table: name, proxy host, timezone, whether `userDataDir` exists yet |
| `bpt profile remove <name> [--purge]` | Removes config entry; `--purge` also deletes stored data |
| `bpt profile import <file>` | Bulk-create profiles from a CSV/proxy list |
| `bpt profile export <name>` | Package one profile's config (not its data folder) into a portable file |
| `bpt proxy test <name>` | Checks reachability, reports exit IP/region before relying on it |
| `bpt profile audit <name>` | Headless launch, drives the profile to CreepJS + a WebRTC leak checker, prints pass/fail |
| `bpt launch <name> [--headless] [--debug-port <n>]` | Wraps proxy, spawns browser, connects via CDP, prints endpoint, cleans up proxy wrapper on exit |
| `bpt engine update` | Manual binary update check |
| `bpt config path` | Prints resolved config file location |

## Explicitly out of scope

- GUI / web interface
- Team sharing, real-time multi-user profile access
- Automatic silent updates
- Continuous vendor-side detection tracking — GoLogin's ongoing patching
  against Cloudflare/DataDome/Akamai is a *service*, not a feature a
  static tool can replicate. If Amazon/eBay's detection approach shifts
  later, a previously-working profile can still start failing, and
  nothing in this tool watches for that automatically — `bpt profile
  audit` is the manual substitute.

## Open items before build

1. Confirm fingerprint-chromium's exact WebRTC-handling flag, or the
   CDP fallback if no flag exists.
2. Confirm which of GoLogin's ~53 fingerprint parameters
   fingerprint-chromium actually covers vs. what needs a custom CDP
   override layered on top.
3. Confirm proxy-seller's plan provides stable exit IPs (or at least
   stable region/city) per profile rather than per-request rotation —
   consistency matters more than diversity for this use case (real
   logins to owned/client accounts, not multi-accounting). This is not
   something the tool's code can verify or fix — it's a fact about the
   proxy plan itself, so it belongs in the README as a setup
   prerequisite the user checks before trusting any profile, not just
   a planning-stage note that gets dropped once the build starts.

## Primary intended use case

Multi-purpose, but every profile follows the same rule: one profile
per real, already-existing account, region-matched and reused
indefinitely — never a synthetic or unrelated identity.

- The user's own Amazon US and eBay US accounts.
- Agency client social media business accounts (e.g. Facebook) across
  different countries — each client's profile region-matched to where
  that specific client actually operates. Where a client has granted
  Business Manager partner access instead of direct login credentials,
  this tool isn't needed at all for that client — partner access works
  from the agency's own single login, no separate profile or proxy
  required. This tool is for cases where the agency logs in directly
  as the client's account.

Config supports an unlimited number of profiles across all of the
above; the tool has no platform-specific logic — a profile is just a
profile, and which site it's pointed at after `bpt launch` is outside
the tool's concern.

Not built for generating many synthetic/unrelated identities at scale;
narrower and easier than GoLogin's general-purpose case, which is why
gaps like team sharing and continuous detection-engine tuning are
acceptable to leave out.

**Standing requirement, not a one-time check:** each client profile's
timezone/locale must match *that client's* actual country, not a
default — this applies per-profile, permanently, not just at setup.
