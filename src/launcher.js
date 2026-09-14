'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const proxyChain = require('proxy-chain');
const getPort = require('get-port');
const { chromium } = require('playwright-core');

const { getTemplate } = require('./fingerprints');
const { resolveUserDataDir } = require('./config');

/**
 * Build the fingerprint-chromium command-line arguments for a profile.
 *
 * Flag names below are confirmed against the fingerprint-chromium README
 * (https://github.com/adryfish/fingerprint-chromium), not guessed:
 *   --fingerprint=<seed>                 32-bit integer seed
 *   --fingerprint-platform=<windows|linux|macos>
 *   --fingerprint-platform-version=<ver>
 *   --fingerprint-brand=<Chrome|Edge|Opera|Vivaldi>
 *   --fingerprint-brand-version=<ver>
 *   --fingerprint-hardware-concurrency=<n>
 *   --fingerprint-gpu-vendor=<string>    (only meaningful on pre-144 builds; see README note below)
 *   --fingerprint-gpu-renderer=<string>
 *   --lang=<lang>                        UI language
 *   --accept-lang=<lang list>            Accept-Language header value
 *   --timezone=<IANA tz>
 *   --proxy-server=<scheme://host:port>  no inline credentials supported
 *   --disable-non-proxied-udp            forces WebRTC to not leak non-proxied UDP candidates
 *
 * --fingerprint-gpu-vendor / --fingerprint-gpu-renderer / --disable-gpu-fingerprint were
 * removed starting at Chrome 144 in favor of --disable-spoofing=<comma list>. We pass the
 * older flags unconditionally since we don't know which build the user's binary is; a
 * pre-144 build accepts them, a 144+ build will just ignore the unknown flags and spoof GPU
 * values from the seed automatically. This is noted here rather than silently assumed.
 */
function buildChromiumArgs({ profile, template, userDataDir, localProxyUrl, debugPort }) {
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${debugPort}`,
    `--fingerprint=${profile.fingerprint.seed}`,
    `--fingerprint-platform=${template.platform}`,
    `--fingerprint-brand=${template.brand}`,
    `--fingerprint-hardware-concurrency=${template.hardwareConcurrency}`,
    `--lang=${profile.locale}`,
    `--accept-lang=${profile.locale}`,
    `--timezone=${profile.timezone}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];

  if (template.platformVersion) {
    args.push(`--fingerprint-platform-version=${template.platformVersion}`);
  }
  if (template.brandVersion) {
    args.push(`--fingerprint-brand-version=${template.brandVersion}`);
  }

  const gpuVendor = profile.fingerprint.gpuVendor || template.gpuVendor;
  const gpuRenderer = profile.fingerprint.gpuRenderer || template.gpuRenderer;
  if (gpuVendor) args.push(`--fingerprint-gpu-vendor=${gpuVendor}`);
  if (gpuRenderer) args.push(`--fingerprint-gpu-renderer=${gpuRenderer}`);

  if (template.screen) {
    args.push(`--window-size=${template.screen.width},${template.screen.height}`);
  }

  // WebRTC: fingerprint-chromium exposes a native flag for this (confirmed in README),
  // so we use it directly rather than reaching for a CDP-level fallback. It forces WebRTC
  // to refuse non-proxied UDP candidates, which is exactly "webrtcPolicy: proxy-only" —
  // any real ICE candidate must go through the proxy (or WebRTC falls back to TCP/relay
  // through it), so the local/public IP behind the proxy is never exposed via WebRTC.
  if (profile.webrtcPolicy === 'proxy-only') {
    args.push('--disable-non-proxied-udp');
  }

  if (localProxyUrl) {
    args.push(`--proxy-server=${localProxyUrl}`);
  }

  if (profile.headless) {
    args.push('--headless=new');
  }

  return args;
}

/**
 * Wrap an authenticated proxy into a local unauthenticated one via proxy-chain, since
 * Chromium's --proxy-server flag does not support inline username:password credentials.
 * Returns null if the profile's proxy has no credentials (nothing to wrap).
 */
