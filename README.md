# ClipHunter

Local, AI-assisted clipping for long gameplay recordings. ClipHunter analyses 1–3 hour sessions from **any game** (GTA V / GTA VI, Fortnite, Warzone, Apex, racing games…), finds the entertaining moments with your **existing Claude Code CLI login**, and renders validated **1080×1920** clips for Instagram Reels, YouTube Shorts and TikTok.

- No Anthropic API key, no paid APIs. AI analysis runs through the `claude` CLI you are already logged into.
- All video and audio processing is done locally with FFmpeg/FFprobe.
- A web UI is included for reviewing moments, editing timestamps, rendering, previewing and exporting.

## Requirements

| Tool | Notes |
|---|---|
| Node.js ≥ 20.10 | |
| FFmpeg + FFprobe | Needs `libx264`. `drawtext`/`libass` are **not** required; text is rendered as PNG overlays. GPU encoders (NVENC, VideoToolbox, Quick Sync, AMF) are used automatically when present. |
| Claude Code CLI | Installed and logged in (`claude` in a terminal, then `/login`). |
| whisper.cpp (optional) | Only needed for subtitles. Set `text.whisperExecutable` and `text.whisperModelPath`. |
| yt-dlp (optional) | Import a recording from a link (your own YouTube/Twitch/Kick VODs). |
| gifski (optional) | Higher-quality GIF export (FFmpeg is used otherwise). |
| Demucs (optional) | Removes in-game music (e.g. GTA radio) that causes copyright claims. `pip install demucs`. |

Runs on **macOS, Windows and Linux**. `npm run doctor` shows what is available.

## Windows laptop / NVIDIA GPU setup

> Setting up on a new computer? See **[SETUP.md](SETUP.md)** for the full checklist.

From the ClipHunter folder, in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -OpenFirewall
# add -WithMusicRemoval to also install Demucs + PyTorch (CUDA), ~3 GB
```

The script installs Node.js, Git, FFmpeg (full build with NVENC) and yt-dlp with `winget`; installs Claude Code; downloads whisper.cpp (the CUDA build on NVIDIA) and the speech models; builds the app; and writes `cliphunter.config.local.json` with the tool paths. Then:

1. Run `claude` once and sign in.
2. `npm run cli -- set-password` (for friends on your Wi-Fi).
3. `npm start`. The share link for your Wi-Fi is printed at start-up.

On an RTX laptop, clips are encoded with **NVENC** (several times faster than the CPU), video decoding uses the GPU (`-hwaccel auto`), and whisper.cpp runs on CUDA. If the GPU encoder fails, that clip is re-encoded on the CPU automatically. npm-installed CLIs (`claude.cmd`) are launched through Node directly, so no shell is ever used. Keep the laptop plugged in and stop it from sleeping during long jobs.

## Quick start

```bash
npm install
npm run doctor          # checks FFmpeg, FFprobe, the Claude CLI version and login, and free disk space
npm run build
npm start               # http://127.0.0.1:4317
```

**Share on your local network:** create `cliphunter.config.local.json` with `{ "server": { "host": "0.0.0.0" } }` and restart. On startup the server logs the addresses it is shared on, e.g. `http://192.168.1.x:4317`. Requests are accepted for this machine's own IPs and `<hostname>.local`; any other `Host` header is rejected.

**Password protection** (recommended when sharing):

```bash
npm run cli -- set-password                 # generates a memorable password and prints it
npm run cli -- set-password "my secret"     # or choose your own (8+ characters)
npm run cli -- remove-password
```

Then restart the server. How it works:
- Only a salted scrypt hash is stored, in the git-ignored `cliphunter.config.local.json`.
- Logging in sets an HttpOnly, SameSite=Lax session cookie that lasts 30 days. Changing the password logs everyone out.
- After 5 wrong attempts from the same device, that device is locked out, with longer lockouts for repeated failures.
- Requests from this computer (localhost) skip the password unless `server.requirePasswordOnLocalhost` is `true`.
- Everything except `/api/health` and the login endpoints needs a session, including clip video and downloads.

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

Optional intro and ending text, plus an optional AI title caption (`text.aiCaptions`, off by default). Style is configurable: font family, size, colour, outline and shadow. Fonts that can render Devanagari are picked automatically for Hindi.

## Fun effects (automatic + manual)

Every clip can get reel-style edits. With **AI picks the effects** on (default), Claude plans each clip during rendering. It works from the moment's description, the transcript, the loud audio onsets and the list of available sounds, and puts each effect on the right frame:

| Effect | What it does |
|---|---|
| Hook title | Short title in a yellow box that slides in for the first ~3 s. One per reel language (a Hindi hook on the Hindi reel). |
| Instant replay | The payoff replayed in slow motion (0.5× default) right after it happens, zoomed in, with a REPLAY badge and a whoosh. 60 fps sources use real frames; otherwise frames are blended (or motion-interpolated). |
| Zoom punch / shake / flash / glitch | Quick zoom-ins, camera shake, white impact flash, RGB-split glitch. |
| Sound effects | Built-in original sounds (boom, hit, whoosh, riser, ding, glitch, bass-drop, airhorn, pop), synthesised locally, so there are no copyright issues. Add your own in **Settings → Sound effects library** or the `sfx/` folder. |
| Voice effects | chipmunk, deep, echo or robot on a funny line. |
| Word-by-word captions | 1–4 words at a time with the spoken word highlighted (`text.captionStyle: karaoke`). |
| Facecam layout | If the recording has a webcam overlay (detected by Claude once per project, or placed by hand), the reel shows the webcam on top and the gameplay below. The gameplay crop moves so the webcam isn't shown twice. |

