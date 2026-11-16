import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response, Router } from 'express';
import express from 'express';

/**
 * Optional shared-password protection for LAN sharing.
 * - Password stored only as a salted scrypt hash ("scrypt$<salt>$<hash>").
 * - Login sets an HttpOnly, SameSite=Lax cookie holding a stateless HMAC token
 *   (expiry + password fingerprint), so changing the password logs everyone out.
 * - Failed logins are rate-limited per client IP.
 * - Loopback requests (this computer) can be exempt.
 */

const COOKIE = 'cliphunter_session';
const SESSION_DAYS = 30;
const SCRYPT_KEYLEN = 32;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** Memorable random password, e.g. "clip-river-4821-orbit". */
export function generatePassword(): string {
  const words = ['river', 'orbit', 'pixel', 'turbo', 'nitro', 'comet', 'blaze', 'drift', 'rocket', 'ember', 'falcon', 'glide', 'jungle', 'lunar', 'mango', 'neon', 'radar', 'storm', 'tiger', 'vortex'];
  const a = crypto.randomInt(words.length);
  const b = (a + 1 + crypto.randomInt(words.length - 1)) % words.length;
  return `clip-${words[a]}-${crypto.randomInt(1000, 10000)}-${words[b]}`;
}

export function isLoopback(addr: string | undefined): boolean {
  return !!addr && (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1');
}

function loadSecret(file: string): Buffer {
  try {
    const s = fs.readFileSync(file);
    if (s.length >= 32) return s;
  } catch {
    /* create below */
  }
  const s = crypto.randomBytes(48);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export interface AuthOptions {
  passwordHash: string;
  /** Require the password even for requests from this computer. */
  requireOnLoopback: boolean;
  /** File holding the HMAC secret (persisted so sessions survive restarts). */
  secretFile: string;
  maxFailures?: number;
  lockoutMs?: number;
}

export class Auth {
  readonly enabled: boolean;
  private readonly secret: Buffer;
  private readonly fingerprint: string;
  private readonly failures = new Map<string, { count: number; until: number }>();

  constructor(private readonly o: AuthOptions) {
    this.enabled = !!o.passwordHash;
    this.secret = this.enabled ? loadSecret(o.secretFile) : Buffer.alloc(0);
    this.fingerprint = crypto.createHash('sha256').update(o.passwordHash).digest('hex').slice(0, 16);
  }

  issueToken(now = Date.now()): string {
    const exp = now + SESSION_DAYS * 86_400_000;
    const sig = crypto.createHmac('sha256', this.secret).update(`${exp}:${this.fingerprint}`).digest('base64url');
    return `${exp}.${sig}`;
  }

  verifyToken(token: string | undefined, now = Date.now()): boolean {
    if (!token) return false;
    const [expStr, sig] = token.split('.');
    const exp = Number(expStr);
    if (!sig || !Number.isFinite(exp) || exp < now) return false;
    const expected = crypto.createHmac('sha256', this.secret).update(`${exp}:${this.fingerprint}`).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** Whether this request is allowed without logging in. */
  isAuthenticated(req: Request): boolean {
    if (!this.enabled) return true;
    if (!this.o.requireOnLoopback && isLoopback(req.socket.remoteAddress)) return true;
    return this.verifyToken(parseCookies(req.headers.cookie)[COOKIE]);
  }

  /** Middleware: reject unauthenticated API requests with 401. */
  guard() {
    return (req: Request, res: Response, next: NextFunction) => {
      if (this.isAuthenticated(req)) return next();
      res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'Password required' } });
    };
  }

  private clientKey(req: Request): string {
    return req.socket.remoteAddress ?? 'unknown';
  }

  routes(): Router {
    const r = express.Router();
    r.get('/status', (req, res) => {
      const exempt = this.enabled && !this.o.requireOnLoopback && isLoopback(req.socket.remoteAddress);
      res.json({ enabled: this.enabled, authenticated: this.isAuthenticated(req), canLogout: this.enabled && !exempt });
    });
    r.post('/login', (req, res) => {
      if (!this.enabled) return res.json({ ok: true });
      const key = this.clientKey(req);
      const f = this.failures.get(key);
      const now = Date.now();
      if (f && f.until > now) {
        res.setHeader('Retry-After', String(Math.ceil((f.until - now) / 1000)));
        return res.status(429).json({ error: { code: 'TOO_MANY_ATTEMPTS', message: `Too many wrong attempts. Try again in ${Math.ceil((f.until - now) / 1000)}s.` } });
      }
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!password || password.length > 200 || !verifyPassword(password, this.o.passwordHash)) {
        const count = (f && f.until > 0 && f.until <= now ? 0 : f?.count ?? 0) + 1;
        const max = this.o.maxFailures ?? 5;
        this.failures.set(key, { count, until: count >= max ? now + (this.o.lockoutMs ?? 60_000) * Math.min(10, count - max + 1) : 0 });
        return res.status(401).json({ error: { code: 'BAD_PASSWORD', message: 'Wrong password' } });
      }
      this.failures.delete(key);
      res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(this.issueToken())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}`);
      res.json({ ok: true });
    });
    r.post('/logout', (_req, res) => {
      res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      res.json({ ok: true });
    });
    return r;
  }
}
