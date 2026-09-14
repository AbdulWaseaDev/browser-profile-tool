#!/usr/bin/env node
'use strict';

const { Command } = require('commander');

const { resolveConfigPath, loadConfig, findProfile, ConfigError } = require('./config');
const { addProfile, listProfiles, removeProfile, importProfiles, exportProfile } = require('./profile');
const { launchProfile, auditProfile } = require('./launcher');
const { testProxy } = require('./proxyTest');

const program = new Command();

program
  .name('bpt')
  .description('Launch isolated, persistent, fingerprinted Chromium profiles behind proxies.')
  .option('--config <path>', 'path to profiles.yaml (overrides BPT_CONFIG_PATH and the default)');

function getConfigPath() {
  return resolveConfigPath(program.opts().config);
}

function handleError(err) {
  if (err instanceof ConfigError) {
    console.error(`Config error: ${err.message}`);
  } else {
    console.error(`Error: ${err.message}`);
  }
  process.exitCode = 1;
}

const profileCmd = program.command('profile').description('manage profiles in the config file');

profileCmd
  .command('add <name>')
  .description('interactively add a new profile')
  .action(async (name) => {
    try {
      const profile = await addProfile(getConfigPath(), name);
      console.log(`Added profile "${profile.name}" (fingerprint template: ${profile.fingerprint.template}, seed: ${profile.fingerprint.seed}).`);
      console.log('Run "bpt proxy test" and "bpt profile audit" on it before pointing it at a real account login.');
    } catch (err) {
      handleError(err);
    }
  });

profileCmd
  .command('list')
  .description('list configured profiles')
  .action(() => {
    try {
      const rows = listProfiles(getConfigPath());
      if (rows.length === 0) {
        console.log('No profiles configured yet. Run "bpt profile add <name>".');
        return;
      }
      const header = ['NAME', 'PROXY', 'TIMEZONE', 'DEVICE', 'LAUNCHED'];
      const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(Object.values(r)[i]).length)));
      const printRow = (cells) => console.log(cells.map((c, i) => String(c).padEnd(widths[i])).join('  '));
      printRow(header);
      printRow(widths.map((w) => '-'.repeat(w)));
      for (const r of rows) {
        printRow([r.name, r.proxyHost, r.timezone, r.deviceType, r.launched ? 'yes' : 'no']);
      }
    } catch (err) {
      handleError(err);
    }
  });

profileCmd
  .command('remove <name>')
  .description('remove a profile from the config')
  .option('--purge', 'also delete the profile\'s userDataDir from disk')
  .action((name, opts) => {
    try {
      const { userDataDir, purged } = removeProfile(getConfigPath(), name, !!opts.purge);
      console.log(`Removed profile "${name}" from config.`);
      if (purged) {
        console.log(`Purged data directory: ${userDataDir}`);
      } else {
        console.log(`Kept data directory on disk: ${userDataDir} (pass --purge to delete it)`);
      }
    } catch (err) {
      handleError(err);
    }
  });

profileCmd
  .command('import <file>')
  .description('bulk-create profiles from a CSV file (columns: name,host,port,username,password,scheme,timezone,locale,deviceType)')
  .action((file) => {
    try {
      const created = importProfiles(getConfigPath(), file);
      console.log(`Imported ${created.length} profile(s): ${created.map((p) => p.name).join(', ')}`);
    } catch (err) {
      handleError(err);
    }
  });

profileCmd
  .command('export <name>')
  .description('export a single profile\'s config to a portable YAML/JSON file')
  .option('-o, --output <path>', 'output file path', 'profile-export.yaml')
  .action((name, opts) => {
    try {
      const outPath = exportProfile(getConfigPath(), name, opts.output);
      console.log(`Exported profile "${name}" to ${outPath}`);
    } catch (err) {
      handleError(err);
    }
  });

