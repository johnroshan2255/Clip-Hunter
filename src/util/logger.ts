import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Patterns that must never reach a log file. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_\-]+/g,
  /(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN)\s*[=:]\s*\S+/gi,
  /("?(?:access_?token|refresh_?token|oauth_?token|authorization|api_?key|password|secret)"?\s*[:=]\s*)"?[^",\s}]+"?/gi,
  /Bearer\s+[A-Za-z0-9._\-]+/g,
];

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, prefix?: string) => (typeof prefix === 'string' && m.startsWith(prefix) ? `${prefix}[REDACTED]` : '[REDACTED]'));
  }
  return out;
}

export interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

export interface Sink {
  level: LogLevel;
  write: (rec: LogRecord, line: string) => void;
}

/**
 * Minimal structured JSON-lines logger with child contexts, multiple sinks
 * (console + per-project files) and secret redaction.
 */
export class Logger {
  private readonly sinks: Sink[];
  private readonly ctx: Record<string, unknown>;
  private readonly minLevel: number;

  /** Each sink filters by its own level (e.g. quiet console, detailed project log files). */
  constructor(opts: { level?: LogLevel; sinks?: Sink[]; ctx?: Record<string, unknown> } = {}) {
    this.sinks = (opts.sinks ?? []).map((s) => (opts.level && LEVELS[opts.level] > LEVELS[s.level] ? { ...s, level: opts.level } : s));
    this.minLevel = this.sinks.length ? Math.min(...this.sinks.map((s) => LEVELS[s.level])) : Infinity;
    this.ctx = opts.ctx ?? {};
  }

  child(ctx: Record<string, unknown>, extraSinks: Sink[] = []): Logger {
    return new Logger({ sinks: [...this.sinks, ...extraSinks], ctx: { ...this.ctx, ...ctx } });
  }

  log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    if (LEVELS[level] < this.minLevel) return;
    const rec: LogRecord = { ts: new Date().toISOString(), level, msg, ...this.ctx, ...fields };
    let line: string;
    try {
      line = redact(JSON.stringify(rec, errorReplacer));
    } catch {
      line = redact(JSON.stringify({ ts: rec.ts, level, msg }));
    }
    for (const s of this.sinks) {
      if (LEVELS[level] < LEVELS[s.level]) continue;
      try {
        s.write(rec, line);
      } catch {
        /* a broken sink must not crash the app */
      }
    }
  }

  debug(msg: string, f?: Record<string, unknown>): void { this.log('debug', msg, f); }
  info(msg: string, f?: Record<string, unknown>): void { this.log('info', msg, f); }
  warn(msg: string, f?: Record<string, unknown>): void { this.log('warn', msg, f); }
  error(msg: string, f?: Record<string, unknown>): void { this.log('error', msg, f); }
}

function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    const o: Record<string, unknown> = { name: value.name, message: value.message };
    const anyErr = value as Error & { code?: unknown; details?: unknown };
    if (anyErr.code !== undefined) o.code = anyErr.code;
    if (anyErr.details !== undefined) o.details = anyErr.details;
    return o;
  }
  return value;
}

export function consoleSink(level: LogLevel = 'info', pretty = process.stdout.isTTY): Sink {
  return { level, write: (rec, line) => {
    const stream = rec.level === 'error' || rec.level === 'warn' ? process.stderr : process.stdout;
    if (!pretty) {
      stream.write(line + '\n');
      return;
    }
    const { ts, level, msg, ...rest } = rec;
    const extras = Object.keys(rest).length ? ' ' + redact(JSON.stringify(rest, errorReplacer)) : '';
    stream.write(`${ts.slice(11, 19)} ${level.toUpperCase().padEnd(5)} ${msg}${extras}\n`);
  } };
}

const fileStreams = new Map<string, fs.WriteStream>();

export function fileSink(file: string, level: LogLevel = 'info'): Sink {
  return { level, write: (_rec, line) => {
    let s = fileStreams.get(file);
    if (!s) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      s = fs.createWriteStream(file, { flags: 'a' });
      fileStreams.set(file, s);
    }
    s.write(line + '\n');
  } };
}

export async function closeLogFiles(): Promise<void> {
  await Promise.all(
    [...fileStreams.values()].map((s) => new Promise<void>((resolve) => s.end(() => resolve()))),
  );
  fileStreams.clear();
}

export function createRootLogger(level: LogLevel = 'info', extra: Sink[] = []): Logger {
  return new Logger({ sinks: [consoleSink(level), ...extra] });
}

/** A logger that discards everything (tests). */
export const nullLogger = new Logger({ level: 'error', sinks: [] });
