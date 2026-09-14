'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { getTemplate } = require('./fingerprints');

const ALLOWED_SCHEMES = ['http', 'socks5'];
const ALLOWED_DEVICE_TYPES = ['desktop', 'mobile'];
const ALLOWED_WEBRTC_POLICIES = ['proxy-only'];

class ConfigError extends Error {}

/**
 * Resolution order (documented in README):
 *   1. --config CLI flag
 *   2. BPT_CONFIG_PATH env var
 *   3. ./config/profiles.yaml (default, relative to cwd)
 */
function resolveConfigPath(cliOption) {
  if (cliOption) return path.resolve(cliOption);
  if (process.env.BPT_CONFIG_PATH) return path.resolve(process.env.BPT_CONFIG_PATH);
  return path.resolve(process.cwd(), 'config', 'profiles.yaml');
}

function resolveBinaryPath(configBinaryPath, configFileDir) {
  if (process.env.BPT_BINARY_PATH) return path.resolve(process.env.BPT_BINARY_PATH);
  if (configBinaryPath) return path.resolve(configFileDir, configBinaryPath);
  return null;
}

function fail(msg) {
  throw new ConfigError(msg);
}

function validateProfile(profile, index, seenNames) {
  const where = `profiles[${index}]${profile && profile.name ? ` (name: "${profile.name}")` : ''}`;

  if (!profile || typeof profile !== 'object') {
    fail(`${where}: profile entry must be an object`);
  }
  if (!profile.name || typeof profile.name !== 'string') {
    fail(`${where}: missing required field "name"`);
  }
  if (seenNames.has(profile.name)) {
    fail(`Duplicate profile name "${profile.name}" — profile names must be unique`);
  }
  seenNames.add(profile.name);

  if (!profile.proxy || typeof profile.proxy !== 'object') {
    fail(`Profile "${profile.name}": missing required "proxy" section`);
  }
  const { proxy } = profile;
  if (!proxy.host || typeof proxy.host !== 'string') {
    fail(`Profile "${profile.name}": proxy.host is required and must be a string`);
  }
  if (proxy.port === undefined || proxy.port === null || typeof proxy.port !== 'number' || !Number.isInteger(proxy.port)) {
    fail(`Profile "${profile.name}": proxy.port is required and must be a numeric integer (got ${JSON.stringify(proxy.port)})`);
  }
  if (proxy.port <= 0 || proxy.port > 65535) {
    fail(`Profile "${profile.name}": proxy.port must be between 1 and 65535 (got ${proxy.port})`);
  }
  const scheme = proxy.scheme || 'http';
  if (!ALLOWED_SCHEMES.includes(scheme)) {
    fail(`Profile "${profile.name}": proxy.scheme must be one of ${ALLOWED_SCHEMES.join(', ')} (got "${proxy.scheme}")`);
  }
  proxy.scheme = scheme;
  // username/password are optional (some proxies are IP-whitelisted), but if one is
  // present the other must be too, since proxy-chain needs both to build the auth URL.
  if ((proxy.username && !proxy.password) || (!proxy.username && proxy.password)) {
    fail(`Profile "${profile.name}": proxy.username and proxy.password must both be set, or both omitted`);
  }

  if (!profile.fingerprint || typeof profile.fingerprint !== 'object') {
    fail(`Profile "${profile.name}": missing required "fingerprint" section`);
  }
  if (!profile.fingerprint.template || typeof profile.fingerprint.template !== 'string') {
    fail(`Profile "${profile.name}": fingerprint.template is required (e.g. "windows-chrome-1080p")`);
  }
  if (!profile.fingerprint.seed || typeof profile.fingerprint.seed !== 'string') {
    fail(`Profile "${profile.name}": fingerprint.seed is required — generate one with "bpt profile add" or "bpt profile import", never hand-edit`);
  }

  if (!profile.timezone || typeof profile.timezone !== 'string') {
    fail(`Profile "${profile.name}": timezone is required (e.g. "America/New_York") — do not fall back to a default, it must match where this account actually operates`);
  }
  if (!profile.locale || typeof profile.locale !== 'string') {
    fail(`Profile "${profile.name}": locale is required (e.g. "en-US")`);
  }

  const deviceType = profile.deviceType || 'desktop';
  if (!ALLOWED_DEVICE_TYPES.includes(deviceType)) {
    fail(`Profile "${profile.name}": deviceType must be one of ${ALLOWED_DEVICE_TYPES.join(', ')} (got "${profile.deviceType}")`);
  }
  profile.deviceType = deviceType;

  // Actual runtime behavior (src/launcher.js) is driven entirely by the *template's own*
  // deviceType, not this field — deviceType here only picks a default template at profile
  // creation and drives the "DEVICE" column in `profile list`. If the two disagree (e.g.
  // deviceType: mobile hand-edited onto a profile still pointing at a desktop template),
  // the profile would silently launch with desktop behavior despite claiming to be mobile —
  // exactly the kind of field mismatch this tool exists to prevent, so it's a hard error
  // rather than a silent fallback.
  let templateDeviceType;
  try {
    templateDeviceType = getTemplate(profile.fingerprint.template).deviceType;
  } catch (err) {
    fail(`Profile "${profile.name}": ${err.message}`);
  }
  if (templateDeviceType !== deviceType) {
    fail(
      `Profile "${profile.name}": deviceType is "${deviceType}" but fingerprint.template ` +
      `"${profile.fingerprint.template}" is a ${templateDeviceType} template — they must match. ` +
      `Either change deviceType to "${templateDeviceType}", or pick a ${deviceType} template ` +
      `(run "bpt profile add"/"bpt profile import" to generate a matching template+seed pair ` +
      `rather than hand-editing an existing profile's device type).`
    );
  }

  const webrtcPolicy = profile.webrtcPolicy || 'proxy-only';
  if (!ALLOWED_WEBRTC_POLICIES.includes(webrtcPolicy)) {
    fail(`Profile "${profile.name}": webrtcPolicy must be one of ${ALLOWED_WEBRTC_POLICIES.join(', ')} (got "${profile.webrtcPolicy}")`);
  }
  profile.webrtcPolicy = webrtcPolicy;

  if (profile.headless !== undefined && typeof profile.headless !== 'boolean') {
    fail(`Profile "${profile.name}": headless must be true or false`);
  }

  return profile;
}

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    fail(`Config file not found at ${configPath}. Run "bpt profile add <name>" to create one, or check --config / BPT_CONFIG_PATH.`);
  }

  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    fail(`Could not read config file at ${configPath}: ${err.message}`);
  }

  let data;
  try {
    data = yaml.load(raw) || {};
  } catch (err) {
    fail(`Config file at ${configPath} is not valid YAML: ${err.message}`);
  }

  if (typeof data !== 'object' || Array.isArray(data)) {
    fail(`Config file at ${configPath} must have a top-level object with "profiles" and "binaryPath"`);
  }

  const profiles = Array.isArray(data.profiles) ? data.profiles : [];
  const seenNames = new Set();
  for (let i = 0; i < profiles.length; i++) {
    validateProfile(profiles[i], i, seenNames);
  }

  const configFileDir = path.dirname(configPath);
  const binaryPath = resolveBinaryPath(data.binaryPath, configFileDir);
  if (!binaryPath) {
    fail(
      `No binaryPath configured. Set "binaryPath" at the top of ${configPath}, or set the BPT_BINARY_PATH env var, ` +
      `to point at your fingerprint-chromium executable. This tool does not download or build the binary for you.`
    );
  }

  return {
    _path: configPath,
    binaryPath,
    profiles,
  };
}

function saveConfig(configPath, config) {
  const out = {
    binaryPath: config.binaryPath,
    profiles: config.profiles,
  };
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, yaml.dump(out, { lineWidth: -1 }), 'utf8');
}

function findProfile(config, name) {
  const profile = config.profiles.find((p) => p.name === name);
  if (!profile) {
    fail(`No profile named "${name}" in ${config._path}. Run "bpt profile list" to see available profiles.`);
  }
  return profile;
}

function resolveUserDataDir(profile, configFileDir) {
  if (profile.userDataDir) return path.resolve(configFileDir, profile.userDataDir);
  return path.resolve(configFileDir, '..', 'profiles', profile.name);
}

module.exports = {
  ConfigError,
  resolveConfigPath,
  loadConfig,
  saveConfig,
  findProfile,
  resolveUserDataDir,
  validateProfile,
  ALLOWED_SCHEMES,
  ALLOWED_DEVICE_TYPES,
  ALLOWED_WEBRTC_POLICIES,
};
