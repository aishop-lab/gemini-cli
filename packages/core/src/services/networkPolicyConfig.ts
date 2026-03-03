/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Configuration schema for the network proxy policy.
 *
 * Handles validation, default values, and merging of global and per-project
 * network policy settings. Integrates with the existing settings system in
 * `settingsSchema.ts` — project-level allowlists/denylists extend (not
 * replace) global settings using a UNION merge strategy.
 *
 * Configuration lives in `settings.json` under the `networkPolicy` key.
 */

import type { DomainFilterConfig, FilterDecision } from './domainFilter.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface NetworkPolicyConfig {
  /** Action for domains not in any list: 'allowed', 'denied', or 'prompt'. */
  defaultAction: FilterDecision;
  /** Domain patterns to allow (exact, suffix with leading dot, glob with *). */
  allowlist: string[];
  /** Domain patterns to deny (same syntax as allowlist). */
  denylist: string[];
  /** Whether to log network traffic to a JSONL file. */
  logging: boolean;
  /** Path for the traffic log file. Default: ".gemini/network-log.jsonl". */
  logPath: string;
  /** HTTP/HTTPS proxy port. Default: 8877 (matches Seatbelt profiles). */
  proxyPort: number;
  /** SOCKS5 proxy port. Default: 8878. */
  socks5Port: number;
  /** Seconds before auto-denying an unanswered permission prompt. */
  promptTimeout: number;
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  config: NetworkPolicyConfig;
}

// ── Constants ───────────────────────────────────────────────────────────

const VALID_DEFAULT_ACTIONS: ReadonlySet<string> = new Set([
  'allowed',
  'denied',
  'prompt',
]);

const MIN_PORT = 1;
const MAX_PORT = 65535;
const MIN_TIMEOUT = 1;
const MAX_TIMEOUT = 300;

export const DEFAULT_CONFIG: Readonly<NetworkPolicyConfig> = {
  defaultAction: 'prompt',
  allowlist: [],
  denylist: [],
  logging: false,
  logPath: '.gemini/network-log.jsonl',
  proxyPort: 8877,
  socks5Port: 8878,
  promptTimeout: 30,
};

/**
 * Default allowlist entries commonly used in development.
 * These are NOT built-in (can be overridden by denylist) — they're just
 * convenient defaults when no allowlist is configured.
 */
export const DEFAULT_ALLOWLIST: readonly string[] = [
  '.npmjs.org',
  '.npmjs.com',
  '.github.com',
  '.pypi.org',
  '.rubygems.org',
  '.crates.io',
  '.docker.io',
  '.docker.com',
];

// ── Validation ──────────────────────────────────────────────────────────

/**
 * Validate a raw config object (e.g., parsed from JSON settings).
 * Returns a normalized config with defaults applied for missing fields,
 * along with any validation errors.
 */