**Manual editing:** the **✨ Effects** button (Clips tab, or ✨ in the Moments tab) opens an editor. It has a preview, a timeline of the effects, buttons to add an effect at the current video time, and fields for the hook, the replay range, sounds, voices, durations and strengths. **Plan with AI** re-plans one clip, and **Reset to automatic** discards your edits. Edited plans are never overwritten by the AI. Automatic plans are re-made when you change effect settings (intensity, enabled effects, languages).

**Settings → Fun effects:** a master switch, AI on/off, intensity (subtle / normal / crazy), each effect type, replay speed and smoothness, sound volume, and facecam (auto / always / off).

Other extras:
- **Montage** (Clips tab → 🎬 Make montage): joins chosen clips with transitions. Vertical montages reuse the finished reels (effects and subtitles included). Horizontal 16:9 montages are cut from the original gameplay for YouTube.
- **GIF** button: a GIF of each reel's best seconds (the replay, or around the peak), 480 px wide, ≤ 8 s.
- **Import from a link** (dashboard): downloads a video with yt-dlp, then analyses it automatically. Only public http(s) links are accepted; browser cookies are never read unless you set `download.cookiesFromBrowser`.
- **Mic noise removal** (`audio.denoise`) and **in-game music removal** (`audio.musicRemoval`, Demucs). "reduce" keeps voices and turns everything else down; "voices" keeps only the voices.

## Subtitles (English, Hindi and more)

Speech is transcribed **locally** with whisper.cpp; nothing is uploaded. Lines that aren't already in a target language are translated with your Claude CLI, keeping whisper's timing. Transcription and translation run once per clip.

**Subtitle reels** (Settings → Subtitles, or `text.subtitleLanguages` + `text.subtitleMode`):

| Option | Config | Output per clip |
|---|---|---|
| Hindi + English | `["hi","en"]`, `separate` | `clip-001-hi.mp4` and `clip-001-en.mp4`, two reels |
| English only | `["en"]` | `clip-001-en.mp4` |
| Hindi only | `["hi"]` | `clip-001-hi.mp4` |
| Both in one reel | `["hi","en"]`, `stacked` | `clip-001.mp4` (Hindi on top, English below) |
| As spoken | `["original"]` | `clip-001-<lang>.mp4`, no translation |

- Every reel is validated before any reel of that clip replaces the previous output.
- Each clip also gets `.srt` caption files (`clip-001.hi.srt`, `clip-001.en.srt`) for uploading as platform captions.
- A clip with no detected speech gets a single `clip-001.mp4` without subtitles.
- The UI has per-language tabs and downloads, and the zip and folder exports include every reel.

Setup (macOS):

```bash
brew install whisper-cpp
mkdir -p ~/.cache/cliphunter/whisper && cd ~/.cache/cliphunter/whisper
curl -LO https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin   # multilingual, ~574 MB
curl -LO https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin          # voice activity detection, <1 MB
```

`cliphunter.config.local.json`:

```json
{ "text": {
    "subtitles": true,
    "spokenLanguage": "hi+en",
    "subtitleLanguages": ["hi", "en"],
    "hindiScript": "devanagari",
    "whisperExecutable": "/opt/homebrew/bin/whisper-cli",
    "whisperModelPath": "~/.cache/cliphunter/whisper/ggml-large-v3-turbo-q5_0.bin",
    "whisperVadModelPath": "~/.cache/cliphunter/whisper/ggml-silero-v5.1.2.bin"
} }
```

(Use absolute paths. These can also be set per project under Settings → Subtitles.)

- `spokenLanguage`: one of
  - `auto`: any language.
  - `en` or `hi`: forced.
  - `hi+en`: for Hinglish streams. Detection is limited to those languages, which fixes whisper's common Hindi→Urdu confusion.
- `subtitleLanguages`: one or two of `hi`, `en`, any ISO code, or `original` (as spoken). They are listed top to bottom.
- `hindiScript`: `devanagari` (हिंदी) or `roman` (Hinglish, "bhai ye dekho").
- **Mixed-language clips:** the voice activity detector splits speech into utterances, and the language is detected per utterance. Short shouts take the language of the clip's longer speech, because whisper's detection on 1–2 second clips is unreliable.
- **Accuracy safeguards:**
  - Whisper's known silence hallucinations ("thanks for watching") and low-confidence segments are dropped.
  - Clips with no speech get no subtitles.
  - The translator is told never to add content, and translations are validated: one output line per input line, and Devanagari when requested.

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
node scripts/ui-fx-check.mjs http://127.0.0.1:4317 <projectId> <clipId> /tmp   # effects editor, montage dialog, settings
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
