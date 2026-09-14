'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const yaml = require('js-yaml');

const { loadConfig, saveConfig, resolveUserDataDir, ConfigError, ALLOWED_SCHEMES, ALLOWED_DEVICE_TYPES } = require('./config');
const { generateFingerprint, defaultTemplateForDeviceType, listTemplateNames } = require('./fingerprints');

async function prompt(rl, question, { required = true, defaultValue } = {}) {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    if (answer) return answer;
    if (defaultValue !== undefined) return defaultValue;
    if (!required) return '';
    console.log('  This field is required.');
  }
}

async function promptChoice(rl, question, choices, defaultValue) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const answer = await prompt(rl, `${question} (${choices.join('/')})`, { defaultValue });
    if (choices.includes(answer)) return answer;
    console.log(`  Must be one of: ${choices.join(', ')}`);
  }
}

async function promptProfileFields(rl, name) {
  const host = await prompt(rl, 'Proxy host');
  const portStr = await prompt(rl, 'Proxy port');
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid proxy port "${portStr}" — must be an integer between 1 and 65535`);
  }
  const username = await prompt(rl, 'Proxy username (leave blank if IP-whitelisted)', { required: false });
  const password = username ? await prompt(rl, 'Proxy password') : '';
  const scheme = await promptChoice(rl, 'Proxy scheme', ALLOWED_SCHEMES, 'http');
  const timezone = await prompt(rl, 'Timezone (IANA, e.g. America/New_York)');
  const locale = await prompt(rl, 'Locale (e.g. en-US)');
  const deviceType = await promptChoice(rl, 'Device type', ALLOWED_DEVICE_TYPES, 'desktop');
  const defaultTemplate = defaultTemplateForDeviceType(deviceType);
  const template = await prompt(rl, `Fingerprint template (${listTemplateNames().join(', ')})`, { defaultValue: defaultTemplate });

  const proxy = { host, port, scheme };
  if (username) {
    proxy.username = username;
    proxy.password = password;
  }

  return {
    name,
    proxy,
    fingerprint: generateFingerprint(deviceType, template),
    webrtcPolicy: 'proxy-only',
    timezone,
    locale,
    deviceType,
    headless: false,
  };
}

async function addProfile(configPath, name) {
  const config = loadConfig(configPath);
  if (config.profiles.some((p) => p.name === name)) {
    throw new ConfigError(`Profile "${name}" already exists in ${configPath}`);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let newProfile;
  try {
    newProfile = await promptProfileFields(rl, name);
  } finally {
    rl.close();
  }

  config.profiles.push(newProfile);
  saveConfig(configPath, config);
  return newProfile;
}

function listProfiles(configPath) {
  const config = loadConfig(configPath);
  const configFileDir = path.dirname(configPath);
  return config.profiles.map((p) => ({
    name: p.name,
    proxyHost: `${p.proxy.host}:${p.proxy.port}`,
    timezone: p.timezone,
    deviceType: p.deviceType,
    launched: fs.existsSync(resolveUserDataDir(p, configFileDir)),
  }));
}

function removeProfile(configPath, name, purge) {
  const config = loadConfig(configPath);
  const idx = config.profiles.findIndex((p) => p.name === name);
  if (idx === -1) {
    throw new ConfigError(`No profile named "${name}" in ${configPath}`);
  }
  const [removed] = config.profiles.splice(idx, 1);
  saveConfig(configPath, config);

  const configFileDir = path.dirname(configPath);
  const userDataDir = resolveUserDataDir(removed, configFileDir);
  if (purge) {
    if (fs.existsSync(userDataDir)) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
    return { removed, purged: true, userDataDir };
  }
  return { removed, purged: false, userDataDir };
}

function parseCsvLine(line) {
  // Minimal CSV split — profile import files are expected to be simple, comma-separated,
  // unquoted proxy lists (no embedded commas in fields such as host/username/password).
  return line.split(',').map((cell) => cell.trim());
}

const IMPORT_COLUMNS = ['name', 'host', 'port', 'username', 'password', 'scheme', 'timezone', 'locale', 'deviceType'];

function parseImportCsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error(`Import file ${filePath} is empty`);
  }

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const isHeaderRow = header.includes('name') && header.includes('host');
  const dataLines = isHeaderRow ? lines.slice(1) : lines;
  const columns = isHeaderRow ? header : IMPORT_COLUMNS;

  return dataLines.map((line, i) => {
    const cells = parseCsvLine(line);
    const row = {};
    columns.forEach((col, colIdx) => { row[col] = cells[colIdx] !== undefined ? cells[colIdx] : ''; });
    if (!row.name || !row.host || !row.port) {
      throw new Error(`Import file ${filePath}, row ${i + (isHeaderRow ? 2 : 1)}: name, host, and port are required`);
    }
    return row;
  });
}

function importProfiles(configPath, csvPath) {
  const config = loadConfig(configPath);
  const rows = parseImportCsv(csvPath);
  const existingNames = new Set(config.profiles.map((p) => p.name));
  const created = [];

  for (const row of rows) {
    if (existingNames.has(row.name)) {
      throw new ConfigError(`Import file has profile name "${row.name}" which already exists in ${configPath}`);
    }
    const port = Number(row.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new ConfigError(`Import row for "${row.name}": invalid port "${row.port}"`);
    }
    const deviceType = row.deviceType || 'desktop';
    if (!ALLOWED_DEVICE_TYPES.includes(deviceType)) {
      throw new ConfigError(`Import row for "${row.name}": invalid deviceType "${row.deviceType}"`);
    }
    const scheme = row.scheme || 'http';
    if (!ALLOWED_SCHEMES.includes(scheme)) {
      throw new ConfigError(`Import row for "${row.name}": invalid scheme "${row.scheme}"`);
    }
    if (!row.timezone) {
      throw new ConfigError(`Import row for "${row.name}": timezone is required`);
    }
    if (!row.locale) {
      throw new ConfigError(`Import row for "${row.name}": locale is required`);
    }

    const proxy = { host: row.host, port, scheme };
    if (row.username) {
      proxy.username = row.username;
      proxy.password = row.password || '';
    }

    const profile = {
      name: row.name,
      proxy,
      fingerprint: generateFingerprint(deviceType),
      webrtcPolicy: 'proxy-only',
      timezone: row.timezone,
      locale: row.locale,
      deviceType,
      headless: false,
    };
    config.profiles.push(profile);
    existingNames.add(row.name);
    created.push(profile);
  }

  saveConfig(configPath, config);
  return created;
}

function exportProfile(configPath, name, outPath) {
  const config = loadConfig(configPath);
  const profile = config.profiles.find((p) => p.name === name);
  if (!profile) {
    throw new ConfigError(`No profile named "${name}" in ${configPath}`);
  }
  const ext = path.extname(outPath).toLowerCase();
  const content = ext === '.json' ? JSON.stringify(profile, null, 2) : yaml.dump(profile, { lineWidth: -1 });
  fs.writeFileSync(outPath, content, 'utf8');
  return outPath;
}

module.exports = {
  addProfile,
  listProfiles,
  removeProfile,
  importProfiles,
  exportProfile,
  parseImportCsv,
};
