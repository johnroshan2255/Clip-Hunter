import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { CancelledError, ProcessError } from './errors.js';

export interface ResolvedCommand {
  command: string;
  /** Arguments to put before the caller's arguments (e.g. the JS entry of an npm shim). */
  prefixArgs: string[];
}

/**
 * Windows: executables are found via PATH + PATHEXT, but Node cannot spawn
 * `.cmd`/`.bat` files without a shell (which we never use). npm-installed CLIs
 * (e.g. `claude.cmd`) are thin shims around a JS file, so we run that file with
 * this Node binary instead. Returns null when nothing usable is found.
 */
export function resolveWindowsCommand(
  command: string,
  env: { PATH?: string; PATHEXT?: string },
  io: { isFile: (p: string) => boolean; readFile: (p: string) => string; nodePath: string } = {
    isFile: (p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    nodePath: process.execPath,
  },
): ResolvedCommand | null {
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
  const hasExt = /\.[a-z0-9]+$/i.test(command);
  const isPath = /[\\/]/.test(command);
  const dirs = isPath ? [''] : (env.PATH ?? '').split(';').filter(Boolean);
  for (const dir of dirs) {
    const base = isPath ? command : path.win32.join(dir, command);
    const candidates = hasExt ? [base] : [...exts.filter((e) => e === '.exe' || e === '.com').map((e) => base + e), ...exts.filter((e) => e !== '.exe' && e !== '.com').map((e) => base + e)];
    for (const c of candidates) {
      if (!io.isFile(c)) continue;
      if (/\.(exe|com)$/i.test(c)) return { command: c, prefixArgs: [] };
      if (/\.(cmd|bat)$/i.test(c)) {
        // npm shim: ... "%dp0%\node_modules\pkg\cli.js" %*   (or "%~dp0\...")
        const text = io.readFile(c);
        const m = /"%~?dp0%?\\([^"]+?\.(?:c|m)?js)"/i.exec(text);
        if (m) {
          const script = path.win32.join(path.win32.dirname(c), m[1]!);
          if (io.isFile(script)) return { command: io.nodePath, prefixArgs: [script] };
        }
      }
    }
    if (isPath) break;
  }
  return null;
}

const resolveCache = new Map<string, ResolvedCommand>();

/** Resolve how to spawn `command` on this platform (identity outside Windows). */
export function resolveCommand(command: string): ResolvedCommand {
  if (process.platform !== 'win32') return { command, prefixArgs: [] };
  const hit = resolveCache.get(command);
  if (hit) return hit;
  const r = resolveWindowsCommand(command, { PATH: process.env.PATH ?? process.env.Path, PATHEXT: process.env.PATHEXT }) ?? { command, prefixArgs: [] };
  resolveCache.set(command, r);
  return r;
}

