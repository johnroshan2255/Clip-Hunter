import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { Services } from '../services.js';
import { createApp } from './app.js';
import { APP_ROOT } from '../config/load.js';
import { closeLogFiles } from '../util/logger.js';
import { killAllProcesses, liveProcessCount } from '../util/process.js';

async function main(): Promise<void> {
  const svc = Services.create();
  await svc.init();
  const app = createApp(svc, { staticDir: path.join(APP_ROOT, 'dist', 'web') });
  const { host, port } = svc.cfg.server;
  const server: Server = app.listen(port, host, () => {
    svc.logger.info(`ClipHunter server listening on http://${host}:${port}`);
    if (host === '0.0.0.0' || host === '::') {
      const lan = Object.values(os.networkInterfaces()).flatMap((l) => l ?? []).filter((a) => a.family === 'IPv4' && !a.internal);
      for (const a of lan) svc.logger.info(`Shared on your network: http://${a.address}:${port}`);
      svc.logger.warn('LAN sharing is on: anyone on this network can use ClipHunter (import videos from allowed folders, render, delete projects).');
    }
  });
  // Check the Claude CLI in the background so the UI can show its status.
  void svc.claude.checkVersion().then(
    (v) => svc.logger.info('Claude CLI detected', { version: v }),
    (err: Error) => svc.logger.warn('Claude CLI not available', { error: err.message }),
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      killAllProcesses('SIGKILL');
      process.exit(1);
    }
    shuttingDown = true;
    svc.logger.info(`Received ${signal}; shutting down gracefully (running jobs will resume on next start)`);
    server.close();
    await svc.shutdown();
    if (liveProcessCount()) killAllProcesses('SIGTERM');
    await closeLogFiles();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => svc.logger.error('Unhandled rejection', { err }));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
