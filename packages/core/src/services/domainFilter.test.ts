/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DomainFilter,
  compilePattern,
  type DomainFilterConfig,
} from './domainFilter.js';

// ── Pattern Compilation ─────────────────────────────────────────────────

describe('compilePattern', () => {
  it('classifies an exact domain as "exact"', () => {
    const rule = compilePattern('api.google.com');
    expect(rule.type).toBe('exact');
    expect(rule.compiled).toBeNull();
  });

  it('classifies a leading-dot pattern as "suffix"', () => {
    const rule = compilePattern('.google.com');
    expect(rule.type).toBe('suffix');
    expect(rule.compiled).toBeNull();
  });

  it('classifies a wildcard pattern as "glob"', () => {
    const rule = compilePattern('*.google.com');
    expect(rule.type).toBe('glob');
    expect(rule.compiled).toBeInstanceOf(RegExp);
  });

  it('classifies the catch-all "**" as glob matching everything', () => {
    const rule = compilePattern('**');
    expect(rule.type).toBe('glob');
    expect(rule.compiled!.test('anything.at.all')).toBe(true);
  });

  it('classifies IP glob patterns as "glob"', () => {
    const rule = compilePattern('192.168.*.*');
    expect(rule.type).toBe('glob');
    expect(rule.compiled).toBeInstanceOf(RegExp);
  });

  it('preserves the original pattern string', () => {
    const rule = compilePattern('.npmjs.org');
    expect(rule.pattern).toBe('.npmjs.org');
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────

function makeConfig(
  overrides?: Partial<DomainFilterConfig>,
): DomainFilterConfig {
  return {
    defaultAction: 'denied',
    allowlist: [],
    denylist: [],
    ...overrides,
  };
}

// ── Built-in Allowlist ──────────────────────────────────────────────────

describe('DomainFilter — built-in allowlist', () => {
  let filter: DomainFilter;

  beforeEach(() => {
    // Default deny — only builtins should pass
    filter = new DomainFilter(makeConfig({ defaultAction: 'denied' }));
  });

  it('allows localhost', () => {
    expect(filter.check('localhost').decision).toBe('allowed');
    expect(filter.check('localhost').source).toBe('builtin');
  });

  it('allows IPv4 loopback', () => {
    expect(filter.check('127.0.0.1').decision).toBe('allowed');
  });

  it('allows IPv6 loopback', () => {
    expect(filter.check('::1').decision).toBe('allowed');
  });

  it('allows googleapis.com (Gemini API)', () => {
    expect(filter.check('generativelanguage.googleapis.com').decision).toBe(
      'allowed',
    );
  });

  it('allows googleapis.com bare domain', () => {
    expect(filter.check('googleapis.com').decision).toBe('allowed');
  });

  it('allows google.com subdomains (auth)', () => {
    expect(filter.check('accounts.google.com').decision).toBe('allowed');
  });

  it('cannot be overridden by denylist', () => {
    const strictFilter = new DomainFilter(
      makeConfig({
        denylist: ['.googleapis.com', 'localhost'],
      }),
    );
    expect(strictFilter.check('localhost').decision).toBe('allowed');
    expect(strictFilter.check('api.googleapis.com').decision).toBe('allowed');
  });

  it('is case-insensitive', () => {
    expect(filter.check('LOCALHOST').decision).toBe('allowed');
    expect(filter.check('Api.GoogleApis.Com').decision).toBe('allowed');
  });

  it('trims whitespace from hostnames', () => {
    expect(filter.check('  localhost  ').decision).toBe('allowed');
  });
});

// ── Exact Matching ──────────────────────────────────────────────────────

describe('DomainFilter — exact matching', () => {
  it('matches an exact allowlist entry', () => {
    const filter = new DomainFilter(
      makeConfig({ allowlist: ['registry.npmjs.org'] }),
    );
    const result = filter.check('registry.npmjs.org');
    expect(result.decision).toBe('allowed');
    expect(result.source).toBe('allowlist');
    expect(result.matchedRule?.pattern).toBe('registry.npmjs.org');
  });

  it('does not match subdomains for exact patterns', () => {
    const filter = new DomainFilter(makeConfig({ allowlist: ['npmjs.org'] }));
    expect(filter.check('registry.npmjs.org').decision).toBe('denied');
  });

  it('is case-insensitive for exact matches', () => {
    const filter = new DomainFilter(
      makeConfig({ allowlist: ['Registry.NPMJS.org'] }),
    );
    expect(filter.check('registry.npmjs.org').decision).toBe('allowed');
  });
});

// ── Suffix Matching ─────────────────────────────────────────────────────

describe('DomainFilter — suffix matching', () => {
  let filter: DomainFilter;

  beforeEach(() => {
    filter = new DomainFilter(makeConfig({ allowlist: ['.github.com'] }));
  });

  it('matches the bare domain', () => {
    expect(filter.check('github.com').decision).toBe('allowed');
  });

  it('matches subdomains', () => {
    expect(filter.check('api.github.com').decision).toBe('allowed');
  });

  it('matches deep subdomains', () => {
    expect(filter.check('raw.githubusercontent.github.com').decision).toBe(
      'allowed',
    );
  });

  it('does not match unrelated domains', () => {
    expect(filter.check('notgithub.com').decision).toBe('denied');
  });

  it('does not match domains that merely contain the suffix', () => {
    expect(filter.check('evil-github.com').decision).toBe('denied');
  });
});

// ── Glob Matching ───────────────────────────────────────────────────────

describe('DomainFilter — glob matching', () => {
  it('matches subdomains with * pattern', () => {
    const filter = new DomainFilter(
      makeConfig({ allowlist: ['*.github.com'] }),
    );
    expect(filter.check('api.github.com').decision).toBe('allowed');
    expect(filter.check('raw.github.com').decision).toBe('allowed');
  });

  it('does NOT match the bare domain with * pattern', () => {
    const filter = new DomainFilter(
      makeConfig({ allowlist: ['*.github.com'] }),
    );
    // *.github.com requires at least one subdomain label
    expect(filter.check('github.com').decision).toBe('denied');
  });

  it('does not match deep subdomains with single * (label boundary)', () => {
    const filter = new DomainFilter(
      makeConfig({ allowlist: ['*.github.com'] }),
    );
    // [^.]+ stops at the dot, so "a.b.github.com" should NOT match
    expect(filter.check('a.b.github.com').decision).toBe('denied');
  });

  it('matches IP glob patterns', () => {
    const filter = new DomainFilter(makeConfig({ allowlist: ['192.168.*.*'] }));
    expect(filter.check('192.168.1.1').decision).toBe('allowed');
    expect(filter.check('192.168.0.100').decision).toBe('allowed');
    expect(filter.check('10.0.0.1').decision).toBe('denied');
  });

  it('matches the catch-all ** pattern', () => {
    const filter = new DomainFilter(makeConfig({ allowlist: ['**'] }));
    expect(filter.check('anything.at.all.com').decision).toBe('allowed');
  });
});

// ── Priority Rules ──────────────────────────────────────────────────────

describe('DomainFilter — priority rules', () => {
  it('denylist takes priority over allowlist', () => {
    const filter = new DomainFilter(
      makeConfig({
        allowlist: ['.example.com'],
        denylist: ['.example.com'],
      }),
    );
    expect(filter.check('api.example.com').decision).toBe('denied');
    expect(filter.check('api.example.com').source).toBe('denylist');
  });

  it('session allow overrides denylist', () => {
    const filter = new DomainFilter(makeConfig({ denylist: ['evil.com'] }));
    filter.addSessionAllow('evil.com');
    expect(filter.check('evil.com').decision).toBe('allowed');
    expect(filter.check('evil.com').source).toBe('session-allow');
  });

  it('session deny overrides allowlist', () => {
    const filter = new DomainFilter(makeConfig({ allowlist: ['.github.com'] }));
    filter.addSessionDeny('api.github.com');
    expect(filter.check('api.github.com').decision).toBe('denied');
    expect(filter.check('api.github.com').source).toBe('session-deny');
  });

  it('builtin overrides session deny', () => {
    const filter = new DomainFilter(makeConfig());
    filter.addSessionDeny('localhost');
    // Builtin always wins
    expect(filter.check('localhost').decision).toBe('allowed');
    expect(filter.check('localhost').source).toBe('builtin');
  });

  it('builtin overrides everything (denylist + session deny)', () => {
    const filter = new DomainFilter(
      makeConfig({ denylist: ['.googleapis.com'] }),
    );
    filter.addSessionDeny('api.googleapis.com');
    expect(filter.check('api.googleapis.com').decision).toBe('allowed');
  });
});

// ── Default Action ──────────────────────────────────────────────────────

describe('DomainFilter — default action', () => {
  it('uses "denied" as default when configured', () => {
    const filter = new DomainFilter(makeConfig({ defaultAction: 'denied' }));
    expect(filter.check('unknown.com').decision).toBe('denied');
    expect(filter.check('unknown.com').source).toBe('default');
  });

  it('uses "allowed" as default when configured', () => {
    const filter = new DomainFilter(makeConfig({ defaultAction: 'allowed' }));
    expect(filter.check('unknown.com').decision).toBe('allowed');
    expect(filter.check('unknown.com').source).toBe('default');
  });

  it('uses "prompt" as default when configured', () => {
    const filter = new DomainFilter(makeConfig({ defaultAction: 'prompt' }));
    expect(filter.check('unknown.com').decision).toBe('prompt');
    expect(filter.check('unknown.com').source).toBe('default');
  });
});

// ── Session State Management ────────────────────────────────────────────

describe('DomainFilter — session state', () => {
  let filter: DomainFilter;

  beforeEach(() => {
    filter = new DomainFilter(makeConfig());
  });

  it('addSessionAllow makes a domain allowed', () => {
    filter.addSessionAllow('new-service.com');
    expect(filter.check('new-service.com').decision).toBe('allowed');
  });

  it('addSessionDeny makes a domain denied', () => {
    filter.addSessionDeny('bad-service.com');
    expect(filter.check('bad-service.com').decision).toBe('denied');
  });

  it('addSessionAllow removes conflicting session deny', () => {
    filter.addSessionDeny('flip-flop.com');
    filter.addSessionAllow('flip-flop.com');
    expect(filter.check('flip-flop.com').decision).toBe('allowed');
  });

  it('addSessionDeny removes conflicting session allow', () => {
    filter.addSessionAllow('flip-flop.com');
    filter.addSessionDeny('flip-flop.com');
    expect(filter.check('flip-flop.com').decision).toBe('denied');
  });

  it('session decisions are case-insensitive', () => {
    filter.addSessionAllow('MyService.COM');
    expect(filter.check('myservice.com').decision).toBe('allowed');
  });

  it('resetSession clears all session decisions', () => {
    filter.addSessionAllow('a.com');
    filter.addSessionDeny('b.com');
    filter.resetSession();
    // Both should fall through to default (denied)
    expect(filter.check('a.com').decision).toBe('denied');
    expect(filter.check('b.com').decision).toBe('denied');
  });
});

// ── Statistics Tracking ─────────────────────────────────────────────────

describe('DomainFilter — statistics', () => {
  it('starts with zero stats', () => {
    const filter = new DomainFilter(makeConfig());
    const stats = filter.getStats();
    expect(stats.totalChecks).toBe(0);
    expect(stats.allowed).toBe(0);
    expect(stats.denied).toBe(0);
    expect(stats.prompted).toBe(0);
  });

  it('increments totalChecks on each call', () => {
    const filter = new DomainFilter(makeConfig());
    filter.check('a.com');
    filter.check('b.com');
    filter.check('c.com');
    expect(filter.getStats().totalChecks).toBe(3);
  });

  it('tracks allowed count', () => {
    const filter = new DomainFilter(makeConfig({ allowlist: ['allowed.com'] }));
    filter.check('allowed.com');
    filter.check('allowed.com');
    expect(filter.getStats().allowed).toBe(2);
  });

  it('tracks denied count', () => {
    const filter = new DomainFilter(makeConfig({ defaultAction: 'denied' }));
    filter.check('random.com');
    expect(filter.getStats().denied).toBe(1);
  });

  it('tracks prompted count', () => {
    const filter = new DomainFilter(makeConfig({ defaultAction: 'prompt' }));
    filter.check('unknown.com');
    expect(filter.getStats().prompted).toBe(1);
  });

  it('tracks builtin hits separately', () => {
    const filter = new DomainFilter(makeConfig());
    filter.check('localhost');
    filter.check('127.0.0.1');
    expect(filter.getStats().builtinHits).toBe(2);
  });

  it('tracks session allow/deny hits', () => {
    const filter = new DomainFilter(makeConfig());
    filter.addSessionAllow('a.com');
    filter.addSessionDeny('b.com');
    filter.check('a.com');
    filter.check('b.com');
    const stats = filter.getStats();
    expect(stats.sessionAllowHits).toBe(1);
    expect(stats.sessionDenyHits).toBe(1);
  });

  it('returns a copy — mutations do not affect internal state', () => {
    const filter = new DomainFilter(makeConfig());
    const stats = filter.getStats();
    stats.totalChecks = 999;
    expect(filter.getStats().totalChecks).toBe(0);
  });
});

// ── Rule Count Diagnostics ──────────────────────────────────────────────

describe('DomainFilter — getRuleCount', () => {
  it('reports zero rules for empty config', () => {
    const filter = new DomainFilter(makeConfig());
    expect(filter.getRuleCount()).toEqual({ allow: 0, deny: 0 });
  });

  it('reports correct rule counts', () => {
    const filter = new DomainFilter(
      makeConfig({
        allowlist: ['.github.com', 'registry.npmjs.org', '*.pypi.org'],
        denylist: ['evil.com'],
      }),
    );
    expect(filter.getRuleCount()).toEqual({ allow: 3, deny: 1 });
  });
});

// ── Edge Cases ──────────────────────────────────────────────────────────

describe('DomainFilter — edge cases', () => {
  it('handles empty hostname gracefully', () => {
    const filter = new DomainFilter(makeConfig({ defaultAction: 'denied' }));
    expect(filter.check('').decision).toBe('denied');
  });

  it('handles hostname with trailing dot (DNS root)', () => {
    const filter = new DomainFilter(makeConfig({ allowlist: ['example.com'] }));
    // Trailing dot is technically valid DNS but we normalize
    // This should NOT match since we don't strip trailing dots
    const result = filter.check('example.com.');
    expect(result.decision).toBe('denied');
  });

  it('handles very long hostnames', () => {
    const filter = new DomainFilter(makeConfig({ defaultAction: 'denied' }));
    const longHostname = 'a'.repeat(253) + '.com';
    expect(filter.check(longHostname).decision).toBe('denied');
  });

  it('handles empty allowlist and denylist', () => {
    const filter = new DomainFilter(
      makeConfig({ defaultAction: 'prompt', allowlist: [], denylist: [] }),
    );
    expect(filter.check('anything.com').decision).toBe('prompt');
  });

  it('handles multiple matching rules (first match wins)', () => {
    const filter = new DomainFilter(
      makeConfig({
        allowlist: ['api.github.com', '.github.com'],
      }),
    );
    const result = filter.check('api.github.com');
    expect(result.decision).toBe('allowed');
    // First matching rule should be the exact one
    expect(result.matchedRule?.pattern).toBe('api.github.com');
  });
});

// ── Real-World Scenarios ────────────────────────────────────────────────

describe('DomainFilter — real-world scenarios', () => {
  it('typical development setup: allow package registries, deny everything else', () => {
    const filter = new DomainFilter(
      makeConfig({
        defaultAction: 'denied',
        allowlist: [
          '.github.com',
          'registry.npmjs.org',
          '.npmjs.com',
          '.pypi.org',
        ],
      }),
    );

    // Package registries — allowed
    expect(filter.check('registry.npmjs.org').decision).toBe('allowed');
    expect(filter.check('api.github.com').decision).toBe('allowed');
    expect(filter.check('pypi.org').decision).toBe('allowed');

    // Gemini API — builtin allowed
    expect(filter.check('generativelanguage.googleapis.com').decision).toBe(
      'allowed',
    );

    // Unknown services — denied
    expect(filter.check('evil.com').decision).toBe('denied');
    expect(filter.check('random-api.io').decision).toBe('denied');
  });

  it('enterprise lockdown: only internal and known services', () => {
    const filter = new DomainFilter(
      makeConfig({
        defaultAction: 'denied',
        allowlist: ['.company.com', '.npmjs.org'],
        denylist: ['staging.company.com'],
      }),
    );

    expect(filter.check('api.company.com').decision).toBe('allowed');
    expect(filter.check('registry.npmjs.org').decision).toBe('allowed');
    // Staging explicitly denied despite .company.com allowlist
    expect(filter.check('staging.company.com').decision).toBe('denied');
    expect(filter.check('google.com').decision).toBe('allowed'); // builtin
  });

  it('interactive mode: prompt for unknown, learn from user', () => {
    const filter = new DomainFilter(
      makeConfig({
        defaultAction: 'prompt',
        allowlist: ['.github.com'],
      }),
    );

    // Known — allowed
    expect(filter.check('api.github.com').decision).toBe('allowed');

    // Unknown — prompt
    expect(filter.check('api.stripe.com').decision).toBe('prompt');

    // User allows Stripe for this session
    filter.addSessionAllow('api.stripe.com');
    expect(filter.check('api.stripe.com').decision).toBe('allowed');

    // Another unknown — still prompts
    expect(filter.check('webhook.discord.com').decision).toBe('prompt');

    // User denies Discord
    filter.addSessionDeny('webhook.discord.com');
    expect(filter.check('webhook.discord.com').decision).toBe('denied');
  });

  it('open mode with logging: allow everything, just track', () => {
    const filter = new DomainFilter(makeConfig({ defaultAction: 'allowed' }));

    filter.check('api.github.com');
    filter.check('evil.com');
    filter.check('localhost');

    const stats = filter.getStats();
    expect(stats.totalChecks).toBe(3);
    expect(stats.allowed).toBe(3); // All allowed (1 builtin + 2 default)
    expect(stats.builtinHits).toBe(1);
  });
});
