import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { runProcess } from '../util/process.js';
import { Semaphore, sleep } from '../util/concurrency.js';
import { CancelledError, ClaudeError, ProcessError, isCancelled } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { redact } from '../util/logger.js';
import type { ClaudeConfig } from '../config/schema.js';

/** JSON Schema subset we pass to --json-schema. */
export type JsonSchema = Record<string, unknown>;

export interface ValidationOutcome<T> {
  ok: boolean;
  value?: T;
  errors: string[];
}

export interface ClaudeRequest<T> {
  label: string;
  systemPrompt: string;
  prompt: string;
  /** Absolute paths to JPEG/PNG images sent inline (base64) with the prompt. */
  images?: string[];
  schema: JsonSchema;
  /** Semantic validation beyond JSON schema; return errors to trigger a corrective retry. */
  validate: (data: unknown) => ValidationOutcome<T>;
  signal?: AbortSignal;
  /** Override config.maxRetries for this request. */
  maxRetries?: number;
}

export interface ClaudeUsageTotals {
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  costUsdEquivalent: number;
}

export interface ClaudeResponse<T> {
  value: T;
  attempts: number;
  usage: ClaudeUsageTotals;
  durationMs: number;
  model?: string;
}

export interface RateLimitInfo {
  status: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  windows?: Record<string, { utilization?: number; resetsAt?: number; status?: string }>;
  observedAt: string;
}

export interface ClaudeStatus {
  executable: string;
  version?: string;
  available: boolean;
  authenticated?: boolean;
  model: string;
  active: number;
  queued: number;
  pausedUntil?: string;
  pauseReason?: string;
  rateLimit?: RateLimitInfo;
  totals: ClaudeUsageTotals;
  lastError?: string;
}

interface ParsedStream {
  result?: Record<string, unknown>;
  rateLimit?: RateLimitInfo;
  assistantText: string;
  model?: string;
}

/** Parse Claude CLI stream-json stdout (one JSON object per line). Exported for tests. */
export function parseStreamJson(stdout: string): ParsedStream {
  const out: ParsedStream = { assistantText: '' };
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (msg.type === 'result') out.result = msg;
    else if (msg.type === 'rate_limit_event') {
      const info = (msg.rate_limit_info ?? {}) as Record<string, unknown>;
      const windows = (info.unifiedWindows ?? {}) as RateLimitInfo['windows'];
      const utils = Object.values(windows ?? {}).map((w) => w?.utilization ?? 0);
      out.rateLimit = {
        status: String(info.status ?? 'unknown'),
        resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : undefined,
        rateLimitType: typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined,
        utilization: utils.length ? Math.max(...utils) : undefined,
        windows,
        observedAt: new Date().toISOString(),
      };
    } else if (msg.type === 'assistant') {
      const m = msg.message as { content?: Array<{ type: string; text?: string }>; model?: string } | undefined;
      if (m?.model) out.model = m.model;
      for (const c of m?.content ?? []) if (c.type === 'text' && c.text) out.assistantText += c.text;
    } else if (msg.type === 'system' && typeof msg.model === 'string') {
      out.model = msg.model;
    }
  }
  return out;
}

/** Extract the first balanced JSON object/array from free text (fallback when structured output is missing). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = fenced ? [fenced[1]!, text] : [text];
  for (const c of candidates) {
    const start = c.search(/[[{]/);
    if (start < 0) continue;
    const open = c[start]!;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        try {
          return JSON.parse(c.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  throw new ClaudeError('CLAUDE_NO_JSON', 'Response did not contain valid JSON', { retryable: true });
}

const AUTH_PATTERNS = /(not logged in|please run \/login|invalid api key|authentication|unauthori[sz]ed|oauth token (has )?expired|401)/i;
const LIMIT_PATTERNS = /(usage limit|rate limit|limit reached|quota|too many requests|429|out of (extra )?usage)/i;
const TRANSIENT_PATTERNS = /(overloaded|529|500|502|503|504|timeout|timed out|ECONNRESET|socket hang up|network|internal server error)/i;

function mimeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * Wrapper around the locally installed, already-authenticated Claude Code CLI.
 * - Non-interactive (`-p`), stream-json in/out, images inlined as base64.
 * - Structured output enforced with --json-schema, then semantically validated.
 * - No tools, no session persistence, isolated from user plugins (safe mode).
 * - Bounded concurrency, timeouts, cancellation, corrective retries and
 *   automatic pausing when the account's usage window is exhausted.
 * - Never reads, requires or logs credentials. ANTHROPIC_API_KEY is removed from
 *   the child environment so the CLI uses the existing subscription login.
 */