export interface RunOptions {
  /** Abort → SIGTERM, then SIGKILL after `killGraceMs`. */
  signal?: AbortSignal;
  timeoutMs?: number;
  killGraceMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Data written to stdin then closed. */
  input?: string | Buffer;
  /** Streaming callbacks (stdout is still collected unless collectStdout=false). */
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
  collectStdout?: boolean;
  /** Max bytes of stderr retained (tail). */
  stderrLimit?: number;
  /** Max bytes of stdout retained. */
  stdoutLimit?: number;
  /** Treat these exit codes as success. */
  okExitCodes?: number[];
  /** Label used in errors/logs instead of the full command line. */
  label?: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/** Registry of live child processes so graceful shutdown can terminate them. */
const live = new Set<ChildProcess>();

export function liveProcessCount(): number {
  return live.size;
}

export function killAllProcesses(signal: NodeJS.Signals = 'SIGTERM'): void {
  for (const cp of live) {
    try {
      cp.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly limit: number) {}
  push(b: Buffer): void {
    this.chunks.push(b);
    this.size += b.length;
    while (this.size > this.limit && this.chunks.length > 1) {
      const first = this.chunks.shift()!;
      this.size -= first.length;
    }
  }
  toString(): string {
    const s = Buffer.concat(this.chunks).toString('utf8');
    return s.length > this.limit ? s.slice(s.length - this.limit) : s;
  }
}

/**
 * Run an executable with an argument array (never through a shell), capturing
 * stdout and stderr separately, with cancellation and timeout support.
 */
export function runProcess(command: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  const label = opts.label ?? command;
  if (opts.signal?.aborted) return Promise.reject(new CancelledError(`${label} cancelled before start`));

  return new Promise<RunResult>((resolve, reject) => {
    const started = Date.now();
    const resolved = resolveCommand(command);
    const cp = spawn(resolved.command, [...resolved.prefixArgs, ...args], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    live.add(cp);

    const collect = opts.collectStdout !== false;
    const stdoutBuf = new TailBuffer(opts.stdoutLimit ?? 64 * 1024 * 1024);
    const stderrBuf = new TailBuffer(opts.stderrLimit ?? 64 * 1024);
    let timedOut = false;
    let cancelled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const terminate = () => {
      if (cp.exitCode !== null || cp.signalCode !== null) return;
      cp.kill('SIGTERM');
      killTimer = setTimeout(() => cp.kill('SIGKILL'), opts.killGraceMs ?? 3000);
      killTimer.unref();
    };

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          terminate();
        }, opts.timeoutMs)
      : undefined;
    timer?.unref();

    const onAbort = () => {
      cancelled = true;
      terminate();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    cp.stdout!.on('data', (c: Buffer) => {
      if (collect) stdoutBuf.push(c);
      opts.onStdout?.(c);
    });
    cp.stderr!.on('data', (c: Buffer) => {
      stderrBuf.push(c);
      opts.onStderr?.(c);
    });
    cp.stdin!.on('error', () => {
      /* EPIPE when the process exits before reading stdin — reported via exit code */
    });
    if (opts.input !== undefined) cp.stdin!.end(opts.input);
    else cp.stdin!.end();

    const cleanup = () => {
      live.delete(cp);
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    cp.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      const hint = err.code === 'ENOENT' ? ` (executable not found: ${command})` : '';
      reject(
        new ProcessError(`${label} failed to start${hint}: ${err.message}`, {
          command: label,
          exitCode: null,
          signal: null,
          stderrTail: '',
        }, false),
      );
    });

    cp.on('close', (code, sig) => {
      if (settled) return;
      settled = true;
      cleanup();
      const stderr = stderrBuf.toString();
      if (cancelled) {
        reject(new CancelledError(`${label} cancelled`));
        return;
      }
      const ok = code !== null && (code === 0 || (opts.okExitCodes ?? []).includes(code));
      if (timedOut || !ok) {
        reject(
          new ProcessError(
            timedOut ? `${label} timed out after ${opts.timeoutMs}ms` : `${label} exited with code ${code ?? sig}`,
            { command: label, exitCode: code, signal: sig, stderrTail: stderr.slice(-4000), timedOut },
          ),
        );
        return;
      }
      resolve({ stdout: stdoutBuf.toString(), stderr, exitCode: code ?? 0, durationMs: Date.now() - started });
    });
  });
}

/**
 * Spawn a long-running process and expose its stdout as a stream (used for
 * streaming raw PCM / raw frames without buffering whole files in memory).
 */
export function spawnStreaming(
  command: string,
  args: readonly string[],
  opts: { signal?: AbortSignal; label?: string } = {},
): { child: ChildProcess; done: Promise<{ exitCode: number; stderr: string }> } {
  const label = opts.label ?? command;
  const resolved = resolveCommand(command);
  const child = spawn(resolved.command, [...resolved.prefixArgs, ...args], { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
  live.add(child);
  const stderrBuf = new TailBuffer(32 * 1024);
  child.stderr!.on('data', (c: Buffer) => stderrBuf.push(c));
  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 3000).unref();
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const done = new Promise<{ exitCode: number; stderr: string }>((resolve, reject) => {
    child.on('error', (err) => {
      live.delete(child);
      reject(new ProcessError(`${label} failed to start: ${err.message}`, { command: label, exitCode: null, signal: null, stderrTail: '' }, false));
    });
    child.on('close', (code, sig) => {
      live.delete(child);
      opts.signal?.removeEventListener('abort', onAbort);
      if (cancelled) return reject(new CancelledError(`${label} cancelled`));
      const stderr = stderrBuf.toString();
      if (code !== 0) {
        return reject(new ProcessError(`${label} exited with code ${code ?? sig}`, { command: label, exitCode: code, signal: sig, stderrTail: stderr.slice(-4000) }));
      }
      resolve({ exitCode: 0, stderr });
    });
  });
  return { child, done };
}
