#!/usr/bin/env node
/**
 * ClipHunter command line.
 *   doctor                         Check FFmpeg, FFprobe, Claude CLI (version + auth), disk
 *   run <video> [options]          Import, analyse and render in one go (headless)
 *   analyze <video|projectId>      Import (if a path) and analyse
 *   render <projectId> [--force]   Render selected clips
 *   list                           List projects
 * Options: --count N --game "Fortnite" --mode blur|crop|smart --name NAME --min-score N --model sonnet
 */
import { Services } from './services.js';
import { closeLogFiles } from './util/logger.js';
import { killAllProcesses } from './util/process.js';
import { formatTimestamp } from './util/time.js';
import type { Job } from './jobs/queue.js';
import type { ProjectSettings } from './config/schema.js';

function parseArgs(argv: string[]): { cmd: string; positional: string[]; flags: Record<string, string | boolean> } {
  const [cmd = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { cmd, positional, flags };
}

function settingsFromFlags(f: Record<string, string | boolean>): ProjectSettings {
  const s: ProjectSettings = {};
  if (typeof f.game === 'string') s.analysis = { gameTitle: f.game };
  if (f.count || f['min-score']) {
    s.clips = {};
    if (f.count) s.clips.count = Number(f.count);
    if (f['min-score']) s.clips.minEntertainmentScore = Number(f['min-score']);
  }
  if (typeof f.mode === 'string') s.render = { compositionMode: f.mode as 'blur' | 'crop' | 'smart' };
  return s;
}

async function waitForJob(svc: Services, jobId: string): Promise<Job> {
  return new Promise((resolve) => {
    let lastLine = '';
    const onJob = (j: Job) => {
      if (j.id !== jobId) return;
      const line = `[${j.type}] ${(j.progress * 100).toFixed(1)}% ${j.message ?? ''}`;
      if (line !== lastLine) {
        lastLine = line;
        process.stdout.write(`${line}\n`);
      }
      if (['completed', 'failed', 'cancelled'].includes(j.status)) {
        svc.queue.off('job', onJob);
        resolve(j);
      }
    };
    svc.queue.on('job', onJob);
  });
}

async function doctor(svc: Services): Promise<boolean> {
  const info = await svc.systemInfo();
  const ok = (b: unknown) => (b ? 'OK  ' : 'FAIL');
  console.log('ClipHunter environment check\n');
  console.log(`${ok(true)} Node.js        ${info.node} (${info.platform}, ${info.cpus} CPUs, ${info.memoryGb} GB RAM)`);
  console.log(`${ok(info.ffmpeg)} FFmpeg         ${info.ffmpeg ?? 'not found'}`);
  console.log(`${ok(info.ffprobe)} FFprobe        ${info.ffprobe ?? 'not found'}`);
  let claudeOk = false;
  try {
    const v = await svc.claude.checkVersion();
    console.log(`${ok(true)} Claude CLI     ${v} (${svc.cfg.claude.executable})`);
    process.stdout.write('     Checking Claude authentication with a tiny request… ');
    const auth = await svc.claude.checkAuth();
    claudeOk = auth.ok;
    console.log(auth.ok ? `authenticated (model ${auth.model ?? svc.cfg.claude.model}, ${auth.durationMs} ms)` : `FAILED: ${auth.message}`);
    const rl = svc.claude.status().rateLimit;
    if (rl) console.log(`     Usage: ${rl.status}, ${Object.entries(rl.windows ?? {}).map(([k, w]) => `${k} ${Math.round((w?.utilization ?? 0) * 100)}%`).join(', ')}`);
  } catch (err) {
    console.log(`FAIL Claude CLI     ${(err as Error).message}`);
  }
  const whisper = info.whisper as { ok: boolean; reason?: string };
  console.log(`${whisper.ok ? 'OK  ' : 'INFO'} Transcription  ${whisper.ok ? 'whisper.cpp available' : `optional, disabled (${whisper.reason})`}`);
  const free = info.freeDiskGb as number;
  console.log(`${free > svc.cfg.storage.minFreeDiskGb ? 'OK  ' : 'WARN'} Disk           ${free} GB free at ${info.projectsDir}`);
  return Boolean(info.ffmpeg && info.ffprobe && claudeOk);
}

async function main(): Promise<void> {
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));
  const overrides: Record<string, unknown> = {};
  if (typeof flags.model === 'string') overrides.claude = { model: flags.model };
  const svc = Services.create(overrides);
  const exit = async (code: number) => {
    await svc.shutdown().catch(() => undefined);
    await closeLogFiles();
    process.exit(code);
  };
  process.on('SIGINT', () => {
    console.log('\nInterrupted — stopping (progress is checkpointed; re-run to resume).');
    void exit(130);
  });

  switch (cmd) {
    case 'doctor': {
      await svc.store.init();
      const good = await doctor(svc);
      await closeLogFiles();
      process.exit(good ? 0 : 1);
      break;
    }
    case 'list': {
      await svc.store.init();
      for (const p of svc.store.list()) {
        console.log(`${p.id.padEnd(32)} ${p.status.padEnd(10)} ${p.metadata ? formatTimestamp(p.metadata.durationSeconds) : '-'}  candidates=${p.counts.candidates} selected=${p.counts.selected} clips=${p.counts.clipsCompleted}${p.game ? `  game=${p.game}` : ''}`);
      }
      await closeLogFiles();
      return;
    }
    case 'analyze':
    case 'run': {
      const target = positional[0];
      if (!target) throw new Error(`Usage: ${cmd} <video path | project id>`);
      await svc.init();
      let projectId: string;
      if (svc.store.has(target)) {
        projectId = target;
        const active = svc.queue.activeForProject(projectId);
        const job = active ?? (await svc.enqueueAnalysis(projectId, typeof flags.from === 'string' ? (flags.from as never) : undefined));
        const done = await waitForJob(svc, job.id);
        if (done.status !== 'completed') return exit(1);
      } else {
        const p = await svc.createProject({ path: target, name: typeof flags.name === 'string' ? flags.name : undefined, settings: settingsFromFlags(flags) });
        projectId = p.id;
        console.log(`Project ${projectId} created`);
        const job = svc.queue.activeForProject(projectId)!;
        const done = await waitForJob(svc, job.id);
        if (done.status !== 'completed') {
          console.error(`Analysis ${done.status}: ${done.message ?? ''}`);
          return exit(1);
        }
      }
      const p = svc.store.get(projectId);
      console.log(`Analysis complete: ${p.counts.candidates} candidates, ${p.counts.selected} selected${p.game ? ` (game: ${p.game})` : ''}`);
      if (cmd === 'run') {
        const rj = await svc.enqueueRender(projectId, {});
        const done = await waitForJob(svc, rj.id);
        const fin = svc.store.get(projectId);
        console.log(`Render ${done.status}: ${done.message ?? ''}`);
        for (const c of fin.clips) console.log(`  ${c.id} ${c.status.padEnd(9)} ${formatTimestamp(c.start)}-${formatTimestamp(c.end)} [${c.category}] ${c.title}`);
        return exit(done.status === 'completed' ? 0 : 1);
      }
      return exit(0);
    }
    case 'render': {
      const id = positional[0];
      if (!id) throw new Error('Usage: render <project id> [--force]');
      await svc.init();
      const job = svc.queue.activeForProject(id) ?? (await svc.enqueueRender(id, { force: flags.force === true }));
      const done = await waitForJob(svc, job.id);
      console.log(`Render ${done.status}: ${done.message ?? ''}`);
      return exit(done.status === 'completed' ? 0 : 1);
    }
    default:
      console.log(`Usage: npm run cli -- <command>
  doctor                         Verify FFmpeg/FFprobe/Claude CLI/auth/disk
  run <video> [options]          Import + analyse + render (headless)
  analyze <video|projectId>      Import + analyse (or resume an existing project)
  render <projectId> [--force]   Render the selected clips
  list                           List projects
Options: --count N  --game "GTA V"  --mode blur|crop|smart  --name NAME  --min-score N  --model sonnet|opus`);
      await closeLogFiles();
  }
}

main().catch(async (err) => {
  console.error(`Error: ${(err as Error).message}`);
  killAllProcesses();
  await closeLogFiles();
  process.exit(1);
});
