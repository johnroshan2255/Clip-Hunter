import type { ProjectSettings } from './config/schema.js';

export interface AudioStreamInfo {
  index: number;
  codec: string;
  channels: number;
  sampleRate: number;
  channelLayout?: string;
  language?: string;
  title?: string;
  isDefault: boolean;
  bitRate?: number;
}

export interface VideoStreamInfo {
  index: number;
  codec: string;
  profile?: string;
  width: number;
  height: number;
  /** Width/height after applying rotation metadata. */
  displayWidth: number;
  displayHeight: number;
  rotation: number;
  pixFmt?: string;
  /** Average frame rate (frames / duration). */
  avgFps: number;
  /** Real base frame rate reported by the container. */
  rFps: number;
  isVariableFrameRate: boolean;
  frameCount?: number;
  bitRate?: number;
}

export interface VideoMetadata {
  path: string;
  sizeBytes: number;
  durationSeconds: number;
  /** Container start time; frame timestamps are reported relative to this. */
  startTime: number;
  formatName: string;
  formatLongName?: string;
  bitRate?: number;
  video: VideoStreamInfo;
  audio: AudioStreamInfo[];
  /** Stream index of the audio stream used for analysis/rendering, or null. */
  selectedAudioIndex: number | null;
  probedAt: string;
}

export interface AnalysisFrame {
  /** Seconds from start of the video. */
  t: number;
  /** Path relative to the project directory. */
  file: string;
}

export interface ContactSheet {
  id: string;
  /** Path relative to the project directory. */
  file: string;
  start: number;
  end: number;
  tiles: Array<{ index: number; t: number }>;
  width: number;
  height: number;
}

export interface SceneChange {
  t: number;
  score: number;
}

export interface AudioEnvelope {
  windowSeconds: number;
  sampleRate: number;
  /** RMS level per window, dBFS (-100 = silence). */
  rmsDb: number[];
  /** Peak level per window, dBFS. */
  peakDb: number[];
  /** Zero-crossing rate per window (0..1); high values ≈ noisy/broadband sounds. */
  zcr: number[];
}

export type AudioEventKind = 'onset' | 'sustained_loud' | 'silence_break';

export interface AudioEvent {
  t: number;
  duration: number;
  peakDb: number;
  /** Increase over the local background level, dB. */
  deltaDb: number;
  kind: AudioEventKind;
  /** Rough guess from spectral character; never used alone for scoring. */
  character: 'impulsive_noise' | 'tonal' | 'mixed';
}

export interface AudioAnalysis {
  meanDb: number;
  medianDb: number;
  maxPeakDb: number;
  events: AudioEvent[];
  /** Fraction of windows at or above -0.1 dBFS in the source. */
  clippingRatio: number;
}

export type MomentCategory =
  | 'funny'
  | 'unexpected'
  | 'vehicle_crash'
  | 'vehicle_stunt'
  | 'police_chase'
  | 'explosion'
  | 'npc_interaction'
  | 'driving_sequence'
  | 'near_death'
  | 'fail'
  | 'action'
  | 'combat'
  | 'unusual'
  | 'elimination'
  | 'clutch'
  | 'skill_play'
  | 'victory'
  | 'glitch'
  | 'other';

export const MOMENT_CATEGORIES: readonly MomentCategory[] = [
  'funny',
  'unexpected',
  'vehicle_crash',
  'vehicle_stunt',
  'police_chase',
  'explosion',
  'npc_interaction',
  'driving_sequence',
  'near_death',
  'fail',
  'action',
  'combat',
  'unusual',
  'elimination',
  'clutch',
  'skill_play',
  'victory',
  'glitch',
  'other',
];

export interface FocusPoint {
  t: number;
  /** Horizontal center of the important action, 0 (left) .. 1 (right). */
  x: number;
  confidence: number;
}

export type CandidateStatus = 'pending' | 'approved' | 'rejected';

export type FxEventType = 'zoom' | 'shake' | 'flash' | 'glitch' | 'sfx' | 'voice';
export type VoiceEffect = 'chipmunk' | 'deep' | 'echo' | 'robot';
export const FX_EVENT_TYPES: readonly FxEventType[] = ['zoom', 'shake', 'flash', 'glitch', 'sfx', 'voice'];
export const VOICE_EFFECTS: readonly VoiceEffect[] = ['chipmunk', 'deep', 'echo', 'robot'];

/** One timed effect. Times are absolute seconds in the source video (stable when the clip is trimmed). */
export interface FxEvent {
  type: FxEventType;
  t: number;
  /** Seconds (zoom/shake/glitch/voice); ignored for flash and sfx. */
  duration: number;
  /** 0..1, default 0.6. */
  strength?: number;
  /** Sound effect name (sfx). */
  sound?: string;
  /** Voice effect (voice). */
  voice?: VoiceEffect;
}

/** Fun-effects plan of a clip: written by the AI director or edited by hand. */
export interface ClipFx {
  source: 'auto' | 'manual';
  /** Hook title shown in the first seconds; per reel language ("en", "hi", or "default"). */
  hook?: Record<string, string>;
  /** Slow-motion replay of [start, end] (absolute source seconds), inserted right after `end`. */
  replay?: { start: number; end: number } | null;
  events: FxEvent[];
  /** Settings signature an automatic plan was generated for (re-planned when it changes). */
  signature?: string;
  generatedAt?: string;
}

