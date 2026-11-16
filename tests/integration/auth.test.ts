import fs from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { Auth, generatePassword, hashPassword, verifyPassword } from '../../src/server/auth.js';
import type { Services } from '../../src/services.js';
import { tempDir, testServices } from './helpers.js';

describe('password hashing and tokens', () => {
  it('verifies the right password only', () => {
    const h = hashPassword('correct horse');
    expect(h).toMatch(/^scrypt\$/);
    expect(h).not.toContain('correct horse');
    expect(verifyPassword('correct horse', h)).toBe(true);
    expect(verifyPassword('wrong', h)).toBe(false);
    expect(verifyPassword('x', 'garbage')).toBe(false);
  });
  it('generates memorable passwords', () => {
    expect(generatePassword()).toMatch(/^clip-[a-z]+-\d{4}-[a-z]+$/);
  });
  it('issues tokens that expire and are invalidated by a password change', () => {
    const dir = tempDir('auth');
    const secretFile = `${dir}/secret`;
    const a = new Auth({ passwordHash: hashPassword('one-password'), requireOnLoopback: true, secretFile });
    const t = a.issueToken();
    expect(a.verifyToken(t)).toBe(true);
    expect(a.verifyToken(t, Date.now() + 31 * 86_400_000)).toBe(false);
    expect(a.verifyToken(t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).toBe(false);
    const b = new Auth({ passwordHash: hashPassword('another-password'), requireOnLoopback: true, secretFile });
    expect(b.verifyToken(t)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('HTTP API with a password', () => {
  let dir: string;
  let svc: Services;
  let app: ReturnType<typeof createApp>;
  const PASSWORD = 'friends-only-1234';

  beforeAll(async () => {
    dir = tempDir('authapi');
    svc = testServices(dir, { server: { passwordHash: hashPassword(PASSWORD), requirePasswordOnLocalhost: true } });
    await svc.init();
    app = createApp(svc);
  });
  afterAll(async () => {
    await svc.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('blocks the API without a session but keeps health and auth endpoints open', async () => {
    expect((await request(app).get('/api/projects')).status).toBe(401);
    expect((await request(app).get('/api/events')).status).toBe(401);
    expect((await request(app).get('/api/health')).status).toBe(200);
    const st = await request(app).get('/api/auth/status');
    expect(st.body).toMatchObject({ enabled: true, authenticated: false });
  });

  it('logs in with the right password and sets an HttpOnly cookie', async () => {
    expect((await request(app).post('/api/auth/login').send({ password: 'nope' })).status).toBe(401);
    const ok = await request(app).post('/api/auth/login').send({ password: PASSWORD });
    expect(ok.status).toBe(200);
    const cookie = ok.headers['set-cookie']![0]!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const res = await request(app).get('/api/projects').set('Cookie', cookie.split(';')[0]!);
    expect(res.status).toBe(200);
    const out = await request(app).post('/api/auth/logout').set('Cookie', cookie.split(';')[0]!);
    expect(out.headers['set-cookie']![0]).toMatch(/Max-Age=0/);
  });

  it('locks out after repeated wrong passwords', async () => {
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await request(app).post('/api/auth/login').send({ password: `wrong-${i}` })).status;
    expect(last).toBe(429);
    // Even the right password is refused during the lockout.
    expect((await request(app).post('/api/auth/login').send({ password: PASSWORD })).status).toBe(429);
  });

  it('exempts this computer (localhost) by default', async () => {
    const dir2 = tempDir('authlocal');
    const svc2 = testServices(dir2, { server: { passwordHash: hashPassword(PASSWORD) } });
    await svc2.init();
    const app2 = createApp(svc2);
    expect((await request(app2).get('/api/projects')).status).toBe(200);
    expect((await request(app2).get('/api/auth/status')).body).toMatchObject({ enabled: true, authenticated: true, canLogout: false });
    await svc2.shutdown();
    fs.rmSync(dir2, { recursive: true, force: true });
  });
});
