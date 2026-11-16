import type { Candidate, ClipFx, ClipRecord, FacecamRect, FxEvent, FxEventType, MontageRecord, Project, StageName, VoiceEffect } from '../../src/types';

export type { Candidate, ClipFx, ClipRecord, FacecamRect, FxEvent, FxEventType, MontageRecord, Project, StageName, VoiceEffect };

export interface FxSettings {
  enabled: boolean;
  auto: boolean;
  intensity: 'subtle' | 'normal' | 'crazy';
  hookTitle: boolean;
  hookSeconds: number;
  replay: boolean;
  replaySpeed: number;
  replayMaxSeconds: number;
  replaySmoothing: 'none' | 'blend' | 'motion';
  zoom: boolean;
  shake: boolean;
  flash: boolean;
  glitch: boolean;
  sfx: boolean;
  sfxVolume: number;
  voice: boolean;
  facecam: 'auto' | 'on' | 'off';
}

export interface SoundInfo {
  name: string;
  description: string;
  builtin: boolean;
}

export interface Job {
  id: string;
  type: 'analyze' | 'render' | 'montage' | 'download';
  projectId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  message?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: { message?: string; code?: string };
}

export interface ProjectListItem extends Project {
  activeJob: Job | null;
}

export interface ProjectDetail extends Project {
  jobs: Job[];
  effectiveConfig: {
    clips: { count: number; minDurationSeconds: number; maxDurationSeconds: number; minEntertainmentScore: number };
    render: { compositionMode: 'blur' | 'crop' | 'smart'; width: number; height: number; fps: number; videoEncoder: string };
    analysis: { gameTitle: string };
    text: { introText: string; endingText: string; aiCaptions: boolean; subtitles: boolean; spokenLanguage: string; subtitleLanguages: string[]; hindiScript: 'devanagari' | 'roman'; subtitleMode: 'separate' | 'stacked'; captionStyle: 'karaoke' | 'classic' };
    audio: { normalize: boolean; volume: number; backgroundMusicPath: string; denoise: 'off' | 'light' | 'strong'; musicRemoval: 'off' | 'reduce' | 'voices' };
    fx: FxSettings;
  };
}

export interface ClaudeStatus {
  version?: string;
  available: boolean;
  authenticated?: boolean;
  model: string;
  active: number;
  queued: number;
  pausedUntil?: string;
  pauseReason?: string;
  rateLimit?: { status: string; utilization?: number; windows?: Record<string, { utilization?: number; resetsAt?: number }> };
  totals: { requests: number; failures: number };
  lastError?: string;
}

export interface SystemInfo {
  node: string;
  ffmpeg: string | null;
  ffprobe: string | null;
  claude: ClaudeStatus;
  whisper: { ok: boolean; reason?: string; multilingual?: boolean };
  tools?: { encoders: Record<string, boolean>; ytdlp: string | null; gifski: boolean; demucs: boolean; sfxDir: string };
  freeDiskGb: number;
  cpus: number;
  config: Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const err = (data as { error?: { message?: string; code?: string } } | undefined)?.error;
    if (res.status === 401 && err?.code === 'AUTH_REQUIRED') window.dispatchEvent(new Event('cliphunter:auth-required'));
    throw new ApiError(err?.message ?? res.statusText, err?.code ?? 'HTTP_ERROR', res.status);
  }
  return data as T;
}

export interface AuthStatus {
  enabled: boolean;
  authenticated: boolean;
  canLogout: boolean;
}