export class ClaudeCli extends EventEmitter {
  private readonly sem: Semaphore;
  private pausedUntil = 0;
  private pauseReason?: string;
  private rateLimit?: RateLimitInfo;
  private version?: string;
  private available = false;
  private authenticated?: boolean;
  private lastError?: string;
  readonly totals: ClaudeUsageTotals = { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0, costUsdEquivalent: 0 };

  constructor(private cfg: ClaudeConfig, private readonly logger: Logger) {
    super();
    this.sem = new Semaphore(cfg.maxConcurrent);
  }

  updateConfig(cfg: ClaudeConfig): void {
    this.cfg = cfg;
    this.sem.setLimit(cfg.maxConcurrent);
  }

  status(): ClaudeStatus {
    return {
      executable: this.cfg.executable,
      version: this.version,
      available: this.available,
      authenticated: this.authenticated,
      model: this.cfg.model || '(cli default)',
      active: this.sem.inUse,
      queued: this.sem.pending,
      pausedUntil: this.pausedUntil > Date.now() ? new Date(this.pausedUntil).toISOString() : undefined,
      pauseReason: this.pausedUntil > Date.now() ? this.pauseReason : undefined,
      rateLimit: this.rateLimit,
      totals: { ...this.totals },
      lastError: this.lastError,
    };
  }

