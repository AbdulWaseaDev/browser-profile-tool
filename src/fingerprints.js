'use strict';

const crypto = require('crypto');

/**
 * Device-profile templates.
 *
 * Each template is a bundle of internally-consistent values (OS, browser
 * version, screen resolution, hardware concurrency, GPU vendor/renderer,
 * font list) so that fingerprint-chromium's --fingerprint-* flags never
 * describe a machine that couldn't exist (e.g. a mobile GPU string paired
 * with a 1440p desktop resolution).
 *
 * fingerprint-chromium's --fingerprint-platform only accepts windows,
 * linux, or macos (confirmed against the project README) — there is no
 * native "android" platform value. For deviceType: mobile we use a linux
 * base (closest kernel lineage) and layer CDP-level emulation + a UA
 * override on top in launcher.js. This is called out again there and in
 * the README so it isn't mistaken for a natively-supported mode.
 *
 * Deliberately no `brandVersion` field: an earlier version of this file hardcoded
 * --fingerprint-brand-version, which only overrides the Client Hints API
 * (navigator.userAgentData), not the actual navigator.userAgent/appVersion string —
 * that always reflects the real underlying binary's version. A hardcoded value here
 * drifts out of sync with the real UA every time the fingerprint-chromium binary is
 * updated, producing a UA-vs-Client-Hints version mismatch — confirmed live via
 * CreepJS (UA said Chrome 148, userAgentData said the hardcoded 128) — which is one
 * of the most well-known bot-detection heuristics. Leaving --fingerprint-brand-version
 * unset lets Client Hints derive from the real binary version too, so it always
 * matches the UA string automatically, regardless of which build is in binaryPath.
 */
const TEMPLATES = {
  'windows-chrome-1080p': {
    deviceType: 'desktop',
    platform: 'windows',
    platformVersion: '10.0',
    brand: 'Chrome',
    hardwareConcurrency: 8,
    screen: { width: 1920, height: 1080, colorDepth: 24, pixelRatio: 1 },
    gpuVendor: 'Google Inc. (Intel)',
    gpuRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    fonts: ['Arial', 'Calibri', 'Cambria', 'Consolas', 'Georgia', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Verdana'],
  },
  'windows-chrome-1440p': {
    deviceType: 'desktop',
    platform: 'windows',
    platformVersion: '10.0',
    brand: 'Chrome',
    hardwareConcurrency: 12,
    screen: { width: 2560, height: 1440, colorDepth: 24, pixelRatio: 1 },
    gpuVendor: 'Google Inc. (NVIDIA)',
    gpuRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    fonts: ['Arial', 'Calibri', 'Cambria', 'Consolas', 'Georgia', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Verdana'],
  },
  'macos-chrome-1440p': {
    deviceType: 'desktop',
    platform: 'macos',
    platformVersion: '14.5',
    brand: 'Chrome',
    hardwareConcurrency: 8,
    screen: { width: 2560, height: 1600, colorDepth: 30, pixelRatio: 2 },
    gpuVendor: 'Google Inc. (Apple)',
    gpuRenderer: 'ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)',
    fonts: ['Helvetica Neue', 'Helvetica', 'Arial', 'Times New Roman', 'Menlo', 'Monaco', 'Geneva'],
  },
  'linux-chrome-1080p': {
    deviceType: 'desktop',
    platform: 'linux',
    platformVersion: '',
    brand: 'Chrome',
    hardwareConcurrency: 8,
    screen: { width: 1920, height: 1080, colorDepth: 24, pixelRatio: 1 },
    gpuVendor: 'Google Inc. (Mesa)',
    gpuRenderer: 'ANGLE (Mesa, llvmpipe (LLVM 15.0.7, 256 bits), OpenGL 4.5)',
    fonts: ['DejaVu Sans', 'DejaVu Serif', 'Liberation Sans', 'Liberation Serif', 'Ubuntu'],
  },
  'android-chrome-mobile': {
    deviceType: 'mobile',
    platform: 'linux', // see module comment — Android is not a native --fingerprint-platform value
    platformVersion: '',
    brand: 'Chrome',
    hardwareConcurrency: 8,
    screen: { width: 412, height: 915, colorDepth: 24, pixelRatio: 2.625 },
    gpuVendor: 'Google Inc. (Qualcomm)',
    gpuRenderer: 'ANGLE (Qualcomm, Adreno (TM) 660, OpenGL ES 3.2)',
    fonts: ['Roboto', 'Noto Sans', 'Droid Sans'],
    // Applied via CDP + UA override in launcher.js, not a native flag.
    mobileUserAgentOsToken: 'Android 14; Pixel 7',
  },
};

function listTemplateNames() {
  return Object.keys(TEMPLATES);
}

function getTemplate(name) {
  const tpl = TEMPLATES[name];
  if (!tpl) {
    throw new Error(`Unknown fingerprint template "${name}". Available: ${listTemplateNames().join(', ')}`);
  }
  return tpl;
}

function defaultTemplateForDeviceType(deviceType) {
  return deviceType === 'mobile' ? 'android-chrome-mobile' : 'windows-chrome-1080p';
}

/** 32-bit integer seed, as required by fingerprint-chromium's --fingerprint flag. */
function generateSeed() {
  return String(crypto.randomBytes(4).readUInt32BE(0));
}

/**
 * Generate a fresh, internally-consistent fingerprint block for a new profile.
 * Called only from `profile add` / `profile import` — never touched again after that,
 * per the requirement that a profile's fingerprint must never silently change.
 */
function generateFingerprint(deviceType, templateName) {
  const template = templateName || defaultTemplateForDeviceType(deviceType);
  getTemplate(template); // throws if unknown
  return {
    template,
    seed: generateSeed(),
  };
}

module.exports = {
  TEMPLATES,
  listTemplateNames,
  getTemplate,
  defaultTemplateForDeviceType,
  generateSeed,
  generateFingerprint,
};