export interface Candidate {
  id: string;
  start: number;
  end: number;
  /** Moment of peak action, if known. */
  peakTime?: number;
  category: MomentCategory;
  title: string;
  description: string;
  entertainmentScore: number;
  confidence: number;
  reason: string;
  /** Sub-scores provided by the AI (0-10). */
  scores?: {
    unexpectedness?: number;
    visualClarity?: number;
    intensity?: number;
    context?: number;
    boundaryQuality?: number;
    replayValue?: number;
  };
  /** Supporting evidence. */
  audioScore: number;
  sceneScore: number;
  /** Combined ranking score (0-10). */
  finalScore: number;
  focus?: FocusPoint[];
  source: 'pass1' | 'pass2' | 'manual';
  refined: boolean;
  status: CandidateStatus;
  /** Whether this candidate was chosen by automatic selection. */
  selected: boolean;
  /** Edited manually by the user. */
  edited?: boolean;
  parentId?: string;
  notes?: string[];
  /** Fun effects for this moment (hook title, replay, zooms, sound effects…). */
  fx?: ClipFx;
}

export type StageName =
  | 'ingest'
  | 'metadata'
  | 'frames'
  | 'audio'
  | 'contactSheets'
  | 'discovery'
  | 'inspection'
  | 'selection';

export const ANALYSIS_STAGES: readonly StageName[] = [
  'ingest',
  'metadata',
  'frames',
  'audio',
  'contactSheets',
  'discovery',
  'inspection',
  'selection',
];

export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface StageState {
  status: StageStatus;
  progress: number;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: Record<string, unknown>;
}

export type ClipStatus = 'queued' | 'rendering' | 'validating' | 'completed' | 'failed' | 'cancelled';

export interface ClipValidation {
  ok: boolean;
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  pixFmt: string;
  fps: number;
  hasAudio: boolean;
  audioCodec?: string;
  sizeBytes: number;
  decodeOk: boolean;
  peakDb?: number;
  warnings: string[];
  errors: string[];
}

export interface ClipRecord {
  id: string;
  candidateId: string;
  index: number;
  start: number;
  end: number;
  title: string;
  category: MomentCategory;
  score: number;
  status: ClipStatus;
  progress: number;
  /** Paths relative to project dir. */
  file?: string;
  thumbnail?: string;
  compositionRequested: 'blur' | 'crop' | 'smart';
  compositionUsed?: 'blur' | 'crop' | 'smart';
  attempts: number;
  error?: Record<string, unknown>;
  validation?: ClipValidation;
  renderedAt?: string;
  renderMs?: number;
  subtitles?: boolean;
  /** Language detected in the clip's speech (ISO code). */
  spokenLanguage?: string;
  /** Exported caption files (paths relative to project dir). */
  subtitleFiles?: Array<{ lang: string; file: string }>;
  /** Language reels (paths relative to project dir). `lang` null = no subtitles; "hi+en" = stacked. */
  variants?: Array<{ lang: string | null; file: string; sizeBytes: number }>;
  /** Hash of everything that affects the output; unchanged key = reuse completed render. */
  renderKey?: string;
  warnings?: string[];
  /** Effects applied in the render (summary for the UI). */
  fxSummary?: string[];
  /** Output length, which differs from end-start when a replay was inserted. */
  outputSeconds?: number;
  /** Best few seconds of the reel (output timeline), used for GIF export. */
  highlight?: { start: number; end: number };
}

/** Webcam overlay position in the source (fractions of width/height). */
export interface FacecamRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MontageRecord {
  id: string;
  orientation: 'vertical' | 'horizontal';
  lang: string | null;
  clipIds: string[];
  transition: string;
  status: 'queued' | 'rendering' | 'completed' | 'failed';
  progress: number;
  file?: string;
  durationSeconds?: number;
  sizeBytes?: number;
  createdAt: string;
  error?: string;
}

export type ProjectStatus = 'created' | 'queued' | 'analyzing' | 'analyzed' | 'rendering' | 'completed' | 'failed' | 'cancelled';

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Path the user imported from (informational). */
  originalPath: string;
  /** Source file path relative to project dir. */
  sourceFile: string;
  importMethod?: 'hardlink' | 'symlink' | 'copy' | 'upload';
  status: ProjectStatus;
  settings: ProjectSettings;
  stages: Record<StageName, StageState>;
  metadata?: VideoMetadata;
  counts: { candidates: number; selected: number; clipsCompleted: number; clipsFailed: number };
  clips: ClipRecord[];
  error?: Record<string, unknown>;
  /** Game shown in the recording: user-provided hint or detected by pass 1. */
  game?: string;
  /** Webcam overlay: null = checked, none found; undefined = not checked yet. */
  facecam?: { rect: FacecamRect | null; source: 'auto' | 'manual'; checkedAt: string };
  montages?: MontageRecord[];
  /** Import from a link (yt-dlp). */
  download?: { url: string; status: 'queued' | 'downloading' | 'done' | 'failed'; progress: number; error?: string; title?: string };
  claudeUsage?: { requests: number; failures: number; inputTokens: number; outputTokens: number; costUsdEquivalent: number };
}
