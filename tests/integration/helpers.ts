import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixtureVideo } from '../fixtures/makeFixture.js';
import { Services } from '../../src/services.js';
import { loadConfig } from '../../src/config/load.js';
import { Logger } from '../../src/util/logger.js';
import type { Job } from '../../src/jobs/queue.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MOCK_CLAUDE = path.resolve(here, '../fixtures/mock-claude.mjs');
export const MEDIA_DIR = path.resolve(here, '../fixtures/media');

/** Short synthetic test video (cached between runs). */
export async function fixtureVideo(seconds = 60): Promise<string> {
  return makeFixtureVideo(path.join(MEDIA_DIR, `it-${seconds}s.mp4`), { seconds, width: 640, height: 360, fps: 30 });
}

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cliphunter-${prefix}-`));
}

/** Services wired to a temp workspace and the mock Claude CLI. */
export function testServices(dir: string, overrides: Record<string, unknown> = {}): Services {
  const base = {
    claude: { executable: MOCK_CLAUDE, maxRetries: 1 },
    storage: { projectsDir: path.join(dir, 'projects'), dataDir: path.join(dir, 'data'), exportsDir: path.join(dir, 'exports'), minFreeDiskGb: 0 },
    server: { allowedImportRoots: [dir, MEDIA_DIR] },
    analysis: { extractionChunkSeconds: 60, hardwareDecode: false },
    render: { preset: 'ultrafast', concurrency: 2 },
    clips: { count: 3, minDurationSeconds: 8, preferredMinSeconds: 10, preferredMaxSeconds: 15, maxDurationSeconds: 20 },
  };
  const cfg = loadConfig({ root: '/nonexistent', overrides: deepMerge(base, overrides) });
  return new Services(cfg, new Logger({ level: 'error', sinks: [] }));
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' ? deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}

export function waitForJob(svc: Services, jobId: string, timeoutMs = 120_000): Promise<Job> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Job ${jobId} timed out`)), timeoutMs);
    const check = (j: Job) => {
      if (j.id !== jobId) return;
      if (['completed', 'failed', 'cancelled'].includes(j.status)) {
        clearTimeout(t);
        svc.queue.off('job', check);
        resolve(j);
      }
    };
    svc.queue.on('job', check);
    try {
      check(svc.queue.get(jobId));
    } catch {
      /* not yet */
    }
  });
}
