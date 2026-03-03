/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  TrafficLogger,
  formatTrafficSummary,
  DEFAULT_LOGGER_CONFIG,
  type TrafficLogEntry,
  type TrafficSummary,
} from './trafficLogger.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeEntry(overrides?: Partial<TrafficLogEntry>): TrafficLogEntry {
  return {
    timestamp: Date.now(),
    domain: 'example.com',
    port: 443,
    protocol: 'https',
    action: 'allowed',
    ...overrides,
  };
}

// ── Default Config ──────────────────────────────────────────────────────

describe('DEFAULT_LOGGER_CONFIG', () => {
  it('has 10MB max file size', () => {
    expect(DEFAULT_LOGGER_CONFIG.maxSizeBytes).toBe(10 * 1024 * 1024);
  });

  it('keeps 3 rotations', () => {
    expect(DEFAULT_LOGGER_CONFIG.maxRotations).toBe(3);
  });

  it('buffers 1000 session entries', () => {
    expect(DEFAULT_LOGGER_CONFIG.maxSessionEntries).toBe(1000);
  });
});

// ── Logging ─────────────────────────────────────────────────────────────

describe('TrafficLogger — logging', () => {
  let logger: TrafficLogger;

  beforeEach(() => {
    logger = new TrafficLogger();
  });

  it('returns a valid JSON string from log()', () => {
    const entry = makeEntry({ domain: 'api.github.com' });
    const line = logger.log(entry);
    const parsed = JSON.parse(line);
    expect(parsed.domain).toBe('api.github.com');
    expect(parsed.port).toBe(443);
    expect(parsed.protocol).toBe('https');
    expect(parsed.action).toBe('allowed');
  });

  it('adds entry to session buffer', () => {
    logger.log(makeEntry());
    expect(logger.getSessionEntries()).toHaveLength(1);
  });

  it('adds serialized line to write buffer', () => {
    logger.log(makeEntry());
    expect(logger.getWriteBuffer()).toHaveLength(1);
  });

  it('preserves all fields including optional ones', () => {
    const entry = makeEntry({
      triggeredBy: 'npm install',
      bytesSent: 1024,
      bytesReceived: 4096,
      durationMs: 142,
    });
    const line = logger.log(entry);
    const parsed = JSON.parse(line);
    expect(parsed.triggeredBy).toBe('npm install');
    expect(parsed.bytesSent).toBe(1024);
    expect(parsed.bytesReceived).toBe(4096);
    expect(parsed.durationMs).toBe(142);
  });

  it('omits undefined optional fields', () => {
    const entry = makeEntry(); // No triggeredBy, bytesSent, etc.
    const line = logger.log(entry);
    const parsed = JSON.parse(line);
    expect(parsed).not.toHaveProperty('triggeredBy');
    expect(parsed).not.toHaveProperty('bytesSent');
  });
});

// ── Session Buffer Bounds ───────────────────────────────────────────────

describe('TrafficLogger — session buffer bounds', () => {
  it('evicts oldest entries when buffer is full', () => {
    const logger = new TrafficLogger({ maxSessionEntries: 3 });

    logger.log(makeEntry({ domain: 'first.com' }));
    logger.log(makeEntry({ domain: 'second.com' }));
    logger.log(makeEntry({ domain: 'third.com' }));
    logger.log(makeEntry({ domain: 'fourth.com' }));

    const entries = logger.getSessionEntries();
    expect(entries).toHaveLength(3);
    expect(entries[0].domain).toBe('second.com');
    expect(entries[2].domain).toBe('fourth.com');
  });

  it('handles maxSessionEntries of 1', () => {
    const logger = new TrafficLogger({ maxSessionEntries: 1 });
    logger.log(makeEntry({ domain: 'a.com' }));
    logger.log(makeEntry({ domain: 'b.com' }));
    expect(logger.getSessionEntries()).toHaveLength(1);
    expect(logger.getSessionEntries()[0].domain).toBe('b.com');
  });
});

// ── File Rotation ───────────────────────────────────────────────────────

