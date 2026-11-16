import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DiskSpaceError } from './errors.js';

/** Write JSON atomically (temp file + rename) so crashes never leave half-written state. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(data, null, 2));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
}

export function writeJsonAtomicSync(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
}

export async function readJsonOr<T>(file: string, fallback: T): Promise<T> {
  try {
    return await readJson<T>(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function fileSize(p: string): Promise<number> {
  try {
    return (await fsp.stat(p)).size;
  } catch {
    return 0;
  }
}

export async function ensureDir(p: string): Promise<void> {
  await fsp.mkdir(p, { recursive: true });
}

export async function removePath(p: string): Promise<void> {
  await fsp.rm(p, { recursive: true, force: true });
}

/** Free bytes available on the filesystem that holds `p`. */
export async function freeDiskBytes(p: string): Promise<number> {
  let dir = path.resolve(p);
  while (!(await exists(dir))) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const s = await fsp.statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

export async function assertDiskSpace(p: string, requiredBytes: number, what: string): Promise<void> {
  const free = await freeDiskBytes(p);
  if (free < requiredBytes) {
    throw new DiskSpaceError(
      `Not enough disk space for ${what}: ${(free / 1e9).toFixed(2)} GB free, ${(requiredBytes / 1e9).toFixed(2)} GB required`,
      { freeBytes: free, requiredBytes, path: p },
    );
  }
}

/** Size of a directory tree in bytes. */
export async function dirSize(p: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(p, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) total += await dirSize(full);
    else if (e.isFile()) total += (await fsp.stat(full)).size;
  }
  return total;
}

/** Ensure `child` resolves inside `parent` (path traversal guard). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Remove stale *.tmp files left over from crashed atomic writes / renders. */
export async function cleanupTempFiles(dir: string): Promise<number> {
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.endsWith('.partial')) {
        await removePath(full);
        removed++;
      } else removed += await cleanupTempFiles(full);
    } else if (e.name.endsWith('.tmp') || e.name.includes('.tmp.')) {
      await fsp.rm(full, { force: true });
      removed++;
    }
  }
  return removed;
}
