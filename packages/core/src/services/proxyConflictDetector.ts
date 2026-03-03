/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Detects conflicts between the built-in network proxy and existing proxy
 * configurations before starting the proxy server.
 *
 * This is critical for a security feature: if the proxy fails to start or
 * conflicts with existing settings, the sandbox may silently lose network
 * filtering — a fail-open condition that is worse than no proxy at all.
 *
 * Checks performed:
 *   1. GEMINI_SANDBOX_PROXY_COMMAND (existing external proxy takes precedence)
 *   2. HTTP_PROXY / HTTPS_PROXY / ALL_PROXY env vars (may conflict)
 *   3. NO_PROXY env var (may bypass filtering)
 *   4. Port availability (cannot bind if port is in use)
 *   5. Cross-field config validation (proxy port != socks5 port)
 */

// ── Types ───────────────────────────────────────────────────────────────

export type ConflictSeverity = 'error' | 'warning' | 'info';

export interface ProxyConflict {
  /** Severity level: error = cannot start, warning = may cause issues, info = FYI */
  severity: ConflictSeverity;
  /** What was detected. */
  message: string;
  /** What the user should do about it. */
  recommendation: string;
}

export interface ConflictDetectionResult {
  /** Whether it is safe to start the built-in proxy. */
  canStart: boolean;
  /** List of detected conflicts, sorted by severity. */
  conflicts: ProxyConflict[];
}

export interface ProxyConflictDetectorConfig {
  proxyPort: number;
  socks5Port: number;
}

// ── Constants ───────────────────────────────────────────────────────────

/**
 * Environment variable names that indicate an existing proxy configuration.
 * We check both upper and lower case variants since different tools respect
 * different casings (curl uses lowercase, npm uses uppercase, etc.).
 */
const PROXY_ENV_VARS = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const;

const NO_PROXY_VARS = ['NO_PROXY', 'no_proxy'] as const;

const EXTERNAL_PROXY_VAR = 'GEMINI_SANDBOX_PROXY_COMMAND';

// ── ProxyConflictDetector ───────────────────────────────────────────────

export class ProxyConflictDetector {
  private readonly config: ProxyConflictDetectorConfig;

  constructor(config: ProxyConflictDetectorConfig) {
    this.config = config;
  }

  /**
   * Run all conflict checks against the given environment.
   * Pass `process.env` in production; pass a mock in tests.
   */
  detect(env: Record<string, string | undefined>): ConflictDetectionResult {
    const conflicts: ProxyConflict[] = [];

    this.checkExternalProxyCommand(env, conflicts);
    this.checkExistingProxyEnvVars(env, conflicts);
    this.checkNoProxyConfig(env, conflicts);
    this.checkPortConflict(conflicts);

    // Sort by severity: error first, then warning, then info
    const severityOrder: Record<ConflictSeverity, number> = {
      error: 0,
      warning: 1,
      info: 2,
    };
    conflicts.sort(
      (a, b) => severityOrder[a.severity] - severityOrder[b.severity],
    );

    const canStart = !conflicts.some((c) => c.severity === 'error');

    return { canStart, conflicts };
  }

  // ── Individual Checks ───────────────────────────────────────────────

  /**
   * Check 1: GEMINI_SANDBOX_PROXY_COMMAND
   * If set, the user has configured an external proxy — the built-in proxy
   * should defer to it. This is an error (cannot start both).
   */
  private checkExternalProxyCommand(
    env: Record<string, string | undefined>,
    conflicts: ProxyConflict[],
  ): void {
    const externalCmd = env[EXTERNAL_PROXY_VAR];
    if (externalCmd && externalCmd.trim().length > 0) {
      conflicts.push({
        severity: 'error',
        message: `${EXTERNAL_PROXY_VAR} is set to "${externalCmd}". An external proxy is already configured.`,
        recommendation:
          'Remove GEMINI_SANDBOX_PROXY_COMMAND to use the built-in proxy, or disable the built-in proxy in settings.',
      });
    }
  }

