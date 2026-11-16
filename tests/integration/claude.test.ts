import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCli } from '../../src/ai/claudeCli.js';
import { discoverySchema, validateDiscovery } from '../../src/ai/schemas.js';
import { loadConfig } from '../../src/config/load.js';
import { Logger } from '../../src/util/logger.js';
import { ClaudeError } from '../../src/util/errors.js';
import { MOCK_CLAUDE, tempDir } from './helpers.js';

const logger = new Logger({ level: 'error', sinks: [] });
const cfg = (o: Record<string, unknown> = {}) => loadConfig({ root: '/nonexistent', overrides: { claude: { executable: MOCK_CLAUDE, maxRetries: 2, ...o } } }).claude;
const req = {
  label: 't',
  systemPrompt: 'sys',
  prompt: 'Footage (100.0s–340.0s)',
  schema: discoverySchema,
  validate: (d: unknown) => validateDiscovery(d, { start: 100, end: 340 }, 3),
};

describe('ClaudeCli (subprocess protocol, mocked executable)', () => {
  const old = { ...process.env };
  afterEach(() => {
    process.env = { ...old };
  });

  it('returns validated structured output and tracks usage', async () => {
    const cli = new ClaudeCli(cfg(), logger);
    expect(await cli.checkVersion()).toMatch(/Mock/);
    const r = await cli.invoke(req);
    expect(r.attempts).toBe(1);
    expect(r.value.moments.length).toBeGreaterThan(0);
    for (const m of r.value.moments) {
      expect(m.start).toBeGreaterThanOrEqual(100);
      expect(m.end).toBeLessThanOrEqual(340);
    }
    expect(cli.status().rateLimit?.status).toBe('allowed');
  });

  it('retries invalid responses with a corrective prompt', async () => {
    const dir = tempDir('claude');
    const counter = path.join(dir, 'calls.txt');
    process.env.MOCK_CLAUDE_MODE = 'garbage-once';
    process.env.MOCK_CLAUDE_COUNTER = counter;
    const cli = new ClaudeCli(cfg(), logger);
    const r = await cli.invoke(req);
    expect(r.attempts).toBe(2);
    expect(fs.readFileSync(counter, 'utf8').trim().split('\n')).toEqual(['garbage', 'ok']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fails fast with a clear error when not authenticated', async () => {
    process.env.MOCK_CLAUDE_MODE = 'auth';
    const cli = new ClaudeCli(cfg(), logger);
    await expect(cli.invoke(req)).rejects.toMatchObject({ code: 'CLAUDE_AUTH' });
  });

  it('gives up after retries on persistent process failures', async () => {
    process.env.MOCK_CLAUDE_MODE = 'error';
    const cli = new ClaudeCli(cfg({ maxRetries: 1 }), logger);
    const err = await cli.invoke(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeError);
    expect(cli.status().totals.failures).toBe(2);
  });

  it('reports a missing executable', async () => {
    const cli = new ClaudeCli(cfg({ executable: '/nonexistent/claude' }), logger);
    await expect(cli.invoke({ ...req, maxRetries: 0 })).rejects.toMatchObject({ code: 'CLAUDE_NOT_FOUND' });
  });

  it('never passes an API key to the CLI', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak';
    const cli = new ClaudeCli(cfg(), logger);
    const env = (cli as unknown as { childEnv: () => NodeJS.ProcessEnv }).childEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('cancels an in-flight request', async () => {
    const cli = new ClaudeCli(cfg(), logger);
    const ac = new AbortController();
    ac.abort();
    await expect(cli.invoke({ ...req, signal: ac.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('limits concurrent processes', async () => {
    const cli = new ClaudeCli(cfg({ maxConcurrent: 1 }), logger);
    let maxActive = 0;
    cli.on('status', (s: { active: number }) => (maxActive = Math.max(maxActive, s.active)));
    await Promise.all([cli.invoke(req), cli.invoke(req), cli.invoke(req)]);
    expect(maxActive).toBe(1);
  });
});