export function validateConfig(raw: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];
  const config: NetworkPolicyConfig = { ...DEFAULT_CONFIG };

  // defaultAction
  if ('defaultAction' in raw) {
    if (
      typeof raw.defaultAction !== 'string' ||
      !VALID_DEFAULT_ACTIONS.has(raw.defaultAction)
    ) {
      errors.push({
        field: 'defaultAction',
        message: `Must be one of: ${[...VALID_DEFAULT_ACTIONS].join(', ')}. Got: ${String(raw.defaultAction)}`,
      });
    } else if (isFilterDecision(raw.defaultAction)) {
      config.defaultAction = raw.defaultAction;
    }
  }

  // allowlist
  if ('allowlist' in raw) {
    if (!Array.isArray(raw.allowlist)) {
      errors.push({
        field: 'allowlist',
        message: 'Must be an array of strings',
      });
    } else {
      const invalidEntries = raw.allowlist.filter(
        (entry) => typeof entry !== 'string' || entry.trim().length === 0,
      );
      if (invalidEntries.length > 0) {
        errors.push({
          field: 'allowlist',
          message: `Contains ${invalidEntries.length} invalid entries (must be non-empty strings)`,
        });
      }
      config.allowlist = raw.allowlist.filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.trim().length > 0,
      );
    }
  }

  // denylist
  if ('denylist' in raw) {
    if (!Array.isArray(raw.denylist)) {
      errors.push({
        field: 'denylist',
        message: 'Must be an array of strings',
      });
    } else {
      const invalidEntries = raw.denylist.filter(
        (entry) => typeof entry !== 'string' || entry.trim().length === 0,
      );
      if (invalidEntries.length > 0) {
        errors.push({
          field: 'denylist',
          message: `Contains ${invalidEntries.length} invalid entries (must be non-empty strings)`,
        });
      }
      config.denylist = raw.denylist.filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.trim().length > 0,
      );
    }
  }

  // logging
  if ('logging' in raw) {
    if (typeof raw.logging !== 'boolean') {
      errors.push({
        field: 'logging',
        message: `Must be a boolean. Got: ${typeof raw.logging}`,
      });
    } else {
      config.logging = raw.logging;
    }
  }

  // logPath
  if ('logPath' in raw) {
    if (typeof raw.logPath !== 'string' || raw.logPath.trim().length === 0) {
      errors.push({
        field: 'logPath',
        message: 'Must be a non-empty string',
      });
    } else {
      config.logPath = raw.logPath;
    }
  }

  // proxyPort
  if ('proxyPort' in raw) {
    if (
      typeof raw.proxyPort !== 'number' ||
      !Number.isInteger(raw.proxyPort) ||
      raw.proxyPort < MIN_PORT ||
      raw.proxyPort > MAX_PORT
    ) {
      errors.push({
        field: 'proxyPort',
        message: `Must be an integer between ${MIN_PORT} and ${MAX_PORT}. Got: ${String(raw.proxyPort)}`,
      });
    } else {
      config.proxyPort = raw.proxyPort;
    }
  }

  // socks5Port
  if ('socks5Port' in raw) {
    if (
      typeof raw.socks5Port !== 'number' ||
      !Number.isInteger(raw.socks5Port) ||
      raw.socks5Port < MIN_PORT ||
      raw.socks5Port > MAX_PORT
    ) {
      errors.push({
        field: 'socks5Port',
        message: `Must be an integer between ${MIN_PORT} and ${MAX_PORT}. Got: ${String(raw.socks5Port)}`,
      });
    } else {
      config.socks5Port = raw.socks5Port;
    }
  }

  // promptTimeout
  if ('promptTimeout' in raw) {
    if (
      typeof raw.promptTimeout !== 'number' ||
      !Number.isInteger(raw.promptTimeout) ||
      raw.promptTimeout < MIN_TIMEOUT ||
      raw.promptTimeout > MAX_TIMEOUT
    ) {
      errors.push({
        field: 'promptTimeout',
        message: `Must be an integer between ${MIN_TIMEOUT}s and ${MAX_TIMEOUT}s. Got: ${String(raw.promptTimeout)}`,
      });
    } else {
      config.promptTimeout = raw.promptTimeout;
    }
  }

  // Cross-field: proxyPort and socks5Port must be different.
  // Only check when BOTH are explicitly provided — avoid false positives
  // when a user sets only proxyPort and it happens to collide with the default socks5Port.
  if (
    'proxyPort' in raw &&
    'socks5Port' in raw &&
    config.proxyPort === config.socks5Port
  ) {
    errors.push({
      field: 'socks5Port',
      message: `Must be different from proxyPort (${config.proxyPort})`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    config,
  };
}

// ── Merge ───────────────────────────────────────────────────────────────

/**
 * Merge global and project-level network policy configs.
 *
 * Uses UNION strategy for allowlist/denylist (project extends global).
 * Scalar values: project overrides global.
 * This matches the merge behavior in `settingsSchema.ts` for array fields.
 */
export function mergeConfigs(
  global: NetworkPolicyConfig,
  project: Partial<NetworkPolicyConfig>,
): NetworkPolicyConfig {
  return {
    defaultAction: project.defaultAction ?? global.defaultAction,
    allowlist: deduplicateArray([
      ...global.allowlist,
      ...(project.allowlist ?? []),
    ]),
    denylist: deduplicateArray([
      ...global.denylist,
      ...(project.denylist ?? []),
    ]),
    logging: project.logging ?? global.logging,
    logPath: project.logPath ?? global.logPath,
    proxyPort: project.proxyPort ?? global.proxyPort,
    socks5Port: project.socks5Port ?? global.socks5Port,
    promptTimeout: project.promptTimeout ?? global.promptTimeout,
  };
}

/**
 * Convert a NetworkPolicyConfig into a DomainFilterConfig for the filter engine.
 */
export function toDomainFilterConfig(
  config: NetworkPolicyConfig,
): DomainFilterConfig {
  return {
    defaultAction: config.defaultAction,
    allowlist: config.allowlist,
    denylist: config.denylist,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function deduplicateArray(arr: string[]): string[] {
  return [...new Set(arr)];
}

function isFilterDecision(value: unknown): value is FilterDecision {
  return value === 'allowed' || value === 'denied' || value === 'prompt';
}