export const api = {
  authStatus: () => req<AuthStatus>('GET', '/api/auth/status'),
  login: (password: string) => req<{ ok: boolean }>('POST', '/api/auth/login', { password }),
  logout: () => req<{ ok: boolean }>('POST', '/api/auth/logout'),
  system: () => req<SystemInfo>('GET', '/api/system'),
  claudeCheck: () => req<{ version: string; auth: { ok: boolean; message: string }; status: ClaudeStatus }>('POST', '/api/system/claude-check'),
  claudeResume: () => req<ClaudeStatus>('POST', '/api/system/claude-resume'),
  projects: () => req<ProjectListItem[]>('GET', '/api/projects'),
  project: (id: string) => req<ProjectDetail>('GET', `/api/projects/${id}`),
  createProject: (body: { path: string; name?: string; settings?: unknown }) => req<Project>('POST', '/api/projects', body),
  updateProject: (id: string, body: { name?: string; settings?: unknown; facecam?: FacecamRect | null }) => req<Project>('PATCH', `/api/projects/${id}`, body),
  importUrl: (body: { url: string; name?: string; settings?: unknown }) => req<Project>('POST', '/api/projects/from-url', body),
  saveFx: (id: string, cid: string, fx: Pick<ClipFx, 'hook' | 'replay' | 'events'>) => req<Candidate>('PUT', `/api/projects/${id}/candidates/${cid}/fx`, fx),
  resetFx: (id: string, cid: string) => req<Candidate>('DELETE', `/api/projects/${id}/candidates/${cid}/fx`),
  planFx: (id: string, cid: string) => req<ClipFx>('POST', `/api/projects/${id}/candidates/${cid}/fx/auto`),
  detectFacecam: (id: string) => req<Project>('POST', `/api/projects/${id}/facecam/detect`),
  sounds: () => req<SoundInfo[]>('GET', '/api/fx/sounds'),
  deleteSound: (name: string) => req<{ ok: boolean }>('DELETE', `/api/fx/sounds/${encodeURIComponent(name)}`),
  uploadSound: async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/fx/sounds', { method: 'POST', body: fd });
    const data = (await res.json()) as { name?: string; error?: { message?: string; code?: string } };
    if (!res.ok) throw new ApiError(data.error?.message ?? 'Upload failed', data.error?.code ?? 'UPLOAD', res.status);
    return data as { name: string };
  },
  createMontage: (id: string, body: { clipIds?: string[]; orientation: 'vertical' | 'horizontal'; lang?: string | null; transition: string }) => req<MontageRecord>('POST', `/api/projects/${id}/montages`, body),
  deleteMontage: (id: string, mid: string) => req<{ ok: boolean }>('DELETE', `/api/projects/${id}/montages/${mid}`),
  deleteProject: (id: string) => req<{ ok: boolean }>('DELETE', `/api/projects/${id}`),
  analyze: (id: string, fromStage?: StageName) => req<Job>('POST', `/api/projects/${id}/analyze`, fromStage ? { fromStage } : {}),
  render: (id: string, body: { clipIds?: string[]; force?: boolean } = {}) => req<Job>('POST', `/api/projects/${id}/render`, body),
  cancel: (id: string) => req<Job>('POST', `/api/projects/${id}/cancel`),
  reselect: (id: string) => req<Project>('POST', `/api/projects/${id}/reselect`),
  candidates: (id: string) => req<{ candidates: Candidate[]; selection: { notes: string[] } | null }>('GET', `/api/projects/${id}/candidates`),
  updateCandidate: (id: string, cid: string, body: Partial<Pick<Candidate, 'status' | 'selected' | 'start' | 'end' | 'title'>>) =>
    req<Candidate>('PATCH', `/api/projects/${id}/candidates/${cid}`, body),
  addCandidate: (id: string, body: { start: number; end: number; title?: string }) => req<Candidate>('POST', `/api/projects/${id}/candidates`, body),
  deleteClip: (id: string, clipId: string) => req<{ ok: boolean }>('DELETE', `/api/projects/${id}/clips/${clipId}`),
  exportFolder: (id: string) => req<{ directory: string; count: number }>('POST', `/api/projects/${id}/export`, {}),
  logs: (id: string, kind: 'analysis' | 'rendering') => req<Array<Record<string, unknown>>>('GET', `/api/projects/${id}/logs?kind=${kind}&tail=300`),
  retryJob: (jobId: string) => req<Job>('POST', `/api/jobs/${jobId}/retry`),
  upload: (file: File, fields: { name?: string; settings?: unknown }, onProgress: (f: number) => void) =>
    new Promise<Project>((resolve, reject) => {
      const fd = new FormData();
      if (fields.name) fd.append('name', fields.name);
      if (fields.settings) fd.append('settings', JSON.stringify(fields.settings));
      fd.append('file', file);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/projects/upload');
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        const data = JSON.parse(xhr.responseText || '{}') as Project & { error?: { message: string; code: string } };
        if (xhr.status >= 300) reject(new ApiError(data.error?.message ?? 'Upload failed', data.error?.code ?? 'UPLOAD', xhr.status));
        else resolve(data);
      };
      xhr.onerror = () => reject(new ApiError('Network error', 'NETWORK', 0));
      xhr.send(fd);
    }),
};

export const urls = {
  clipVideo: (id: string, clipId: string, v?: string, lang?: string | null) =>
    `/api/projects/${id}/clips/${clipId}/video?${new URLSearchParams({ ...(v ? { v } : {}), ...(lang ? { lang } : {}) }).toString()}`,
  clipThumb: (id: string, clipId: string, v?: string) => `/api/projects/${id}/clips/${clipId}/thumbnail${v ? `?v=${encodeURIComponent(v)}` : ''}`,
  clipDownload: (id: string, clipId: string, lang?: string | null) => `/api/projects/${id}/clips/${clipId}/download${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`,
  clipSubtitles: (id: string, clipId: string, lang: string) => `/api/projects/${id}/clips/${clipId}/subtitles/${lang}`,
  frame: (id: string, t: number) => `/api/projects/${id}/frame?t=${t.toFixed(1)}`,
  preview: (id: string, cid: string, start: number, end: number) => `/api/projects/${id}/candidates/${cid}/preview?s=${start}&e=${end}`,
  exportZip: (id: string) => `/api/projects/${id}/export.zip`,
  clipGif: (id: string, clipId: string, lang?: string | null) => `/api/projects/${id}/clips/${clipId}/gif${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`,
  sound: (name: string) => `/api/fx/sounds/${encodeURIComponent(name)}`,
  montageVideo: (id: string, mid: string) => `/api/projects/${id}/montages/${mid}/video`,
  montageDownload: (id: string, mid: string) => `/api/projects/${id}/montages/${mid}/download`,
};

/** Subscribe to server-sent events; reconnects automatically. */
export function subscribe(handlers: { project?: (e: { type: string; projectId: string; project?: Project }) => void; job?: (j: Job) => void; claude?: (s: ClaudeStatus) => void }): () => void {
  const es = new EventSource('/api/events');
  if (handlers.project) es.addEventListener('project', (e) => handlers.project!(JSON.parse((e as MessageEvent).data)));
  if (handlers.job) es.addEventListener('job', (e) => handlers.job!(JSON.parse((e as MessageEvent).data)));
  if (handlers.claude) es.addEventListener('claude', (e) => handlers.claude!(JSON.parse((e as MessageEvent).data)));
  return () => es.close();
}

export function fmtTime(s: number, ms = false): string {
  const sign = s < 0 ? '-' : '';
  s = Math.abs(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = ms ? sec.toFixed(1).padStart(4, '0') : Math.floor(sec).toString().padStart(2, '0');
  return `${sign}${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${ss}`;
}

export function parseTime(t: string): number {
  const v = t.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(v);
  if (!m) return Number.NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function fmtBytes(n: number): string {
  if (n > 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}