describe('TrafficLogger — file rotation', () => {
  it('rotates when file exceeds maxSizeBytes', () => {
    // Use a tiny max size to trigger rotation quickly
    const logger = new TrafficLogger({ maxSizeBytes: 100 });
    // Each entry is ~80-100 bytes of JSON
    logger.log(makeEntry({ domain: 'a.com' }));
    logger.log(makeEntry({ domain: 'b.com' })); // Should trigger rotation

    expect(logger.getRotationCount()).toBeGreaterThanOrEqual(1);
  });

  it('caps rotations at maxRotations and continues writing after cap', () => {
    const logger = new TrafficLogger({
      maxSizeBytes: 50,
      maxRotations: 2,
    });
    // Log many entries to trigger multiple rotations
    for (let i = 0; i < 20; i++) {
      logger.log(makeEntry({ domain: `domain${i}.com` }));
    }
    expect(logger.getRotationCount()).toBe(2);
    // Write buffer must accumulate entries after the cap — not be wiped
    // on every subsequent entry. This verifies the rotation stops resetting
    // the buffer once the cap is reached.
    expect(logger.getWriteBuffer().length).toBeGreaterThan(1);
  });

  it('clears write buffer on rotation', () => {
    const logger = new TrafficLogger({ maxSizeBytes: 100 });
    logger.log(makeEntry({ domain: 'before-rotation.com' }));
    const bufferBefore = logger.getWriteBuffer().length;
    // Force rotation with more entries
    logger.log(makeEntry({ domain: 'trigger-rotation.com' }));
    if (logger.getRotationCount() > 0) {
      // After rotation, write buffer should start fresh
      expect(logger.getWriteBuffer().length).toBeLessThanOrEqual(bufferBefore);
    }
  });
});

// ── Summary Generation ──────────────────────────────────────────────────

describe('TrafficLogger — getSummary', () => {
  let logger: TrafficLogger;

  beforeEach(() => {
    logger = new TrafficLogger();
  });

  it('returns zeros for empty session', () => {
    const summary = logger.getSummary();
    expect(summary.totalEntries).toBe(0);
    expect(summary.allowed).toBe(0);
    expect(summary.denied).toBe(0);
    expect(summary.prompted).toBe(0);
    expect(summary.topDomains).toHaveLength(0);
  });

  it('counts allowed entries', () => {
    logger.log(makeEntry({ action: 'allowed' }));
    logger.log(makeEntry({ action: 'prompted-allowed' }));
    const summary = logger.getSummary();
    expect(summary.allowed).toBe(2);
  });

  it('counts denied entries (all denial types)', () => {
    logger.log(makeEntry({ action: 'denied' }));
    logger.log(makeEntry({ action: 'prompted-denied' }));
    logger.log(makeEntry({ action: 'timeout-denied' }));
    const summary = logger.getSummary();
    expect(summary.denied).toBe(3);
  });

  it('counts prompted entries separately', () => {
    logger.log(makeEntry({ action: 'prompted-allowed' }));
    logger.log(makeEntry({ action: 'prompted-denied' }));
    const summary = logger.getSummary();
    expect(summary.prompted).toBe(2);
    // prompted-allowed also counts as allowed
    expect(summary.allowed).toBe(1);
    // prompted-denied also counts as denied
    expect(summary.denied).toBe(1);
  });

  it('aggregates top domains by request count', () => {
    logger.log(makeEntry({ domain: 'api.github.com' }));
    logger.log(makeEntry({ domain: 'api.github.com' }));
    logger.log(makeEntry({ domain: 'api.github.com' }));
    logger.log(makeEntry({ domain: 'registry.npmjs.org' }));
    logger.log(makeEntry({ domain: 'registry.npmjs.org' }));
    logger.log(makeEntry({ domain: 'evil.com', action: 'denied' }));

    const summary = logger.getSummary();
    expect(summary.topDomains).toHaveLength(3);
    expect(summary.topDomains[0].domain).toBe('api.github.com');
    expect(summary.topDomains[0].requestCount).toBe(3);
    expect(summary.topDomains[1].domain).toBe('registry.npmjs.org');
    expect(summary.topDomains[1].requestCount).toBe(2);
  });

  it('limits top domains to configured count', () => {
    const smallLogger = new TrafficLogger({ topDomainsCount: 2 });
    for (let i = 0; i < 5; i++) {
      smallLogger.log(makeEntry({ domain: `domain${i}.com` }));
    }
    const summary = smallLogger.getSummary();
    expect(summary.topDomains).toHaveLength(2);
  });

  it('computes average duration for domains with timing', () => {
    logger.log(makeEntry({ domain: 'api.com', durationMs: 100 }));
    logger.log(makeEntry({ domain: 'api.com', durationMs: 200 }));
    logger.log(makeEntry({ domain: 'api.com', durationMs: 300 }));
    const summary = logger.getSummary();
    expect(summary.topDomains[0].avgDurationMs).toBe(200);
  });

  it('returns null avgDurationMs when no timing data', () => {
    logger.log(makeEntry({ domain: 'no-timing.com' }));
    const summary = logger.getSummary();
    expect(summary.topDomains[0].avgDurationMs).toBeNull();
  });

  it('tracks last action for each domain', () => {
    logger.log(makeEntry({ domain: 'flip.com', action: 'allowed' }));
    logger.log(makeEntry({ domain: 'flip.com', action: 'denied' }));
    const summary = logger.getSummary();
    expect(summary.topDomains[0].lastAction).toBe('denied');
  });

  it('includes session start time', () => {
    const before = Date.now();
    const freshLogger = new TrafficLogger();
    const after = Date.now();
    const summary = freshLogger.getSummary();
    expect(summary.sessionStartTime).toBeGreaterThanOrEqual(before);
    expect(summary.sessionStartTime).toBeLessThanOrEqual(after);
  });
});

