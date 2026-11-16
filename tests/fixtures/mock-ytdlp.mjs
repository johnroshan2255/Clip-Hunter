#!/usr/bin/env node
// Minimal stand-in for yt-dlp: "downloads" MOCK_YTDLP_SOURCE into the -o folder.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('2099.01.01-mock');
  process.exit(0);
}
const tpl = args[args.indexOf('-o') + 1];
const url = args[args.length - 1];
if (!tpl || !url?.startsWith('http')) process.exit(2);
const out = path.join(path.dirname(tpl), 'Mock_Video_abc123.mp4');
console.log('Mock Video Title');
for (const p of [10, 55.5, 100]) console.log(`[download]  ${p}% of ~ 1.00MiB at 1.0MiB/s ETA 00:01`);
fs.copyFileSync(process.env.MOCK_YTDLP_SOURCE, out);
console.log(out);
