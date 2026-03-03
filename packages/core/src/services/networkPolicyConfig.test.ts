/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  validateConfig,
  mergeConfigs,
  toDomainFilterConfig,
  DEFAULT_CONFIG,
  DEFAULT_ALLOWLIST,
  type NetworkPolicyConfig,
} from './networkPolicyConfig.js';

// ── Default Config ──────────────────────────────────────────────────────

describe('DEFAULT_CONFIG', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_CONFIG.defaultAction).toBe('prompt');
    expect(DEFAULT_CONFIG.allowlist).toEqual([]);
    expect(DEFAULT_CONFIG.denylist).toEqual([]);
    expect(DEFAULT_CONFIG.logging).toBe(false);
    expect(DEFAULT_CONFIG.proxyPort).toBe(8877);
    expect(DEFAULT_CONFIG.socks5Port).toBe(8878);
    expect(DEFAULT_CONFIG.promptTimeout).toBe(30);
  });

  it('uses port 8877 to match Seatbelt *-proxied profiles', () => {
    // The *-proxied profiles enforce (allow network-outbound (remote tcp "localhost:8877"))
    expect(DEFAULT_CONFIG.proxyPort).toBe(8877);
  });
});

describe('DEFAULT_ALLOWLIST', () => {
  it('includes common package registries', () => {
    expect(DEFAULT_ALLOWLIST).toContain('.npmjs.org');
    expect(DEFAULT_ALLOWLIST).toContain('.pypi.org');
    expect(DEFAULT_ALLOWLIST).toContain('.github.com');
  });
});

// ── Validation — Valid Configs ──────────────────────────────────────────

describe('validateConfig — valid configs', () => {
  it('accepts an empty object (all defaults)', () => {
    const result = validateConfig({});
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.config).toEqual(DEFAULT_CONFIG);
  });

  it('accepts a fully specified config', () => {
    const result = validateConfig({
      defaultAction: 'denied',
      allowlist: ['.github.com', 'registry.npmjs.org'],
      denylist: ['evil.com'],
      logging: true,
      logPath: '/tmp/proxy.jsonl',
      proxyPort: 9000,
      socks5Port: 9001,
      promptTimeout: 60,
    });
    expect(result.valid).toBe(true);
    expect(result.config.defaultAction).toBe('denied');
    expect(result.config.allowlist).toEqual([
      '.github.com',
      'registry.npmjs.org',
    ]);
    expect(result.config.proxyPort).toBe(9000);
  });

  it('accepts "allowed" as defaultAction', () => {
    const result = validateConfig({ defaultAction: 'allowed' });
    expect(result.valid).toBe(true);
  });

  it('accepts "denied" as defaultAction', () => {
    const result = validateConfig({ defaultAction: 'denied' });
    expect(result.valid).toBe(true);
  });

  it('accepts "prompt" as defaultAction', () => {
    const result = validateConfig({ defaultAction: 'prompt' });
    expect(result.valid).toBe(true);
  });

  it('accepts edge port numbers (1 and 65535)', () => {
    const result = validateConfig({ proxyPort: 1, socks5Port: 65535 });
    expect(result.valid).toBe(true);
    expect(result.config.proxyPort).toBe(1);
    expect(result.config.socks5Port).toBe(65535);
  });

  it('accepts minimum timeout (1 second)', () => {
    const result = validateConfig({ promptTimeout: 1 });
    expect(result.valid).toBe(true);
  });

  it('accepts maximum timeout (300 seconds)', () => {
    const result = validateConfig({ promptTimeout: 300 });
    expect(result.valid).toBe(true);
  });
});

// ── Validation — Invalid Fields ─────────────────────────────────────────

