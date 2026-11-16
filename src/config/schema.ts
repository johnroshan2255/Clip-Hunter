import { z } from 'zod';

/**
 * Central configuration schema. Every field has a sensible default so an empty
 * `cliphunter.config.json` (or none at all) yields a working setup.
 */

const claudeSchema = z
  .object({
    /** Executable name or absolute path of the Claude Code CLI. */
    executable: z.string().min(1).default('claude'),
    /** Model alias or full name passed via --model. Empty string = CLI default. */
    model: z.string().default('sonnet'),
    /** Optional fallback model(s) passed via --fallback-model. */
    fallbackModel: z.string().default(''),
    /** Optional --effort level. Empty = CLI default. */
    effort: z.enum(['', 'low', 'medium', 'high', 'xhigh', 'max']).default(''),
    /** Max simultaneous `claude` subprocesses. */
    maxConcurrent: z.number().int().min(1).max(8).default(2),
    /** Per-invocation timeout. */
    timeoutSeconds: z.number().int().min(30).max(3600).default(420),
    /** Corrective retries for malformed / invalid responses. */
    maxRetries: z.number().int().min(0).max(5).default(2),
    /**
     * Pause new Claude requests when the CLI reports that this fraction of the
     * current rate-limit window has been used (0..1). 1 = only pause when the CLI says "rejected".
     */
    pauseAtUtilization: z.number().min(0.1).max(1).default(0.95),
    /** How long to wait before re-checking after a usage-limit pause. */
    usagePauseMinutes: z.number().min(1).max(600).default(15),
    /** Isolate from user plugins/hooks/MCP servers (auth is unaffected). */
    safeMode: z.boolean().default(true),
  })
  .default({});

const analysisSchema = z
  .object({
    /** Game in the recording (e.g. "GTA V", "Fortnite"). Empty = let Claude identify it. */
    gameTitle: z.string().max(80).default(''),
    /** Seconds between pass-1 analysis frames. */
    frameIntervalSeconds: z.number().min(0.25).max(30).default(2),
    /** Width of analysis frames (height follows aspect ratio). */
    analysisWidth: z.number().int().min(160).max(1280).default(480),
    /** Frames per contact sheet (grid is computed as columns x rows). */
    contactSheetColumns: z.number().int().min(1).max(8).default(4),
    contactSheetRows: z.number().int().min(1).max(8).default(5),
    /** Width of a single tile on the contact sheet. */
    contactSheetTileWidth: z.number().int().min(160).max(960).default(384),
    /** Contact sheets sent to Claude per discovery request. */
    sheetsPerRequest: z.number().int().min(1).max(20).default(6),
    /** Length of chunks for frame extraction (enables resume + parallelism). */
    extractionChunkSeconds: z.number().int().min(60).max(3600).default(600),
    /** Parallel FFmpeg extraction processes. */
    extractionConcurrency: z.number().int().min(1).max(8).default(2),
    /** Use hardware-accelerated decoding where available (falls back automatically). */
    hardwareDecode: z.boolean().default(true),
    /** Scene-change threshold for FFmpeg scdet (0-100). */
    sceneThreshold: z.number().min(1).max(100).default(12),
    /** Frames per second for pass-2 detailed inspection. */
    detailFps: z.number().min(0.5).max(10).default(2),
    /** Context added before/after a pass-1 range when inspecting it in pass 2. */
    detailContextSeconds: z.number().min(0).max(60).default(8),
    /** Max length of a single pass-2 inspection window. */
    detailMaxWindowSeconds: z.number().min(10).max(300).default(90),
    /** Pass-1 ranges below this score are not inspected in pass 2. */
    discoveryMinScore: z.number().min(0).max(10).default(5),
    /** Max pass-2 inspections (0 = automatic: 2.5x desired clip count, at least 20). */
    maxDetailInspections: z.number().int().min(0).max(500).default(0),
    /** Audio stream index to analyse/keep (-1 = default stream). */
    audioStreamIndex: z.number().int().min(-1).default(-1),
    /** Audio envelope window in seconds. */
    audioWindowSeconds: z.number().min(0.05).max(2).default(0.25),
    /** dB above rolling median that counts as a sudden loud event. */
    audioOnsetDb: z.number().min(3).max(40).default(12),
    /** Enable local speech recognition if whisper.cpp is installed. */
    transcription: z.boolean().default(true),
  })
  .default({});

