import { spawn, type ChildProcess } from 'node:child_process';
import { CancelledError, ProcessError } from './errors.js';

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
    const cp = spawn(command, [...args], {
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
  const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
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