async function startProxyIfNeeded(proxy) {
  if (!proxy.username || !proxy.password) {
    return { localProxyUrl: `${proxy.scheme}://${proxy.host}:${proxy.port}`, anonymizedUrl: null };
  }
  const scheme = proxy.scheme === 'socks5' ? 'socks5' : 'http';
  const upstreamUrl = `${scheme}://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.host}:${proxy.port}`;
  const anonymizedUrl = await proxyChain.anonymizeProxy(upstreamUrl);
  return { localProxyUrl: anonymizedUrl, anonymizedUrl };
}

async function waitForCdp(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * Shared override function, injected both via addInitScript (so it applies to every
 * future navigation) and evaluated directly against already-open pages. addInitScript
 * alone is not enough: it only fires on documents created *after* it's registered, so the
 * initial tab fingerprint-chromium opens on launch (already loaded by the time we connect)
 * would otherwise never get it — confirmed live: without the direct-evaluate pass below,
 * the very first tab kept reporting the host's real media devices. Idempotent, so running
 * it twice on the same page (once live, once again via addInitScript on next navigation)
 * is harmless.
 */
function applyFingerprintOverrides({ counts, mobile, uaToken }) {
  // --- Media device enumeration override ---
  const makeDevice = (kind, index) => ({
    deviceId: `bpt-${kind}-${index}`,
    groupId: `bpt-group-${kind}`,
    kind,
    label: '',
    toJSON() { return this; },
  });
  const fakeDevices = [];
  for (const [kind, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i++) fakeDevices.push(makeDevice(kind, i));
  }
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    navigator.mediaDevices.enumerateDevices = () => Promise.resolve(fakeDevices);
  }

  // --- Battery Status API override ---
  if (navigator.getBattery) {
    navigator.getBattery = () => Promise.resolve({
      charging: true,
      chargingTime: 0,
      dischargingTime: Infinity,
      level: 1,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return true; },
    });
  }

  // --- Mobile UA/platform token override (best-effort; native platform flag has no
  //     "android" value, see fingerprints.js for why) ---
  if (mobile && uaToken) {
    const ua = navigator.userAgent.replace(/\([^)]*\)/, `(Linux; ${uaToken})`);
    Object.defineProperty(navigator, 'userAgent', { get: () => ua });
    Object.defineProperty(navigator, 'platform', { get: () => 'Linux armv8l' });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
  }
}

async function applyOverridesToExistingPages(context, overrideArgs) {
  for (const page of context.pages()) {
    await page.evaluate(applyFingerprintOverrides, overrideArgs).catch(() => {
      // Page may not have finished its initial navigation yet, in which case the
      // addInitScript registration covers it on its next navigation anyway.
    });
  }
}

/**
 * Inject overrides for fingerprint surfaces fingerprint-chromium does not cover natively:
 * media device enumeration and the Battery Status API. Both are known gaps in engine-level
 * fingerprint forks (see README "Fingerprint coverage" table) — without this, a profile
 * with a spoofed GPU/OS could still leak the host machine's real camera/mic device list or
 * real battery state.
 *
 * For deviceType: mobile we also add a UA + touch/viewport override here, since
 * fingerprint-chromium's --fingerprint-platform has no "android" value (see fingerprints.js).
 */
async function applyCdpOverrides(context, profile, template) {
  const deviceCounts = template.deviceType === 'mobile'
    ? { videoinput: 1, audioinput: 1, audiooutput: 0 }
    : { videoinput: 1, audioinput: 1, audiooutput: 1 };

  const overrideArgs = {
    counts: deviceCounts,
    mobile: template.deviceType === 'mobile',
    uaToken: template.mobileUserAgentOsToken || null,
  };

  await context.addInitScript(applyFingerprintOverrides, overrideArgs);
  await applyOverridesToExistingPages(context, overrideArgs);

  if (template.deviceType === 'mobile') {
    for (const page of context.pages()) {
      await applyMobileEmulation(page, template);
    }
    context.on('page', (page) => applyMobileEmulation(page, template).catch(() => {}));
  }
}