describe('validateConfig — invalid fields', () => {
  it('rejects invalid defaultAction', () => {
    const result = validateConfig({ defaultAction: 'block' });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].field).toBe('defaultAction');
  });

  it('rejects non-string defaultAction', () => {
    const result = validateConfig({ defaultAction: 42 });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('defaultAction');
  });

  it('rejects non-array allowlist', () => {
    const result = validateConfig({ allowlist: 'not-an-array' });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('allowlist');
  });

  it('rejects allowlist with non-string entries', () => {
    const result = validateConfig({ allowlist: ['.github.com', 42, ''] });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('allowlist');
    // Invalid entries are filtered out in the config
    expect(result.config.allowlist).toEqual(['.github.com']);
  });

  it('rejects non-array denylist', () => {
    const result = validateConfig({ denylist: {} });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('denylist');
  });

  it('rejects non-boolean logging', () => {
    const result = validateConfig({ logging: 'yes' });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('logging');
  });

  it('rejects empty logPath', () => {
    const result = validateConfig({ logPath: '' });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('logPath');
  });

  it('rejects non-integer proxyPort', () => {
    const result = validateConfig({ proxyPort: 8877.5 });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('proxyPort');
  });

  it('rejects proxyPort below 1', () => {
    const result = validateConfig({ proxyPort: 0 });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('proxyPort');
  });

  it('rejects proxyPort above 65535', () => {
    const result = validateConfig({ proxyPort: 70000 });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('proxyPort');
  });

  it('rejects promptTimeout below 1', () => {
    const result = validateConfig({ promptTimeout: 0 });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('promptTimeout');
  });

  it('rejects promptTimeout above 300', () => {
    const result = validateConfig({ promptTimeout: 600 });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('promptTimeout');
  });

  it('rejects same port for proxy and socks5', () => {
    const result = validateConfig({ proxyPort: 8877, socks5Port: 8877 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'socks5Port')).toBe(true);
  });

  it('does not flag port collision when only one port matches the other default', () => {
    // Setting proxyPort to 8878 (the default socks5Port) should NOT trigger
    // a collision error, because socks5Port was not explicitly provided.
    const result = validateConfig({ proxyPort: 8878 });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('collects multiple validation errors', () => {
    const result = validateConfig({
      defaultAction: 'invalid',
      proxyPort: -1,
      promptTimeout: 999,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ── Merge Strategy ──────────────────────────────────────────────────────

describe('mergeConfigs', () => {
  const globalConfig: NetworkPolicyConfig = {
    defaultAction: 'prompt',
    allowlist: ['.github.com', '.npmjs.org'],
    denylist: ['evil.com'],
    logging: true,
    logPath: '.gemini/network-log.jsonl',
    proxyPort: 8877,
    socks5Port: 8878,
    promptTimeout: 30,
  };

  it('returns global config when project is empty', () => {
    const merged = mergeConfigs(globalConfig, {});
    expect(merged).toEqual(globalConfig);
  });

  it('project scalars override global scalars', () => {
    const merged = mergeConfigs(globalConfig, {
      defaultAction: 'denied',
      promptTimeout: 60,
    });
    expect(merged.defaultAction).toBe('denied');
    expect(merged.promptTimeout).toBe(60);
  });

  it('project allowlist extends global allowlist (UNION)', () => {
    const merged = mergeConfigs(globalConfig, {
      allowlist: ['api.company.com', '.internal.corp'],
    });
    expect(merged.allowlist).toEqual([
      '.github.com',
      '.npmjs.org',
      'api.company.com',
      '.internal.corp',
    ]);
  });

  it('project denylist extends global denylist (UNION)', () => {
    const merged = mergeConfigs(globalConfig, {
      denylist: ['malware.net'],
    });
    expect(merged.denylist).toEqual(['evil.com', 'malware.net']);
  });

  it('deduplicates allowlist entries', () => {
    const merged = mergeConfigs(globalConfig, {
      allowlist: ['.github.com', 'new.com'],
    });
    // .github.com appears in both global and project — should appear once
    expect(merged.allowlist.filter((e) => e === '.github.com')).toHaveLength(1);
    expect(merged.allowlist).toEqual(['.github.com', '.npmjs.org', 'new.com']);
  });

  it('deduplicates denylist entries', () => {
    const merged = mergeConfigs(globalConfig, {
      denylist: ['evil.com', 'new-evil.com'],
    });
    expect(merged.denylist.filter((e) => e === 'evil.com')).toHaveLength(1);
  });

  it('preserves unspecified global values', () => {
    const merged = mergeConfigs(globalConfig, {
      defaultAction: 'denied',
    });
    expect(merged.logging).toBe(true);
    expect(merged.proxyPort).toBe(8877);
    expect(merged.logPath).toBe('.gemini/network-log.jsonl');
  });

  it('project can override logging to false', () => {
    const merged = mergeConfigs(globalConfig, { logging: false });
    expect(merged.logging).toBe(false);
  });

  it('project can override ports', () => {
    const merged = mergeConfigs(globalConfig, {
      proxyPort: 9000,
      socks5Port: 9001,
    });
    expect(merged.proxyPort).toBe(9000);
    expect(merged.socks5Port).toBe(9001);
  });
});

// ── toDomainFilterConfig ────────────────────────────────────────────────

describe('toDomainFilterConfig', () => {
  it('extracts only the filter-relevant fields', () => {
    const full: NetworkPolicyConfig = {
      defaultAction: 'denied',
      allowlist: ['.github.com'],
      denylist: ['evil.com'],
      logging: true,
      logPath: '/tmp/log.jsonl',
      proxyPort: 8877,
      socks5Port: 8878,
      promptTimeout: 30,
    };

    const filterConfig = toDomainFilterConfig(full);
    expect(filterConfig).toEqual({
      defaultAction: 'denied',
      allowlist: ['.github.com'],
      denylist: ['evil.com'],
    });

    // Should NOT contain proxy-specific fields
    expect(filterConfig).not.toHaveProperty('proxyPort');
    expect(filterConfig).not.toHaveProperty('logging');
  });
});

// ── Edge Cases ──────────────────────────────────────────────────────────

describe('validateConfig — edge cases', () => {
  it('ignores unknown fields without error', () => {
    const result = validateConfig({
      defaultAction: 'prompt',
      unknownField: 'whatever',
    });
    expect(result.valid).toBe(true);
  });

  it('handles null values gracefully', () => {
    const result = validateConfig({ allowlist: null });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('allowlist');
  });

  it('filters empty strings from allowlist', () => {
    const result = validateConfig({
      allowlist: ['.github.com', '', '  ', 'valid.com'],
    });
    // Empty strings are invalid entries
    expect(result.config.allowlist).toEqual(['.github.com', 'valid.com']);
  });
});