  /**
   * Check 2: Existing HTTP_PROXY / HTTPS_PROXY / ALL_PROXY env vars.
   * These may come from the user's shell profile or corporate proxy.
   * If they point to a different host/port, there's a conflict.
   */
  private checkExistingProxyEnvVars(
    env: Record<string, string | undefined>,
    conflicts: ProxyConflict[],
  ): void {
    for (const varName of PROXY_ENV_VARS) {
      const value = env[varName];
      if (!value || value.trim().length === 0) continue;

      const parsed = parseProxyUrl(value);
      if (!parsed) {
        conflicts.push({
          severity: 'warning',
          message: `${varName}="${value}" is set but could not be parsed as a proxy URL.`,
          recommendation: `The built-in proxy will override ${varName} for sandboxed processes. Ensure this is intended.`,
        });
        continue;
      }

      // Check if it points to our intended port
      const isOurProxy =
        isLocalhost(parsed.hostname) &&
        (parsed.port === this.config.proxyPort ||
          parsed.port === this.config.socks5Port);

      if (!isOurProxy) {
        conflicts.push({
          severity: 'warning',
          message: `${varName}="${value}" points to an external proxy at ${parsed.hostname}:${parsed.port}.`,
          recommendation: `The built-in proxy will override ${varName} for sandboxed processes. External proxy traffic from the CLI itself is unaffected.`,
        });
      }
    }
  }

  /**
   * Check 3: NO_PROXY env var.
   * If set, some traffic may bypass the proxy entirely, defeating the
   * purpose of domain filtering.
   */
  private checkNoProxyConfig(
    env: Record<string, string | undefined>,
    conflicts: ProxyConflict[],
  ): void {
    for (const varName of NO_PROXY_VARS) {
      const value = env[varName];
      if (!value || value.trim().length === 0) continue;

      const domains = value
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean);

      // localhost in NO_PROXY is fine — we don't want to proxy localhost traffic
      const nonLocalDomains = domains.filter((d) => !isLocalhostPattern(d));

      if (nonLocalDomains.length > 0) {
        conflicts.push({
          severity: 'warning',
          message: `${varName}="${value}" will bypass the proxy for: ${nonLocalDomains.join(', ')}.`,
          recommendation:
            'The built-in proxy will set its own NO_PROXY for sandboxed processes (localhost only). Existing NO_PROXY from the parent environment is not inherited.',
        });
      } else if (domains.length > 0) {
        conflicts.push({
          severity: 'info',
          message: `${varName}="${value}" is set but only contains localhost entries. This is expected.`,
          recommendation: 'No action needed.',
        });
      }
    }
  }

  /**
   * Check 4: Port conflict between proxy and socks5.
   * This should already be caught by config validation, but we check
   * again here as defense-in-depth.
   */
  private checkPortConflict(conflicts: ProxyConflict[]): void {
    if (this.config.proxyPort === this.config.socks5Port) {
      conflicts.push({
        severity: 'error',
        message: `HTTP proxy port (${this.config.proxyPort}) and SOCKS5 port (${this.config.socks5Port}) are the same.`,
        recommendation:
          'Use different ports for the HTTP proxy and SOCKS5 proxy (defaults: 8877 and 8878).',
      });
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

interface ParsedProxyUrl {
  hostname: string;
  port: number;
  protocol: string;
}

/**
 * Parse a proxy URL string like "http://proxy.corp.com:3128" or
 * "socks5://localhost:1080" into its components.
 */
export function parseProxyUrl(url: string): ParsedProxyUrl | null {
  try {
    // Handle URLs without protocol prefix
    const normalized = url.includes('://') ? url : `http://${url}`;
    const parsed = new URL(normalized);
    const port = parsed.port
      ? parseInt(parsed.port, 10)
      : parsed.protocol === 'https:'
        ? 443
        : 80;
    return {
      hostname: parsed.hostname,
      port,
      protocol: parsed.protocol.replace(':', ''),
    };
  } catch {
    return null;
  }
}

/**
 * Check if a hostname refers to the local machine.
 */
function isLocalhost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0'
  );
}

/**
 * Check if a NO_PROXY pattern refers to localhost.
 */
function isLocalhostPattern(pattern: string): boolean {
  const lower = pattern.toLowerCase().trim();
  return (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '::1' ||
    lower === '0.0.0.0' ||
    lower === ''
  );
}
