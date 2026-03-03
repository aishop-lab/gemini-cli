/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Traffic audit logger for the network proxy.
 *
 * Records network access decisions (allowed, denied, prompted) in JSON Lines
 * format for security auditing. Opt-in only — controlled by
 * `networkPolicy.logging: true` in settings.
 *
 * Features:
 *   - JSON Lines format (one JSON object per line, easy to parse/stream)
 *   - File rotation when log exceeds maxSizeBytes (default 10MB)
 *   - Session-scoped in-memory buffer for `/network-log` command
 *   - Summary statistics for quick overview
 *
 * Log file location: `.gemini/network-log.jsonl` (configurable)
 */

// ── Types ───────────────────────────────────────────────────────────────

export type TrafficAction =
  | 'allowed'
  | 'denied'
  | 'prompted-allowed'
  | 'prompted-denied'
  | 'timeout-denied';

export type TrafficProtocol = 'http' | 'https' | 'socks5';

export interface TrafficLogEntry {
  /** Unix epoch milliseconds. */
  timestamp: number;
  /** Target hostname. */
  domain: string;
  /** Target port. */
  port: number;
  /** Protocol used. */
  protocol: TrafficProtocol;
  /** Filtering action taken. */
  action: TrafficAction;
  /** Command that triggered the request, if known. */
  triggeredBy?: string;
  /** Bytes sent through the tunnel (only for allowed connections). */
  bytesSent?: number;
  /** Bytes received through the tunnel. */
  bytesReceived?: number;
  /** Connection duration in milliseconds. */
  durationMs?: number;
}

export interface TrafficSummary {
  /** Total entries logged this session. */
  totalEntries: number;
  /** Count by action type. */
  allowed: number;
  denied: number;
  prompted: number;
  /** Top domains by request count (descending). */
  topDomains: DomainSummary[];
  /** Session start time. */
  sessionStartTime: number;
}

export interface DomainSummary {
  domain: string;
  requestCount: number;
  lastAction: TrafficAction;
  avgDurationMs: number | null;
}

export interface TrafficLoggerConfig {
  /** Maximum log file size in bytes before rotation. Default: 10MB. */
  maxSizeBytes: number;
  /** Number of rotated files to keep. Default: 3. */
  maxRotations: number;
  /** Maximum entries to keep in the session buffer. Default: 1000. */
  maxSessionEntries: number;
  /** Number of top domains to include in summary. Default: 10. */
  topDomainsCount: number;
}

// ── Constants ───────────────────────────────────────────────────────────

const TEN_MB = 10 * 1024 * 1024;

export const DEFAULT_LOGGER_CONFIG: Readonly<TrafficLoggerConfig> = {
  maxSizeBytes: TEN_MB,
  maxRotations: 3,
  maxSessionEntries: 1000,
  topDomainsCount: 10,
};

// ── TrafficLogger ───────────────────────────────────────────────────────

export class TrafficLogger {
  private readonly config: TrafficLoggerConfig;
  private readonly sessionBuffer: TrafficLogEntry[] = [];
  private readonly sessionStartTime: number;
  /** Track writes for rotation decisions. Simulates file size without fs. */
  private currentFileSize: number = 0;
  private rotationCount: number = 0;

  /** Collected serialized lines for testing (file I/O is mocked in real use). */
  private readonly writeBuffer: string[] = [];

  constructor(config?: Partial<TrafficLoggerConfig>) {
    this.config = { ...DEFAULT_LOGGER_CONFIG, ...config };
    this.sessionStartTime = Date.now();
  }

  /**
   * Log a traffic entry. Adds to session buffer and serializes for file output.
   */
  log(entry: TrafficLogEntry): string {
    // Add to session buffer (bounded)
    if (this.sessionBuffer.length >= this.config.maxSessionEntries) {
      this.sessionBuffer.shift(); // Remove oldest
    }
    this.sessionBuffer.push(entry);

    // Serialize to JSONL
    const line = JSON.stringify(entry);
    const lineSize = Buffer.byteLength(line, 'utf8') + 1; // +1 for newline

    // Check rotation
    if (this.currentFileSize + lineSize > this.config.maxSizeBytes) {
      this.rotate();
    }

    this.writeBuffer.push(line);
    this.currentFileSize += lineSize;

    return line;
  }

