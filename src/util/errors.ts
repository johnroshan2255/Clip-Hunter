/** Structured error hierarchy. `code` is stable and safe to show in the UI. */
export class AppError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(code: string, message: string, opts: { details?: Record<string, unknown>; retryable?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.details = opts.details;
    this.retryable = opts.retryable ?? false;
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, details: this.details, retryable: this.retryable };
  }
}

export class ConfigError extends AppError {
  constructor(message: string) {
    super('CONFIG_INVALID', message);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_FAILED', message, { details });
  }
}

export class ProcessError extends AppError {
  constructor(
    message: string,
    details: { command: string; exitCode: number | null; signal: string | null; stderrTail: string; timedOut?: boolean },
    retryable = true,
  ) {
    super(details.timedOut ? 'PROCESS_TIMEOUT' : 'PROCESS_FAILED', message, { details, retryable });
  }
}

export class CancelledError extends AppError {
  constructor(message = 'Operation cancelled') {
    super('CANCELLED', message);
  }
}

export class ClaudeError extends AppError {
  constructor(code: string, message: string, opts: { details?: Record<string, unknown>; retryable?: boolean } = {}) {
    super(code, message, opts);
  }
}

export class DiskSpaceError extends AppError {
  constructor(message: string, details: Record<string, unknown>) {
    super('DISK_SPACE_LOW', message, { details });
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super('NOT_FOUND', message);
  }
}

export function isCancelled(err: unknown): boolean {
  return err instanceof CancelledError || (err instanceof Error && err.name === 'AbortError');
}

export function errorToJSON(err: unknown): Record<string, unknown> {
  if (err instanceof AppError) return err.toJSON();
  if (err instanceof Error) return { name: err.name, code: 'INTERNAL', message: err.message };
  return { name: 'Error', code: 'INTERNAL', message: String(err) };
}
