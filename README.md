# ClipHunter

Local, AI-assisted clipping for long gameplay recordings. ClipHunter analyses 1–3 hour sessions from **any game** (GTA V / GTA VI, Fortnite, Warzone, Apex, racing games…), finds the entertaining moments with your **existing Claude Code CLI login**, and renders validated **1080×1920** clips for Instagram Reels, YouTube Shorts and TikTok.

- No Anthropic API key, no paid APIs. AI analysis runs through the `claude` CLI you are already logged into.
- All video and audio processing is done locally with FFmpeg/FFprobe.
- A web UI is included for reviewing moments, editing timestamps, rendering, previewing and exporting.

## Requirements

| Tool | Notes |
|---|---|
| Node.js ≥ 20.10 | |
| FFmpeg + FFprobe | Needs `libx264`. `drawtext`/`libass` are **not** required; text is rendered as PNG overlays. |
| Claude Code CLI | Installed and logged in (`claude` in a terminal, then `/login`). |
| whisper.cpp (optional) | Only needed for subtitles. Set `text.whisperExecutable` and `text.whisperModelPath`. |

## Quick start

```bash
npm install
npm run doctor          # checks FFmpeg, FFprobe, the Claude CLI version and login, and free disk space
npm run build
npm start               # http://127.0.0.1:4317
```

Development mode (hot reload for the UI and server): `npm run dev`, then open http://localhost:5173.

Headless CLI:

```bash
npm run cli -- run ~/Movies/session.mp4 --game "GTA V" --count 20 --mode blur
npm run cli -- analyze <projectId>        # resume an interrupted analysis
npm run cli -- render <projectId> [--force]
npm run cli -- list
```

## Pipeline

```
Input → Ingest (hardlink/symlink/copy) → Metadata (ffprobe)
      → Frames + scene detection (chunked, checkpointed, 1 frame / 2 s @ 480 px)
      → Audio envelope + event detection (streamed PCM)
      → Timestamped contact sheets (4×5 tiles, each labelled "#NN H:MM:SS")
      → AI pass 1: broad discovery   (batches of 6 sheets per Claude request)
      → AI pass 2: detailed inspection (2 fps re-sampling of each promising window)
      → Pass 4: evidence fusion, ranking, dedupe, overlap resolution, boundary snapping
      → Render (blur / crop / smart crop) → FFprobe + full-decode validation → clips/
```

Pass 3 is audio. Its events, together with scene cuts and motion activity, go to Claude as *hints*. They are also used as supporting evidence when ranking, capped at 15% of the score, so a loud but boring moment can never be selected on audio alone.

Every stage writes its output to disk. Stages that already finished, along with finished extraction chunks, discovery batches and inspection windows, are reused when a job is resumed after a crash, a cancellation or a restart.

### How Claude is used

ClipHunter calls the installed CLI as a subprocess, never through a shell:

```
claude -p --input-format stream-json --output-format stream-json --verbose
       --tools "" --no-session-persistence --strict-mcp-config --safe-mode
       --permission-mode dontAsk --system-prompt <editor prompt>
       --json-schema <schema> --model <config.claude.model>
```

- Contact sheets go in as base64 image blocks on stdin. Claude never gets file-system or tool access.
- `--json-schema` enforces structured output. The application then validates every timestamp against the analysed range: small overshoots are clamped and invented times are rejected. If too many items are invalid, Claude is re-asked with a **corrective prompt** that lists the problems.
- Credentials: `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are removed from the child environment, so the CLI always uses your subscription login. Logs are redacted.
- Usage limits: the CLI's `rate_limit_event` messages are tracked. When a window is exhausted, or passes `claude.pauseAtUtilization`, new requests pause until the reset time. The UI shows this, and you can resume manually.
- Concurrency is bounded by `claude.maxConcurrent` (default 2). Each request has a timeout and transient failures are retried with backoff.

### Game-agnostic

If a project has no game set, pass 1 identifies the game from the frames and later passes use it. You can also set it per project ("Game" in the import form or settings). The editor prompt covers open-world games (crashes, stunts, chases, NPC chaos), shooters and battle royales (multi-kills, clutches, build fights, wins) and other genres.

## Output layout

```
projects/<project-id>/
  source/<video>                    hardlink/symlink to your file (or a copy)
  analysis/
    metadata.json scenes.json frames.json contact-sheets.json
    discovery.json candidates.json selected-clips.json
    contact-sheets/ frames/ audio/ discovery/ inspection/ detail/ previews/
  clips/clip-001.mp4 …              H.264 High, AAC 48 kHz, yuv420p, 1080×1920, faststart
  thumbnails/clip-001.jpg …
  logs/analysis.log rendering.log   structured JSON lines
  project.json