/**
 * CDP sessions used for Emulation.setDeviceMetricsOverride are kept open for the life of
 * the page rather than detached right after sending the command. Detaching immediately
 * reverts the override in this Chromium build — confirmed live: devicePixelRatio and touch
 * emulation both silently fell back to non-mobile defaults when the session was detached
 * right after being set. The session is closed naturally when the browser connection
 * itself closes during cleanup(), so no separate teardown is needed here.
 *
 * `mobile: false` here is deliberate, not a typo. Confirmed live against fingerprint-chromium
 * 148 in headless mode: passing `mobile: true` to setDeviceMetricsOverride causes Chromium to
 * ignore the requested width/height entirely and substitute some other internally-computed
 * size (observed: two different requested widths, 412 and 375, both produced an identical,
 * unrelated 981 — a real engine bug/quirk in this build's headless mobile-emulation path, not
 * something fixable from here). `mobile: false` with the same width/height/deviceScaleFactor
 * honors the requested values exactly. Touch behavior is still forced via
 * setTouchEmulationEnabled and the navigator.maxTouchPoints override in
 * applyFingerprintOverrides, so the tradeoff is losing native `'ontouchstart' in window`
 * detection (reports false) in exchange for a correct, consistent viewport size — the more
 * important property for not looking like an impossible device. If a future
 * fingerprint-chromium/Chromium build fixes the underlying mobile-emulation bug, revisit this.
 */
async function applyMobileEmulation(page, template) {
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: template.screen.width,
    height: template.screen.height,
    deviceScaleFactor: template.screen.pixelRatio,
    mobile: false,
  });
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
}

/**
 * Spawn fingerprint-chromium for the named profile and connect to it over CDP.
 * Returns a handle with the browser connection and a cleanup() to tear everything down.
 */
async function launchProfile(profile, config, opts = {}) {
  const template = getTemplate(profile.fingerprint.template);
  const configFileDir = path.dirname(config._path);
  const userDataDir = resolveUserDataDir(profile, configFileDir);
  fs.mkdirSync(userDataDir, { recursive: true });

  const { localProxyUrl, anonymizedUrl } = await startProxyIfNeeded(profile.proxy);
  const debugPort = opts.debugPort || await getPort();

  const effectiveHeadless = opts.headless !== undefined ? opts.headless : !!profile.headless;
  const chromiumArgs = buildChromiumArgs({
    profile: { ...profile, headless: effectiveHeadless },
    template,
    userDataDir,
    localProxyUrl,
    debugPort,
  });

  const child = spawn(config.binaryPath, chromiumArgs, {
    stdio: 'ignore',
    detached: false,
  });

  let exitedEarly = false;
  child.once('exit', () => { exitedEarly = true; });

  const cdpReady = await waitForCdp(debugPort);
  if (!cdpReady || exitedEarly) {
    if (anonymizedUrl) await proxyChain.closeAnonymizedProxy(anonymizedUrl, true).catch(() => {});
    throw new Error(
      `fingerprint-chromium did not expose a CDP endpoint on port ${debugPort} in time.\n` +
      `Most likely cause: this profile's userDataDir ("${userDataDir}") is already open in another ` +
      `fingerprint-chromium/Chromium window or process — Chromium only allows one instance per profile ` +
      `directory. Close any existing window for "${profile.name}" (including one left open from a previous ` +
      `"bpt launch") and try again.\n` +
      `If that's not it, check that binaryPath ("${config.binaryPath}") is correct and executable.`
    );
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const context = browser.contexts()[0] || await browser.newContext();
  await applyCdpOverrides(context, profile, template);

  let cleanedUp = false;
  async function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    try { await browser.close(); } catch (_) { /* already gone */ }
    if (anonymizedUrl) {
      await proxyChain.closeAnonymizedProxy(anonymizedUrl, true).catch(() => {});
    }
    if (!child.killed && !exitedEarly) {
      try { child.kill(); } catch (_) { /* already gone */ }
    }
  }

  return {
    browser,
    context,
    child,
    debugPort,
    cdpEndpoint: `http://127.0.0.1:${debugPort}`,
    cleanup,
  };
}

