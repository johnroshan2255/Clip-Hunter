import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSchema, type AppConfig, type ProjectSettings } from './schema.js';
import { ConfigError } from '../util/errors.js';

/** Repository root (works from both src/ via tsx and dist/ after build). */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CONFIG_FILE = 'cliphunter.config.json';
export const LOCAL_CONFIG_FILE = 'cliphunter.config.local.json';

function readJsonIfExists(file: string): unknown {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Invalid JSON in ${file}: ${(err as Error).message}`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : override) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export function parseConfig(raw: unknown): AppConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${msg}`);
  }
  return result.data;
}

/**
 * Load configuration: defaults ← cliphunter.config.json ← cliphunter.config.local.json
 * ← CLIPHUNTER_CONFIG (path) ← explicit overrides.
 */
export function loadConfig(opts: { root?: string; overrides?: unknown } = {}): AppConfig {
  const root = opts.root ?? APP_ROOT;
  let raw: unknown = {};
  raw = deepMerge(raw, readJsonIfExists(path.join(root, CONFIG_FILE)));
  raw = deepMerge(raw, readJsonIfExists(path.join(root, LOCAL_CONFIG_FILE)));
  const envPath = process.env.CLIPHUNTER_CONFIG;
  if (envPath) raw = deepMerge(raw, readJsonIfExists(path.resolve(envPath)));
  if (opts.overrides) raw = deepMerge(raw, opts.overrides);
  const cfg = parseConfig(raw);
  // Resolve storage paths relative to the app root.
  cfg.storage.projectsDir = path.resolve(root, cfg.storage.projectsDir);
  cfg.storage.exportsDir = path.resolve(root, cfg.storage.exportsDir);
  cfg.storage.dataDir = path.resolve(root, cfg.storage.dataDir);
  cfg.fx.sfxDir = path.resolve(root, cfg.fx.sfxDir);
  return cfg;
}

/** Apply per-project settings on top of the global configuration (re-validated). */
export function effectiveConfig(base: AppConfig, settings: ProjectSettings | undefined): AppConfig {
  if (!settings) return base;
  const merged = deepMerge(structuredClone(base), settings);
  // Keep the preferred window consistent with overridden min/max *before* validating.
  const c = merged.clips;
  c.preferredMinSeconds = Math.min(Math.max(c.preferredMinSeconds, c.minDurationSeconds), c.maxDurationSeconds);
  c.preferredMaxSeconds = Math.max(Math.min(c.preferredMaxSeconds, c.maxDurationSeconds), c.preferredMinSeconds);
  const cfg = parseConfig(merged);
  cfg.storage = base.storage;
  cfg.fx.sfxDir = base.fx.sfxDir;
  return cfg;
}