```

## Composition modes

- **blur** (default): the whole gameplay frame is centred over a blurred, slightly darkened copy that fills 9:16. Nothing is cropped away.
- **crop**: a full-screen 9:16 crop. `render.cropPositionX` sets the horizontal centre (0–1).
- **smart**: the crop pans to follow the action. It uses the focus points Claude reports in pass 2 (normalised x per timestamp) and confirms them against local motion saliency. Pan speed is capped and a dead-zone removes jitter. If tracking confidence falls below `render.smartCropMinConfidence`, the clip automatically falls back to **blur**, and this is recorded per clip.

## Audio

The original game audio is kept by default, with two-pass `loudnorm` to −14 LUFS, a volume setting, fade-in/out and a limiter that prevents clipping. Validation measures the output peak. Background music is optional (`audio.backgroundMusicPath`, only for music you have the rights to), mixed as a separate source with sidechain ducking under the game audio. No music is ever added automatically.

## Text

Optional intro and ending text, plus an optional AI title caption (`text.aiCaptions`, off by default). Style is configurable: font family, size, colour, outline and shadow. Subtitles are only produced when a local whisper.cpp model is configured **and** speech is detected. Non-speech tokens (music, noise) are dropped and no dialogue is ever invented.

## Configuration

All settings live in `cliphunter.config.json`, which lists the full defaults. Optional overlays are applied on top:
- `cliphunter.config.local.json` (git-ignored)
- the file named by the `CLIPHUNTER_CONFIG` environment variable
- per-project settings from the UI

Values are validated with Zod on load.

Key settings:

| Key | Default | Meaning |
|---|---|---|
| `claude.executable` / `claude.model` | `claude` / `sonnet` | CLI path and model alias (`opus`, `sonnet`, or a full model id) |
| `claude.maxConcurrent` | 2 | parallel `claude` processes |
| `analysis.frameIntervalSeconds` | 2 | pass-1 sampling |
| `analysis.analysisWidth` | 480 | analysis frame width |
| `analysis.contactSheetColumns` × `Rows` | 4 × 5 | 20 frames per sheet |
| `analysis.sheetsPerRequest` | 6 | sheets per discovery request (6 sheets = 4 minutes of footage) |
| `analysis.detailFps` | 2 | pass-2 sampling |
| `analysis.gameTitle` | "" | empty = auto-detect |
| `clips.count` | 20 | clips to select |
| `clips.min/preferredMin/preferredMax/maxDurationSeconds` | 10/15/35/60 | duration rules |
| `clips.minEntertainmentScore` | 6 | selection threshold; relaxed by up to 2 points only to reach the requested count, and marked in the notes |
| `render.width/height/fps/crf/preset` | 1080/1920/30/20/medium | output |
| `render.compositionMode` | blur | `blur` / `crop` / `smart` |
| `render.concurrency` | 2 | parallel FFmpeg renders |
| `storage.importMode` | link | `link` (hardlink, falling back to symlink) or `copy` |
| `storage.minFreeDiskGb` | 3 | heavy stages refuse to start below this |

## Reliability

- **Job queue**: persisted to `data/jobs.json`, with per-type concurrency and at most one job per project at a time. Supports cancel and retry.
- **Crash recovery**: jobs still marked `running` at start-up are re-queued and resume from their last checkpoint. Leftover temp files are cleaned up.
- **Graceful shutdown**: on SIGINT/SIGTERM, running jobs are interrupted and re-queued, child processes are terminated and logs are flushed.
- **Atomic writes**: all JSON is written to a temp file and renamed. Clips are rendered to a hidden temp file and only moved into `clips/` after validation passes.
- **Validation**: every clip is checked with FFprobe for duration (±0.25 s), resolution, H.264, yuv420p, frame rate, an AAC stream when one is expected, and a non-zero size. It is then fully decoded, and its audio peak is measured. A clip is never marked completed before validation passes.
- **Isolation**: a failed clip never affects completed clips. Unchanged clips are skipped on re-render, keyed on a hash of their settings and range.
- **Security**: subprocesses use argument arrays only. Import paths are limited to the home folder and `/Volumes` (configurable), project-relative paths are guarded against traversal, the server binds to 127.0.0.1 and rejects foreign `Host` headers.

## Tests

```bash
npm test                  # unit + integration (≈30 s)
npm run test:unit
npm run test:integration  # real FFmpeg; Claude is replaced by tests/fixtures/mock-claude.mjs
node scripts/ui-smoke.mjs http://127.0.0.1:4317 <projectId> /tmp   # browser smoke test (puppeteer-core + installed Chrome)
```

The mock CLI speaks the same stream-json protocol, which lets the tests cover corrective retries, authentication failures, process failures, concurrency limits and cancellation without using your Claude usage.

## Performance notes (Apple M4)

- Frame extraction and scene detection: about 11× realtime for 1080p60, so roughly 5–6 minutes per hour of footage, using VideoToolbox decoding with a software fallback.
- A one-hour video needs about 15 discovery requests plus 20–50 inspection requests.
- Rendering a 20-second clip takes 3–7 seconds with the `medium` preset.

## Acceptance test (real footage)

Run on 2026-11-16 on an Apple M4 (16 GB) using the default configuration (`claude.model = sonnet`, 2 s sampling, 20 clips, blur layout). Source: a public 72-minute GTA V story-mode session recording from the Internet Archive (`gta-5-08122023-2`). It is 1920×1080 at 59.94 fps, H.264/AAC and 3.34 GB, with streamer overlays. The game was **not** specified; it was auto-detected as "GTA V".

| Step | Result |
|---|---|
| 1. Import 1 h+ MP4 | ✅ hardlinked into the project (no copy) |
| 2. Metadata | ✅ 1:12:23, 1920×1080, 59.94 fps, h264 + aac |
| 3. Contact sheets | ✅ 2,172 frames → 109 sheets; frames + scenes + audio in about 5 min |
| 4. Claude CLI analysis | ✅ 64 requests through the logged-in CLI, 0 failures, about 7 s per discovery request |
| 5. ≥ 20 candidates | ✅ 25 pass-1 ranges → 25 inspected windows (2 rejected as cutscenes) → **21 candidates** |
| 6. Timestamp refinement | ✅ pass 2 at 2 fps; clips 10.7–35.8 s with the peak inside |
| 7–8. 20 clips at 1080×1920 | ✅ **20/20 rendered** (about 5½ min, concurrency 2) |
| 9. Validation | ✅ 20/20: h264/aac, yuv420p, 30 fps, duration within tolerance, full decode OK, peaks ≤ −0.2 dBFS |
| 10. Displayed in UI | ✅ 20/20 play in the browser (puppeteer check), no page errors |

The footage is mostly cutscenes and ordinary driving, so Claude's scores were honestly modest (4.5–6.8). The selection notes therefore record that 11 clips were picked below the default threshold of 6 to reach 20. Raise `clips.minEntertainmentScore`, or turn off backfill by lowering `clips.count`, if you only want the strongest moments.
