/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ProxyConflictDetector,
  parseProxyUrl,
  type ProxyConflictDetectorConfig,
} from './proxyConflictDetector.js';

// ── Helpers ─────────────────────────────────────────────────────────────

const DEFAULT_DETECTOR_CONFIG: ProxyConflictDetectorConfig = {
  proxyPort: 8877,
  socks5Port: 8878,
};

function makeDetector(
  overrides?: Partial<ProxyConflictDetectorConfig>,
): ProxyConflictDetector {
  return new ProxyConflictDetector({
    ...DEFAULT_DETECTOR_CONFIG,
    ...overrides,
  });
}

function cleanEnv(): Record<string, string | undefined> {
  return {};
}

// ── parseProxyUrl ───────────────────────────────────────────────────────

describe('parseProxyUrl', () => {
  it('parses http proxy URL', () => {
    const result = parseProxyUrl('http://proxy.corp.com:3128');
    expect(result).toEqual({
      hostname: 'proxy.corp.com',
      port: 3128,
      protocol: 'http',
    });
  });

  it('parses https proxy URL', () => {
    const result = parseProxyUrl('https://secure-proxy.com:8443');
    expect(result).toEqual({
      hostname: 'secure-proxy.com',
      port: 8443,
      protocol: 'https',
    });
  });

  it('parses socks5 URL', () => {
    const result = parseProxyUrl('socks5://localhost:1080');
    expect(result).toEqual({
      hostname: 'localhost',
      port: 1080,
      protocol: 'socks5',
    });
  });

  it('defaults to port 80 for http without port', () => {
    const result = parseProxyUrl('http://proxy.com');
    expect(result?.port).toBe(80);
  });

  it('defaults to port 443 for https without port', () => {
    const result = parseProxyUrl('https://proxy.com');
    expect(result?.port).toBe(443);
  });

  it('handles URL without protocol prefix', () => {
    const result = parseProxyUrl('proxy.corp.com:3128');
    expect(result?.hostname).toBe('proxy.corp.com');
    expect(result?.port).toBe(3128);
  });

  it('returns null for unparseable input', () => {
    expect(parseProxyUrl('')).toBeNull();
    expect(parseProxyUrl('not a url at all : : :')).toBeNull();
  });

  it('parses localhost URL', () => {
    const result = parseProxyUrl('http://localhost:8877');
    expect(result?.hostname).toBe('localhost');
    expect(result?.port).toBe(8877);
  });

  it('parses IPv4 URL', () => {
    const result = parseProxyUrl('http://127.0.0.1:8877');
    expect(result?.hostname).toBe('127.0.0.1');
    expect(result?.port).toBe(8877);
  });
});

// ── Clean Environment (No Conflicts) ────────────────────────────────────

describe('ProxyConflictDetector — no conflicts', () => {
  let detector: ProxyConflictDetector;

  beforeEach(() => {
    detector = makeDetector();
  });

  it('returns canStart=true with clean environment', () => {
    const result = detector.detect(cleanEnv());
    expect(result.canStart).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });

  it('ignores empty proxy env vars', () => {
    const result = detector.detect({
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: undefined,
    });
    expect(result.canStart).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });

  it('ignores whitespace-only env vars', () => {
    const result = detector.detect({
      GEMINI_SANDBOX_PROXY_COMMAND: '   ',
    });
    expect(result.canStart).toBe(true);
  });
});

// ── GEMINI_SANDBOX_PROXY_COMMAND ────────────────────────────────────────

describe('ProxyConflictDetector — external proxy command', () => {
  let detector: ProxyConflictDetector;

  beforeEach(() => {
    detector = makeDetector();
  });

  it('detects external proxy command as error', () => {
    const result = detector.detect({
      GEMINI_SANDBOX_PROXY_COMMAND: '/usr/local/bin/my-proxy',
    });
    expect(result.canStart).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].severity).toBe('error');
    expect(result.conflicts[0].message).toContain(
      'GEMINI_SANDBOX_PROXY_COMMAND',
    );
  });

  it('includes the command value in the message', () => {
    const result = detector.detect({
      GEMINI_SANDBOX_PROXY_COMMAND: 'mitmproxy --listen-port 8080',
    });
    expect(result.conflicts[0].message).toContain(
      'mitmproxy --listen-port 8080',
    );
  });

  it('provides a recommendation to remove the env var', () => {
    const result = detector.detect({
      GEMINI_SANDBOX_PROXY_COMMAND: '/bin/proxy',
    });
    expect(result.conflicts[0].recommendation).toContain('Remove');
  });
});

