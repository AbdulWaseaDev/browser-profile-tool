'use strict';

const http = require('http');
const { URL } = require('url');
const proxyChain = require('proxy-chain');

// Plain-HTTP IP/geo check endpoint so a request can be forwarded through the local
// unauthenticated proxy with a standard absolute-URI HTTP proxy request, with no need for
// an HTTPS CONNECT tunnel or an extra TLS-over-proxy dependency.
const IP_CHECK_URL = 'http://ip-api.com/json/?fields=status,message,query,country,regionName,city';

/**
 * Route a request through the profile's proxy (wrapped via proxy-chain if it needs
 * credentials) and hit a public IP-check endpoint, so a dead or region-mismatched proxy is
 * caught before it's ever used to launch a real profile.
 */
async function testProxy(proxy, timeoutMs = 15000) {
  let anonymizedUrl = null;
  try {
    let proxyUrl;
    if (proxy.username && proxy.password) {
      const scheme = proxy.scheme === 'socks5' ? 'socks5' : 'http';
      const upstreamUrl = `${scheme}://${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@${proxy.host}:${proxy.port}`;
      anonymizedUrl = await proxyChain.anonymizeProxy(upstreamUrl);
      proxyUrl = anonymizedUrl;
    } else {
      proxyUrl = `http://${proxy.host}:${proxy.port}`;
    }

    const proxyLoc = new URL(proxyUrl);
    const target = new URL(IP_CHECK_URL);

    const body = await new Promise((resolve, reject) => {
      const req = http.request({
        host: proxyLoc.hostname,
        port: proxyLoc.port,
        method: 'GET',
        path: target.href, // absolute-URI form required when talking to an HTTP proxy
        headers: { Host: target.host },
        timeout: timeoutMs,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Proxy responded with HTTP ${res.statusCode}`));
          } else {
            resolve(data);
          }
        });
      });
      req.on('timeout', () => { req.destroy(new Error('Proxy request timed out')); });
      req.on('error', reject);
      req.end();
    });

    const parsed = JSON.parse(body);
    if (parsed.status !== 'success') {
      return { reachable: false, error: parsed.message || 'IP-check endpoint reported failure' };
    }
    return {
      reachable: true,
      ip: parsed.query,
      country: parsed.country,
      region: parsed.regionName,
      city: parsed.city,
    };
  } catch (err) {
    return { reachable: false, error: err.message };
  } finally {
    if (anonymizedUrl) {
      await proxyChain.closeAnonymizedProxy(anonymizedUrl, true).catch(() => {});
    }
  }
}

module.exports = { testProxy, IP_CHECK_URL };