const clipsSchema = z
  .object({
    count: z.number().int().min(1).max(500).default(20),
    minDurationSeconds: z.number().min(3).max(600).default(10),
    preferredMinSeconds: z.number().min(3).max(600).default(15),
    preferredMaxSeconds: z.number().min(3).max(600).default(35),
    maxDurationSeconds: z.number().min(5).max(600).default(60),
    minEntertainmentScore: z.number().min(0).max(10).default(6),
    /** Max fraction of overlap (relative to shorter clip) allowed between two selected clips. */
    maxOverlapRatio: z.number().min(0).max(1).default(0.15),
    /** Seconds within which boundaries may be snapped to quiet audio / scene cuts. */
    boundarySnapSeconds: z.number().min(0).max(5).default(1.5),
  })
  .default({});

const audioSchema = z
  .object({
    keepOriginal: z.boolean().default(true),
    normalize: z.boolean().default(true),
    /** Target integrated loudness for normalization (LUFS). */
    targetLufs: z.number().min(-30).max(-8).default(-14),
    /** Linear gain applied to game audio (1 = unchanged). */
    volume: z.number().min(0).max(4).default(1),
    fadeInSeconds: z.number().min(0).max(5).default(0.3),
    fadeOutSeconds: z.number().min(0).max(5).default(0.6),
    /** Optional background music file (must be content you have rights to). */
    backgroundMusicPath: z.string().default(''),
    backgroundMusicVolume: z.number().min(0).max(2).default(0.25),
    /** Duck background music under game audio. */
    ducking: z.boolean().default(true),
    bitrateKbps: z.number().int().min(64).max(512).default(192),
  })
  .default({});

const textStyleSchema = z
  .object({
    fontFamily: z.string().default('Helvetica Neue, Helvetica, Arial, sans-serif'),
    fontSize: z.number().int().min(12).max(200).default(64),
    fontWeight: z.union([z.literal('normal'), z.literal('bold')]).default('bold'),
    color: z.string().default('#FFFFFF'),
    outlineColor: z.string().default('#000000'),
    outlineWidth: z.number().min(0).max(20).default(6),
    shadow: z.boolean().default(true),
    /** Vertical position as fraction of frame height (0 = top, 1 = bottom). */
    positionY: z.number().min(0).max(1).default(0.12),
  })
  .default({});

const textSchema = z
  .object({
    introText: z.string().default(''),
    introSeconds: z.number().min(0).max(10).default(2.5),
    endingText: z.string().default(''),
    endingSeconds: z.number().min(0).max(10).default(2.5),
    /** Show the AI-generated short caption (title) for each clip. Off by default. */
    aiCaptions: z.boolean().default(false),
    /** Burn subtitles when speech is detected and a local transcriber exists. */
    subtitles: z.boolean().default(false),
    /** whisper.cpp CLI used for optional local speech recognition. */
    whisperExecutable: z.string().default('whisper-cli'),
    /** Path to a whisper.cpp ggml model (e.g. ggml-base.en.bin). Empty = transcription disabled. */
    whisperModelPath: z.string().default(''),
    style: textStyleSchema,
    subtitleStyle: textStyleSchema.default({ fontSize: 52, positionY: 0.78 }),
  })
  .default({});