// ── Existing Proxy Env Vars ─────────────────────────────────────────────

describe('ProxyConflictDetector — existing proxy env vars', () => {
  let detector: ProxyConflictDetector;

  beforeEach(() => {
    detector = makeDetector();
  });

  it('warns when HTTP_PROXY points to an external proxy', () => {
    const result = detector.detect({
      HTTP_PROXY: 'http://corporate-proxy.com:3128',
    });
    expect(result.canStart).toBe(true); // Warning, not error
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].severity).toBe('warning');
    expect(result.conflicts[0].message).toContain('HTTP_PROXY');
    expect(result.conflicts[0].message).toContain('corporate-proxy.com');
  });

  it('warns for HTTPS_PROXY', () => {
    const result = detector.detect({
      HTTPS_PROXY: 'http://proxy.corp:8080',
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].message).toContain('HTTPS_PROXY');
  });

  it('warns for ALL_PROXY with socks5', () => {
    const result = detector.detect({
      ALL_PROXY: 'socks5://socks-server.com:1080',
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].message).toContain('ALL_PROXY');
  });

  it('warns for lowercase proxy env vars', () => {
    const result = detector.detect({
      http_proxy: 'http://proxy.com:3128',
      https_proxy: 'http://proxy.com:3128',
    });
    expect(result.conflicts).toHaveLength(2);
    expect(result.conflicts[0].message).toContain('http_proxy');
    expect(result.conflicts[1].message).toContain('https_proxy');
  });

  it('does NOT warn when proxy env vars point to our own ports', () => {
    const result = detector.detect({
      HTTP_PROXY: 'http://localhost:8877',
      HTTPS_PROXY: 'http://127.0.0.1:8877',
      ALL_PROXY: 'socks5://localhost:8878',
    });
    // These point to our proxy — no conflict
    expect(result.conflicts).toHaveLength(0);
  });

  it('warns for unparseable proxy URLs', () => {
    const result = detector.detect({
      HTTP_PROXY: 'not-a-valid-url : : :',
    });
    expect(result.canStart).toBe(true);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].severity).toBe('warning');
    expect(result.conflicts[0].message).toContain('could not be parsed');
  });

  it('detects multiple proxy env var conflicts', () => {
    const result = detector.detect({
      HTTP_PROXY: 'http://proxy1.com:3128',
      HTTPS_PROXY: 'http://proxy2.com:3128',
      http_proxy: 'http://proxy3.com:3128',
    });
    expect(result.conflicts).toHaveLength(3);
  });
});

// ── NO_PROXY Configuration ──────────────────────────────────────────────

describe('ProxyConflictDetector — NO_PROXY', () => {
  let detector: ProxyConflictDetector;

  beforeEach(() => {
    detector = makeDetector();
  });

  it('warns when NO_PROXY contains non-localhost domains', () => {
    const result = detector.detect({
      NO_PROXY: 'localhost,.internal.corp,192.168.1.0/24',
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].severity).toBe('warning');
    expect(result.conflicts[0].message).toContain('.internal.corp');
    expect(result.conflicts[0].message).toContain('192.168.1.0/24');
  });

  it('reports info when NO_PROXY only has localhost entries', () => {
    const result = detector.detect({
      NO_PROXY: 'localhost,127.0.0.1,::1',
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].severity).toBe('info');
    expect(result.conflicts[0].message).toContain('only contains localhost');
  });

  it('handles lowercase no_proxy', () => {
    const result = detector.detect({
      no_proxy: '.corp.com',
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].message).toContain('no_proxy');
  });

  it('handles empty NO_PROXY gracefully', () => {
    const result = detector.detect({ NO_PROXY: '' });
    expect(result.conflicts).toHaveLength(0);
  });

  it('handles NO_PROXY with only commas/whitespace', () => {
    const result = detector.detect({ NO_PROXY: ' , , ' });
    expect(result.conflicts).toHaveLength(0);
  });
});