// ── Clear Session ───────────────────────────────────────────────────────

describe('TrafficLogger — clearSession', () => {
  it('empties the session buffer', () => {
    const logger = new TrafficLogger();
    logger.log(makeEntry());
    logger.log(makeEntry());
    logger.clearSession();
    expect(logger.getSessionEntries()).toHaveLength(0);
  });

  it('summary returns zeros after clear', () => {
    const logger = new TrafficLogger();
    logger.log(makeEntry({ action: 'allowed' }));
    logger.clearSession();
    const summary = logger.getSummary();
    expect(summary.totalEntries).toBe(0);
    expect(summary.allowed).toBe(0);
  });
});

// ── Format Summary ──────────────────────────────────────────────────────

describe('formatTrafficSummary', () => {
  it('formats empty summary', () => {
    const summary: TrafficSummary = {
      totalEntries: 0,
      allowed: 0,
      denied: 0,
      prompted: 0,
      topDomains: [],
      sessionStartTime: Date.now(),
    };
    const output = formatTrafficSummary(summary);
    expect(output).toContain('Network Traffic Log');
    expect(output).toContain('Allowed:  0 requests');
    expect(output).toContain('Denied:   0 requests');
  });

  it('includes counts', () => {
    const summary: TrafficSummary = {
      totalEntries: 26,
      allowed: 23,
      denied: 2,
      prompted: 1,
      topDomains: [],
      sessionStartTime: Date.now(),
    };
    const output = formatTrafficSummary(summary);
    expect(output).toContain('Allowed:  23 requests');
    expect(output).toContain('Denied:   2 requests');
    expect(output).toContain('Prompted: 1 request');
  });

  it('includes top domains with timing', () => {
    const summary: TrafficSummary = {
      totalEntries: 5,
      allowed: 5,
      denied: 0,
      prompted: 0,
      topDomains: [
        {
          domain: 'api.github.com',
          requestCount: 3,
          lastAction: 'allowed',
          avgDurationMs: 142,
        },
        {
          domain: 'registry.npmjs.org',
          requestCount: 2,
          lastAction: 'allowed',
          avgDurationMs: 230,
        },
      ],
      sessionStartTime: Date.now(),
    };
    const output = formatTrafficSummary(summary);
    expect(output).toContain('Top domains:');
    expect(output).toContain('api.github.com');
    expect(output).toContain('3 requests');
    expect(output).toContain('avg 142ms');
    expect(output).toContain('registry.npmjs.org');
  });

  it('shows DENIED for denied domains without timing', () => {
    const summary: TrafficSummary = {
      totalEntries: 1,
      allowed: 0,
      denied: 1,
      prompted: 0,
      topDomains: [
        {
          domain: 'evil.com',
          requestCount: 1,
          lastAction: 'denied',
          avgDurationMs: null,
        },
      ],
      sessionStartTime: Date.now(),
    };
    const output = formatTrafficSummary(summary);
    expect(output).toContain('evil.com');
    expect(output).toContain('1 request');
    expect(output).not.toContain('1 requests');
    expect(output).toContain('DENIED');
  });
});

// ── Real-World Scenario ─────────────────────────────────────────────────

describe('TrafficLogger — real-world scenario', () => {
  it('logs a typical npm install session', () => {
    const logger = new TrafficLogger();
    const now = Date.now();

    // npm resolves package metadata
    logger.log({
      timestamp: now,
      domain: 'registry.npmjs.org',
      port: 443,
      protocol: 'https',
      action: 'allowed',
      triggeredBy: 'npm install',
      durationMs: 230,
    });

    // npm downloads tarball
    logger.log({
      timestamp: now + 100,
      domain: 'registry.npmjs.org',
      port: 443,
      protocol: 'https',
      action: 'allowed',
      triggeredBy: 'npm install',
      bytesSent: 256,
      bytesReceived: 102400,
      durationMs: 450,
    });

    // Postinstall script tries to phone home — denied
    logger.log({
      timestamp: now + 500,
      domain: 'telemetry.sketchy-package.io',
      port: 443,
      protocol: 'https',
      action: 'denied',
      triggeredBy: 'npm install',
    });

    const summary = logger.getSummary();
    expect(summary.totalEntries).toBe(3);
    expect(summary.allowed).toBe(2);
    expect(summary.denied).toBe(1);
    expect(summary.topDomains[0].domain).toBe('registry.npmjs.org');
    expect(summary.topDomains[0].requestCount).toBe(2);
    expect(summary.topDomains[0].avgDurationMs).toBe(340); // (230+450)/2
  });
});