const renderSchema = z
  .object({
    width: z.number().int().min(240).max(4096).default(1080),
    height: z.number().int().min(240).max(4096).default(1920),
    fps: z.number().min(10).max(120).default(30),
    /** x264 CRF (lower = better quality). */
    crf: z.number().int().min(0).max(51).default(20),
    preset: z
      .enum(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'])
      .default('medium'),
    concurrency: z.number().int().min(1).max(8).default(2),
    /** Threads per FFmpeg render process (0 = auto). */
    threadsPerJob: z.number().int().min(0).max(64).default(0),
    compositionMode: z.enum(['blur', 'crop', 'smart']).default('blur'),
    /** For crop mode: horizontal crop center as fraction of width (0..1). */
    cropPositionX: z.number().min(0).max(1).default(0.5),
    /** Gameplay scale in blur mode: fraction of output width the foreground occupies. */
    blurForegroundWidth: z.number().min(0.5).max(1).default(1),
    blurStrength: z.number().min(1).max(100).default(30),
    /** Smart crop falls back to blur when tracking confidence is below this. */
    smartCropMinConfidence: z.number().min(0).max(1).default(0.55),
    /** Max horizontal pan speed for smart crop (fraction of source width per second). */
    smartCropMaxPanPerSecond: z.number().min(0.01).max(2).default(0.25),
    /** Duration tolerance for validation, seconds. */
    durationToleranceSeconds: z.number().min(0.05).max(2).default(0.25),
    maxRetries: z.number().int().min(0).max(5).default(1),
  })
  .default({});

const storageSchema = z
  .object({
    /** Root folder for projects. Relative paths resolve against the app root. */
    projectsDir: z.string().default('projects'),
    /** Folder for exported clip collections. */
    exportsDir: z.string().default('exports'),
    /** Folder for global state (job queue). */
    dataDir: z.string().default('data'),
    /** How a source video is placed into the project: hardlink → symlink fallback, or a full copy. */
    importMode: z.enum(['link', 'copy']).default('link'),
    /** Minimum free disk space (GB) required before heavy stages start. */
    minFreeDiskGb: z.number().min(0).max(1000).default(3),
    /** Delete pass-1 frames after analysis completes (contact sheets are kept). */
    cleanupFramesAfterAnalysis: z.boolean().default(false),
  })
  .default({});

const serverSchema = z
  .object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(4317),
    /** Concurrent analysis jobs (each may use several FFmpeg / Claude processes). */
    analysisConcurrency: z.number().int().min(1).max(4).default(1),
    /** Folders that path-based imports are allowed from (empty = home directory). */
    allowedImportRoots: z.array(z.string()).default([]),
  })
  .default({});

export const configSchema = z
  .object({
    ffmpegPath: z.string().default('ffmpeg'),
    ffprobePath: z.string().default('ffprobe'),
    claude: claudeSchema,
    analysis: analysisSchema,
    clips: clipsSchema,
    audio: audioSchema,
    text: textSchema,
    render: renderSchema,
    storage: storageSchema,
    server: serverSchema,
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  })
  .superRefine((c, ctx) => {
    const d = c.clips;
    if (!(d.minDurationSeconds <= d.preferredMinSeconds && d.preferredMinSeconds <= d.preferredMaxSeconds && d.preferredMaxSeconds <= d.maxDurationSeconds)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clips'],
        message: 'Clip durations must satisfy min <= preferredMin <= preferredMax <= max',
      });
    }
    if (c.render.width % 2 !== 0 || c.render.height % 2 !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['render'], message: 'Render width/height must be even (yuv420p)' });
    }
  });

export type AppConfig = z.infer<typeof configSchema>;
export type ClipsConfig = AppConfig['clips'];
export type RenderConfig = AppConfig['render'];
export type AudioConfig = AppConfig['audio'];
export type TextConfig = AppConfig['text'];
export type TextStyle = TextConfig['style'];
export type AnalysisConfig = AppConfig['analysis'];
export type ClaudeConfig = AppConfig['claude'];

/** Per-project overrides that the UI may set. */
export const projectSettingsSchema = z
  .object({
    analysis: z.object({ gameTitle: z.string().max(80) }).partial(),
    clips: z
      .object({
        count: z.number().int().min(1).max(500),
        minDurationSeconds: z.number().min(3).max(600),
        maxDurationSeconds: z.number().min(5).max(600),
        minEntertainmentScore: z.number().min(0).max(10),
      })
      .partial(),
    render: z
      .object({
        compositionMode: z.enum(['blur', 'crop', 'smart']),
        cropPositionX: z.number().min(0).max(1),
        fps: z.number().min(10).max(120),
        crf: z.number().int().min(0).max(51),
      })
      .partial(),
    audio: z
      .object({
        normalize: z.boolean(),
        volume: z.number().min(0).max(4),
        backgroundMusicPath: z.string(),
        backgroundMusicVolume: z.number().min(0).max(2),
        ducking: z.boolean(),
      })
      .partial(),
    text: z
      .object({
        introText: z.string().max(200),
        endingText: z.string().max(200),
        aiCaptions: z.boolean(),
        subtitles: z.boolean(),
      })
      .partial(),
  })
  .partial();

export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