profileCmd
  .command('audit <name>')
  .description('launch the profile headless and run automated leak/consistency checks')
  .action(async (name) => {
    try {
      const config = loadConfig(getConfigPath());
      const profile = findProfile(config, name);
      console.log(`Testing proxy for "${name}" to establish expected exit IP...`);
      const proxyResult = await testProxy(profile.proxy);
      if (!proxyResult.reachable) {
        console.log(`Warning: could not verify proxy exit IP (${proxyResult.error}). Continuing audit without an IP to compare against.`);
      } else {
        console.log(`Proxy exit IP: ${proxyResult.ip} (${proxyResult.city || ''}, ${proxyResult.country || ''})`);
      }
      console.log(`Launching "${name}" headless for audit...`);
      const results = await auditProfile(profile, config, { proxyExitIp: proxyResult.reachable ? proxyResult.ip : null });
      console.log('');
      for (const r of results) {
        console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.check}`);
        console.log(`       ${r.detail}`);
      }
      const failed = results.filter((r) => !r.pass);
      if (failed.length > 0) {
        console.log(`\n${failed.length} check(s) failed. Resolve before using this profile for a real account login.`);
        process.exitCode = 1;
      } else {
        console.log('\nAll automated checks passed. Still recommend a manual look at CreepJS\'s own trust score.');
      }
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('proxy')
  .command('test <name>')
  .description('check proxy reachability and resolved exit IP/region')
  .action(async (name) => {
    try {
      const config = loadConfig(getConfigPath());
      const profile = findProfile(config, name);
      const result = await testProxy(profile.proxy);
      if (result.reachable) {
        console.log(`Reachable. Exit IP: ${result.ip}, region: ${result.region || 'unknown'}, city: ${result.city || 'unknown'}, country: ${result.country || 'unknown'}`);
      } else {
        console.log(`Not reachable: ${result.error}`);
        process.exitCode = 1;
      }
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('launch <name>')
  .description('launch a profile and connect to it over CDP')
  .option('--headless', 'force headless mode for this launch')
  .option('--debug-port <n>', 'use a specific remote-debugging-port instead of an auto-assigned one', (v) => parseInt(v, 10))
  .action(async (name, opts) => {
    try {
      const config = loadConfig(getConfigPath());
      const profile = findProfile(config, name);
      const handle = await launchProfile(profile, config, {
        headless: opts.headless,
        debugPort: opts.debugPort,
      });
      console.log(`Profile "${name}" launched.`);
      console.log(`CDP endpoint: ${handle.cdpEndpoint}`);

      const shutdown = async (signal) => {
        console.log(`\nReceived ${signal}, cleaning up...`);
        await handle.cleanup();
        process.exit(0);
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      handle.child.on('exit', async () => {
        console.log('Browser process exited, cleaning up proxy wrapper...');
        await handle.cleanup();
        process.exit(0);
      });
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('engine')
  .command('update')
  .description('check for a newer fingerprint-chromium release (manual, never automatic)')
  .action(async () => {
    try {
      const config = loadConfig(getConfigPath());
      console.log(`Current binaryPath: ${config.binaryPath}`);
      console.log('Checking https://github.com/adryfish/fingerprint-chromium/releases for a newer build...');
      const res = await fetch('https://api.github.com/repos/adryfish/fingerprint-chromium/releases/latest', {
        headers: { 'User-Agent': 'browser-profile-tool' },
      });
      if (!res.ok) {
        throw new Error(`GitHub API returned HTTP ${res.status}`);
      }
      const data = await res.json();
      console.log(`Latest release: ${data.tag_name} — ${data.html_url}`);
      console.log('This command only reports the latest version; it never downloads or replaces your binary automatically.');
      console.log('Download it yourself from the URL above, then update binaryPath / BPT_BINARY_PATH once you have confirmed it.');
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('config')
  .command('path')
  .description('print the resolved config file path')
  .action(() => {
    console.log(getConfigPath());
  });

program.parseAsync(process.argv);