const CREEPJS_URL = 'https://abrahamjuliot.github.io/creepjs/';

/**
 * In-page WebRTC leak check: open a real RTCPeerConnection with a STUN server and collect
 * every ICE candidate's IP. This is more reliable than scraping a third-party leak-checker
 * site's DOM (which changes layout often) — we generate the candidates ourselves and compare
 * them directly against the proxy's known exit IP.
 */
async function collectWebrtcCandidateIps(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const ips = new Set();
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      pc.createDataChannel('bpt-audit');
      pc.onicecandidate = (e) => {
        if (e.candidate && e.candidate.candidate) {
          const match = e.candidate.candidate.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
          if (match) ips.add(match[1]);
        }
      };
      pc.createOffer().then((offer) => pc.setLocalDescription(offer));
      setTimeout(() => {
        pc.close();
        resolve(Array.from(ips));
      }, 3000);
    } catch (err) {
      resolve([]);
    }
  }));
}

/**
 * Launch a profile headless and run a manual-audit substitute: check the automation
 * (`navigator.webdriver`) flag, confirm WebRTC does not leak an IP other than the proxy's
 * exit IP, confirm timezone/locale as seen by the page match the config, and load CreepJS so
 * the user can also eyeball it (CreepJS's own scoring output is not parsed here since its DOM
 * changes across versions — this is a deliberately manual substitute, not a continuous
 * detection-tracking system; see README).
 */
async function auditProfile(profile, config, { proxyExitIp } = {}) {
  const results = [];
  const handle = await launchProfile(profile, config, { headless: true });
  try {
    const page = handle.context.pages()[0] || await handle.context.newPage();

    const webdriverFlag = await page.evaluate(() => navigator.webdriver);
    results.push({
      check: 'webdriver flag clean',
      pass: webdriverFlag !== true,
      detail: `navigator.webdriver = ${webdriverFlag}`,
    });

    const tzLocale = await page.evaluate(() => ({
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      language: navigator.language,
    }));
    results.push({
      check: 'timezone matches config',
      pass: tzLocale.timeZone === profile.timezone,
      detail: `page reports "${tzLocale.timeZone}", config says "${profile.timezone}"`,
    });
    results.push({
      check: 'locale matches config',
      pass: tzLocale.language === profile.locale,
      detail: `page reports "${tzLocale.language}", config says "${profile.locale}"`,
    });

    const candidateIps = await collectWebrtcCandidateIps(page);
    const leaked = proxyExitIp ? candidateIps.filter((ip) => ip !== proxyExitIp && !ip.startsWith('0.')) : candidateIps;
    results.push({
      check: 'WebRTC IP matches proxy (no leak)',
      pass: leaked.length === 0,
      detail: candidateIps.length === 0
        ? 'no ICE candidates observed (non-proxied UDP fully blocked)'
        : `candidate IPs: ${candidateIps.join(', ')}${proxyExitIp ? ` (expected proxy exit IP: ${proxyExitIp})` : ''}`,
    });

    let creepjsLoaded = true;
    let creepjsError = null;
    try {
      await page.goto(CREEPJS_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (err) {
      creepjsLoaded = false;
      creepjsError = err.message;
    }
    results.push({
      check: 'CreepJS page loaded (manual review recommended)',
      pass: creepjsLoaded,
      detail: creepjsLoaded ? `loaded ${CREEPJS_URL} — open --headless=false to review its trust score yourself` : creepjsError,
    });
  } finally {
    await handle.cleanup();
  }
  return results;
}

module.exports = {
  buildChromiumArgs,
  startProxyIfNeeded,
  waitForCdp,
  applyCdpOverrides,
  launchProfile,
  auditProfile,
};