  /**
   * Get a summary of traffic for the current session.
   */
  getSummary(): TrafficSummary {
    const entries = this.sessionBuffer;

    let allowed = 0;
    let denied = 0;
    let prompted = 0;

    const domainMap = new Map<
      string,
      {
        count: number;
        lastAction: TrafficAction;
        durations: number[];
      }
    >();

    for (const entry of entries) {
      // Count by action
      if (entry.action === 'allowed' || entry.action === 'prompted-allowed') {
        allowed++;
      } else if (
        entry.action === 'denied' ||
        entry.action === 'prompted-denied' ||
        entry.action === 'timeout-denied'
      ) {
        denied++;
      }
      if (
        entry.action === 'prompted-allowed' ||
        entry.action === 'prompted-denied'
      ) {
        prompted++;
      }

      // Aggregate by domain
      const existing = domainMap.get(entry.domain);
      if (existing) {
        existing.count++;
        existing.lastAction = entry.action;
        if (entry.durationMs !== undefined) {
          existing.durations.push(entry.durationMs);
        }
      } else {
        domainMap.set(entry.domain, {
          count: 1,
          lastAction: entry.action,
          durations: entry.durationMs !== undefined ? [entry.durationMs] : [],
        });
      }
    }

    // Build top domains
    const topDomains: DomainSummary[] = [...domainMap.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, this.config.topDomainsCount)
      .map(([domain, data]) => ({
        domain,
        requestCount: data.count,
        lastAction: data.lastAction,
        avgDurationMs:
          data.durations.length > 0
            ? Math.round(
                data.durations.reduce((a, b) => a + b, 0) /
                  data.durations.length,
              )
            : null,
      }));

    return {
      totalEntries: entries.length,
      allowed,
      denied,
      prompted,
      topDomains,
      sessionStartTime: this.sessionStartTime,
    };
  }

  /**
   * Get all entries for the current session (for `/network-log view`).
   */
  getSessionEntries(): readonly TrafficLogEntry[] {
    return this.sessionBuffer;
  }

  /**
   * Get the serialized write buffer (for testing file output).
   */
  getWriteBuffer(): readonly string[] {
    return this.writeBuffer;
  }

  /**
   * Get the number of rotations performed.
   */
  getRotationCount(): number {
    return this.rotationCount;
  }

  /**
   * Clear the session buffer (for `/network-log clear`).
   */
  clearSession(): void {
    this.sessionBuffer.length = 0;
  }

  // ── Private ─────────────────────────────────────────────────────────

  private rotate(): void {
    if (this.rotationCount >= this.config.maxRotations) {
      // Cap reached — continue writing to the current (last) file.
      // Do not reset file size or clear buffer; further entries append normally.
      return;
    }
    this.rotationCount++;
    // In real implementation: rename current file to .1, shift .1 → .2, etc.
    this.currentFileSize = 0;
    this.writeBuffer.length = 0;
  }
}

// ── Formatting ──────────────────────────────────────────────────────────

/**
 * Format a TrafficSummary as a human-readable string for the `/network-log`
 * command output.
 */
export function formatTrafficSummary(summary: TrafficSummary): string {
  const lines: string[] = [];

  lines.push('Network Traffic Log (this session)');
  lines.push('');
  lines.push(
    `  Allowed:  ${summary.allowed} ${pluralize('request', summary.allowed)}`,
  );
  lines.push(
    `  Denied:   ${summary.denied} ${pluralize('request', summary.denied)}`,
  );
  lines.push(
    `  Prompted: ${summary.prompted} ${pluralize('request', summary.prompted)}`,
  );

  if (summary.topDomains.length > 0) {
    lines.push('');
    lines.push('  Top domains:');

    // Calculate column widths
    const maxDomainLen = Math.max(
      ...summary.topDomains.map((d) => d.domain.length),
    );

    for (const domain of summary.topDomains) {
      const padded = domain.domain.padEnd(maxDomainLen + 2);
      const count =
        `${domain.requestCount} ${pluralize('request', domain.requestCount)}`.padEnd(
          14,
        );
      const timing =
        domain.avgDurationMs !== null
          ? `avg ${domain.avgDurationMs}ms`
          : domain.lastAction.includes('denied')
            ? 'DENIED'
            : '';
      lines.push(`    ${padded}${count}${timing}`);
    }
  }

  return lines.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────────────────

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}