// ── Port Conflicts ──────────────────────────────────────────────────────

describe('ProxyConflictDetector — port conflicts', () => {
  it('detects same port for HTTP and SOCKS5 as error', () => {
    const detector = makeDetector({
      proxyPort: 8877,
      socks5Port: 8877,
    });
    const result = detector.detect(cleanEnv());
    expect(result.canStart).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].severity).toBe('error');
    expect(result.conflicts[0].message).toContain('same');
  });

  it('no port conflict when ports are different', () => {
    const detector = makeDetector({
      proxyPort: 8877,
      socks5Port: 8878,
    });
    const result = detector.detect(cleanEnv());
    expect(result.conflicts).toHaveLength(0);
  });
});

// ── Severity Ordering ───────────────────────────────────────────────────

describe('ProxyConflictDetector — severity ordering', () => {
  it('sorts errors before warnings before info', () => {
    const detector = makeDetector({
      proxyPort: 8877,
      socks5Port: 8877, // error: same port
    });
    const result = detector.detect({
      GEMINI_SANDBOX_PROXY_COMMAND: '/bin/proxy', // error
      HTTP_PROXY: 'http://corp-proxy:3128', // warning
      NO_PROXY: 'localhost', // info
    });

    expect(result.conflicts.length).toBeGreaterThanOrEqual(3);
    // All errors first
    const severities = result.conflicts.map((c) => c.severity);
    const errorIdx = severities.lastIndexOf('error');
    const warningIdx = severities.indexOf('warning');
    const infoIdx = severities.indexOf('info');

    if (warningIdx >= 0) {
      expect(errorIdx).toBeLessThan(warningIdx);
    }
    if (infoIdx >= 0 && warningIdx >= 0) {
      expect(warningIdx).toBeLessThan(infoIdx);
    }
  });

  it('canStart is false when any error exists', () => {
    const detector = makeDetector();
    const result = detector.detect({
      GEMINI_SANDBOX_PROXY_COMMAND: 'my-proxy',
    });
    expect(result.canStart).toBe(false);
  });

  it('canStart is true when only warnings exist', () => {
    const detector = makeDetector();
    const result = detector.detect({
      HTTP_PROXY: 'http://external-proxy:3128',
    });
    expect(result.canStart).toBe(true);
  });
});

// ── Combined Scenarios ──────────────────────────────────────────────────

describe('ProxyConflictDetector — combined scenarios', () => {
  it('corporate environment with multiple proxy settings', () => {
    const detector = makeDetector();
    const result = detector.detect({
      HTTP_PROXY: 'http://proxy.corp.com:3128',
      HTTPS_PROXY: 'http://proxy.corp.com:3128',
      http_proxy: 'http://proxy.corp.com:3128',
      https_proxy: 'http://proxy.corp.com:3128',
      NO_PROXY: 'localhost,127.0.0.1,.corp.com',
    });

    // Should be able to start (only warnings), but with multiple warnings
    expect(result.canStart).toBe(true);
    expect(result.conflicts.length).toBeGreaterThanOrEqual(4);
  });

  it('clean development environment', () => {
    const detector = makeDetector();
    const result = detector.detect({
      HOME: '/home/user',
      PATH: '/usr/bin:/usr/local/bin',
      SHELL: '/bin/zsh',
    });
    expect(result.canStart).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });

  it('environment where our proxy is already configured', () => {
    const detector = makeDetector();
    const result = detector.detect({
      HTTP_PROXY: 'http://localhost:8877',
      HTTPS_PROXY: 'http://localhost:8877',
      ALL_PROXY: 'socks5://localhost:8878',
      NO_PROXY: 'localhost,127.0.0.1',
    });
    // All pointing to our ports + localhost NO_PROXY = harmless
    expect(result.canStart).toBe(true);
    // Only the NO_PROXY info message
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].severity).toBe('info');
  });
});