  /** Child environment: inherit PATH/HOME etc. but never pass an API key. */
  private childEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    // Avoid nested-session detection when the app itself is launched from Claude Code.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    return env;
  }

  /** `claude --version` → version string, or throws if the executable is missing. */
  async checkVersion(): Promise<string> {
    const r = await runProcess(this.cfg.executable, ['--version'], { timeoutMs: 20_000, env: this.childEnv(), label: 'claude --version' });
    this.version = r.stdout.trim().split('\n')[0] ?? '';
    this.available = true;
    return this.version;
  }

  /**
   * Verify authentication + model by making a minimal non-interactive request.
   * Uses the CLI's own login; no credentials are read by this application.
   */
  async checkAuth(signal?: AbortSignal): Promise<{ ok: boolean; model?: string; message: string; durationMs: number }> {
    const started = Date.now();
    try {
      const r = await this.rawInvoke('Reply with the single word OK.', [], undefined, 'You are a health check. Reply with exactly: OK', signal, 90_000);
      const text = String(r.result?.result ?? r.assistantText).trim();
      const isErr = r.result?.is_error === true;
      this.authenticated = !isErr;
      return { ok: !isErr, model: r.model, message: isErr ? redact(text).slice(0, 300) : `Response: ${text.slice(0, 40)}`, durationMs: Date.now() - started };
    } catch (err) {
      const msg = redact((err as Error).message + ' ' + String((err as ProcessError).details?.stderrTail ?? ''));
      this.authenticated = AUTH_PATTERNS.test(msg) ? false : undefined;
      return { ok: false, message: msg.slice(0, 500), durationMs: Date.now() - started };
    }
  }

  private buildArgs(schema: JsonSchema | undefined, systemPrompt: string): string[] {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--tools', '',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--permission-mode', 'dontAsk',
      '--system-prompt', systemPrompt,
    ];
    if (this.cfg.safeMode) args.push('--safe-mode');
    if (schema) args.push('--json-schema', JSON.stringify(schema));
    if (this.cfg.model) args.push('--model', this.cfg.model);
    if (this.cfg.fallbackModel) args.push('--fallback-model', this.cfg.fallbackModel);
    if (this.cfg.effort) args.push('--effort', this.cfg.effort);
    return args;
  }

  private async buildInput(prompt: string, images: string[]): Promise<string> {
    const content: Array<Record<string, unknown>> = [];
    for (const img of images) {
      const data = (await fsp.readFile(img)).toString('base64');
      content.push({ type: 'image', source: { type: 'base64', media_type: mimeFor(img), data } });
    }
    content.push({ type: 'text', text: prompt });
    return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
  }

  private async rawInvoke(prompt: string, images: string[], schema: JsonSchema | undefined, systemPrompt: string, signal?: AbortSignal, timeoutMs?: number): Promise<ParsedStream> {
    const input = await this.buildInput(prompt, images);
    const r = await runProcess(this.cfg.executable, this.buildArgs(schema, systemPrompt), {
      input,
      signal,
      timeoutMs: timeoutMs ?? this.cfg.timeoutSeconds * 1000,
      env: this.childEnv(),
      label: 'claude -p',
      stderrLimit: 16 * 1024,
      // The CLI exits 1 on API/auth errors but still prints a result line on stdout.
      okExitCodes: [1],
    });
    const parsed = parseStreamJson(r.stdout);
    if (parsed.rateLimit) this.observeRateLimit(parsed.rateLimit);
    if (r.exitCode !== 0 && !parsed.result) {
      throw new ProcessError(`claude -p exited with code ${r.exitCode}`, { command: 'claude -p', exitCode: r.exitCode, signal: null, stderrTail: redact(r.stderr.slice(-2000)) });
    }
    return parsed;
  }

  private observeRateLimit(info: RateLimitInfo): void {
    this.rateLimit = info;
    const resetMs = info.resetsAt ? info.resetsAt * 1000 : 0;
    if (info.status === 'rejected' || info.status === 'blocked') {
      this.pause(resetMs > Date.now() ? resetMs : Date.now() + this.cfg.usagePauseMinutes * 60_000, `Claude usage limit reached (${info.rateLimitType ?? 'window'})`);
    } else if (this.cfg.pauseAtUtilization < 1 && (info.utilization ?? 0) >= this.cfg.pauseAtUtilization) {
      // Find the window that triggered and wait for its reset.
      let until = Date.now() + this.cfg.usagePauseMinutes * 60_000;
      for (const [name, w] of Object.entries(info.windows ?? {})) {
        if ((w?.utilization ?? 0) >= this.cfg.pauseAtUtilization && w?.resetsAt) until = Math.max(until, w.resetsAt * 1000);
        if ((w?.utilization ?? 0) >= this.cfg.pauseAtUtilization) this.pauseReason = name;
      }
      this.pause(until, `Claude usage at ${Math.round((info.utilization ?? 0) * 100)}% of ${this.pauseReason ?? 'window'} (pause threshold ${Math.round(this.cfg.pauseAtUtilization * 100)}%)`);
    }
    this.emit('status', this.status());
  }

  private pause(untilMs: number, reason: string): void {
    if (untilMs <= this.pausedUntil) return;
    this.pausedUntil = untilMs;
    this.pauseReason = reason;
    this.logger.warn('Pausing Claude requests to respect account usage limits', { until: new Date(untilMs).toISOString(), reason });
    this.emit('status', this.status());
  }

  /** Clear a usage pause manually (e.g. user knows the limit reset). */
  resume(): void {
    this.pausedUntil = 0;
    this.pauseReason = undefined;
    this.emit('status', this.status());
  }

  private async waitIfPaused(signal?: AbortSignal): Promise<void> {
    while (this.pausedUntil > Date.now()) {
      const wait = Math.min(this.pausedUntil - Date.now(), 60_000);
      await sleep(wait, signal);
    }
  }

  /**
   * Invoke Claude with structured output + validation. Malformed or invalid
   * responses are retried with a corrective prompt; transient failures with backoff.
   */
  async invoke<T>(req: ClaudeRequest<T>): Promise<ClaudeResponse<T>> {
    const maxRetries = req.maxRetries ?? this.cfg.maxRetries;
    const usage: ClaudeUsageTotals = { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0, costUsdEquivalent: 0 };
    const started = Date.now();
    let prompt = req.prompt;
    let lastProblem = '';
    let model: string | undefined;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      if (req.signal?.aborted) throw new CancelledError();
      await this.waitIfPaused(req.signal);
      const release = await this.sem.acquire(req.signal);
      let parsed: ParsedStream;
      const t0 = Date.now();
      try {
        await this.waitIfPaused(req.signal);
        usage.requests++;
        this.totals.requests++;
        this.emit('status', this.status());
        parsed = await this.rawInvoke(prompt, req.images ?? [], req.schema, req.systemPrompt, req.signal);
      } catch (err) {
        usage.failures++;
        this.totals.failures++;
        if (isCancelled(err)) throw err;
        const detail = redact(`${(err as Error).message} ${String((err as ProcessError).details?.stderrTail ?? '')}`);
        this.lastError = detail.slice(0, 500);
        this.logger.warn('Claude CLI invocation failed', { label: req.label, attempt, error: detail.slice(0, 800) });
        if (AUTH_PATTERNS.test(detail)) {
          this.authenticated = false;
          throw new ClaudeError('CLAUDE_AUTH', 'Claude CLI is not authenticated. Run `claude` in a terminal and log in, then retry.', { retryable: false });
        }
        if (err instanceof ProcessError && err.message.includes('failed to start')) {
          throw new ClaudeError('CLAUDE_NOT_FOUND', `Claude CLI executable not found: ${this.cfg.executable}`, { retryable: false });
        }
        if (LIMIT_PATTERNS.test(detail)) this.pause(Date.now() + this.cfg.usagePauseMinutes * 60_000, 'Usage limit reported by Claude CLI');
        lastProblem = detail.slice(0, 300);
        if (attempt <= maxRetries) await sleep(Math.min(30_000, 2000 * 2 ** (attempt - 1)), req.signal);
        continue;
      } finally {
        release();
        this.emit('status', this.status());
      }

      const res = parsed.result ?? {};
      model = parsed.model ?? model;
      const u = (res.usage ?? {}) as Record<string, number>;
      const inTok = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      usage.inputTokens += inTok;
      usage.outputTokens += u.output_tokens ?? 0;
      usage.costUsdEquivalent += Number(res.total_cost_usd ?? 0);
      this.totals.inputTokens += inTok;
      this.totals.outputTokens += u.output_tokens ?? 0;
      this.totals.costUsdEquivalent += Number(res.total_cost_usd ?? 0);

      const resultText = String(res.result ?? parsed.assistantText ?? '');
      if (res.is_error === true || !parsed.result) {
        usage.failures++;
        this.totals.failures++;
        const msg = redact(resultText || String(res.subtype ?? 'no result')).slice(0, 400);
        this.lastError = msg;
        this.logger.warn('Claude returned an error result', { label: req.label, attempt, subtype: res.subtype, message: msg });
        if (AUTH_PATTERNS.test(msg) && !LIMIT_PATTERNS.test(msg)) {
          this.authenticated = false;
          throw new ClaudeError('CLAUDE_AUTH', 'Claude CLI is not authenticated. Run `claude` in a terminal and log in, then retry.');
        }
        if (LIMIT_PATTERNS.test(msg)) this.pause(Date.now() + this.cfg.usagePauseMinutes * 60_000, 'Usage limit reported by Claude CLI');
        lastProblem = msg;
        if (attempt <= maxRetries) await sleep(TRANSIENT_PATTERNS.test(msg) ? 5000 * attempt : 1000, req.signal);
        continue;
      }
      this.authenticated = true;

      let data: unknown = res.structured_output;
      if (data === undefined || data === null) {
        try {
          data = extractJson(resultText);
        } catch {
          lastProblem = 'The response was not valid JSON.';
          prompt = correctivePrompt(req.prompt, lastProblem, resultText);
          continue;
        }
      }
      const v = req.validate(data);
      if (v.ok && v.value !== undefined) {
        this.logger.debug('Claude request ok', { label: req.label, attempt, ms: Date.now() - t0, inTok, outTok: u.output_tokens });
        return { value: v.value, attempts: attempt, usage, durationMs: Date.now() - started, model };
      }
      lastProblem = v.errors.slice(0, 12).join('; ');
      this.logger.warn('Claude response failed validation; retrying with corrective prompt', { label: req.label, attempt, errors: v.errors.slice(0, 12) });
      prompt = correctivePrompt(req.prompt, lastProblem, JSON.stringify(data).slice(0, 6000));
    }
    throw new ClaudeError('CLAUDE_INVALID_RESPONSE', `Claude did not return a valid response for ${req.label} after ${maxRetries + 1} attempt(s): ${lastProblem}`, {
      retryable: true,
      details: { label: req.label },
    });
  }
}

export function correctivePrompt(original: string, problems: string, previous: string): string {
  return (
    `${original}\n\n---\nIMPORTANT CORRECTION: Your previous answer to this exact request was rejected by the validator.\n` +
    `Problems: ${problems}\n` +
    `Previous answer (for reference):\n${previous}\n` +
    `Return a corrected answer that fixes every problem. Use only timestamps that appear in the provided frames' range. Output must match the JSON schema exactly.`
  );
}
