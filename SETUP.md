# Setting up ClipHunter on another computer

A checklist for moving ClipHunter to a new machine, such as a Windows laptop with an NVIDIA RTX GPU. Steps for macOS and Linux are at the end.

---

## 1. What you need

| | Required? | Why |
|---|---|---|
| **Node.js 20.10 or newer** | Required | Runs the app |
| **Git** | Required | Gets the code from GitHub |
| **FFmpeg + FFprobe** | Required | All video and audio processing. On Windows, use a full build so NVIDIA NVENC GPU encoding works. |
| **Claude Code CLI**, logged in | Required | The AI that finds moments, plans effects and translates subtitles. It uses your Claude subscription, so no API key is needed. |
| **whisper.cpp + 2 model files** | For subtitles | Speech-to-text, running locally |
| **yt-dlp** | Optional | "Import from a link" (YouTube, Twitch, Kick…) |
| **gifski** | Optional | Better-quality GIFs (FFmpeg is used otherwise) |
| **Python 3.11 + Demucs** | Optional | Removes in-game radio music (copyright). About 3 GB with PyTorch. |

Disk space: keep at least **20–30 GB free**. Each 1-hour recording uses a few GB while it is analysed.

---

## 2. Get the code

```powershell
git clone https://github.com/johnroshan2255/Clip-Hunter.git
cd Clip-Hunter
```

> Make sure the latest changes are pushed to GitHub from the old computer first (`git push`). Otherwise the new machine gets an older version.

**Not in git** (copy these by hand if you need them):

| File / folder | What it is | On the new machine |
|---|---|---|
| `cliphunter.config.local.json` | Your local settings (tool paths, password hash, Wi-Fi sharing, subtitle languages) | The setup script creates a new one. Set the password again (step 5). |
| `projects/` | Your analysed videos and rendered clips | Copy it over only if you want your old projects. It can be large. |
| `sfx/` (your own sounds) | Meme sounds you uploaded | Copy the audio files into `sfx/` if you want them |
| `data/` | Job queue, logs, login secret | Don't copy it; it is created automatically |

---

## 3. Windows (recommended: automatic setup)

Open **PowerShell** in the `Clip-Hunter` folder and run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -OpenFirewall
```

Options:
- `-OpenFirewall`: lets friends on your Wi-Fi reach the app (asks for admin rights once).
- `-WithMusicRemoval`: also installs Python, PyTorch (CUDA) and Demucs, about 3 GB.
- `-SkipModels`: skips the 575 MB speech-model download (no subtitles).

The script:
1. installs Node.js, Git, FFmpeg (full build with NVENC) and yt-dlp with `winget`;
2. installs Claude Code;
3. downloads whisper.cpp (the CUDA build when an NVIDIA GPU is found) and the speech models into `%LOCALAPPDATA%\cliphunter`;
4. runs `npm install` and `npm run build`;
5. writes `cliphunter.config.local.json` with all tool paths and turns on Wi-Fi sharing;
6. runs `npm run doctor` to check everything.

You can run it again at any time; finished steps are skipped. If it says a command is still not found, **close PowerShell, open a new one** and run it again (Windows only picks up new programs in new windows).

### If the script fails: manual Windows setup

```powershell
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id Git.Git
winget install -e --id Gyan.FFmpeg
winget install -e --id yt-dlp.yt-dlp
irm https://claude.ai/install.ps1 | iex        # Claude Code (native installer)
```

Open a **new** PowerShell, then:

1. **whisper.cpp:** download the latest Windows release from https://github.com/ggml-org/whisper.cpp/releases (`whisper-cublas-…-bin-x64.zip` for NVIDIA, otherwise `whisper-bin-x64.zip`) and unzip it, for example to `C:\Tools\whisper`.
2. **Models:** download into `C:\Tools\whisper\models`:
   - https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin (~575 MB)
   - https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin (<1 MB)
3. **Build the app:**
   ```powershell
   npm install
   npm run build
   ```
4. **Create `cliphunter.config.local.json`** in the project folder. Use forward slashes `/` in the paths:
   ```json
   {
     "server": { "host": "0.0.0.0" },
     "text": {
       "subtitles": true,
       "spokenLanguage": "hi+en",
       "subtitleLanguages": ["hi", "en"],
       "hindiScript": "devanagari",
       "whisperExecutable": "C:/Tools/whisper/Release/whisper-cli.exe",
       "whisperModelPath": "C:/Tools/whisper/models/ggml-large-v3-turbo-q5_0.bin",
       "whisperVadModelPath": "C:/Tools/whisper/models/ggml-silero-v5.1.2.bin"
     }
   }
   ```
   Check where `whisper-cli.exe` actually is after unzipping; it may not be in a `Release` folder.

---

## 4. Log in to Claude (once)

```powershell
claude
```

Sign in with your Claude account in the browser window that opens, then type `/exit`. ClipHunter uses this login; you never need an API key.

---

## 5. Set a password for your friends

```powershell
npm run cli -- set-password            # prints a random password
npm run cli -- set-password mySecret   # or choose your own
```

The password is stored only as a hash in `cliphunter.config.local.json`. On this computer itself (localhost) no password is asked.

---

## 6. Check and start

```powershell
npm run doctor     # checks FFmpeg, Claude login, GPU encoder, whisper, yt-dlp, disk space…
npm start
```

What `doctor` should show on an RTX laptop:

```
OK   FFmpeg         ffmpeg version …
OK   Claude CLI     … authenticated
OK   Transcription  whisper.cpp available
OK   GPU encoding   NVIDIA NVENC
OK   Import links   yt-dlp …
```

`npm start` prints the link to share, for example `Shared on your network: http://192.168.1.x:4317`. Open it on any phone or PC on the same Wi-Fi.

**Tips for the laptop**
- Keep it **plugged in**, and set Windows power mode to **Best performance**.
- Stop it sleeping during long jobs: *Settings → System → Power → Screen and sleep → Never* while plugged in. If it does sleep, jobs resume where they stopped when the app restarts.
- The Wi-Fi IP can change. Check the link printed at start-up.
- If friends can't connect: make sure your Wi-Fi is set to a **Private** network in Windows, and that the firewall rule exists (run the setup script with `-OpenFirewall`).

---

## 7. Optional extras

**Remove in-game radio music (Demucs)**: either run the setup script with `-WithMusicRemoval`, or:
```powershell
winget install -e --id Python.Python.3.11
py -3.11 -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
py -3.11 -m pip install demucs soundfile
```
Then set the full path of `demucs.exe` (in Python's `Scripts` folder) in the local config:
`"audio": { "demucsExecutable": "C:/Users/<you>/AppData/Local/Programs/Python/Python311/Scripts/demucs.exe" }`.
Turn it on per project in *Settings → Audio → Remove in-game music*.

**Better GIFs:** install gifski from https://gif.ski and make sure `gifski` is on PATH.

**Your own sound effects:** put mp3/wav files in the `sfx/` folder, or upload them in *Settings → Sound effects library*. Only use sounds you have the rights to.

---

## 8. macOS / Linux

```bash
# macOS (Homebrew)
brew install node git ffmpeg whisper-cpp yt-dlp gifski
# Linux (Debian/Ubuntu)
sudo apt install nodejs npm git ffmpeg yt-dlp      # Node must be ≥ 20.10; whisper.cpp: build from source

curl -fsSL https://claude.ai/install.sh | bash     # Claude Code, then run `claude` and log in
mkdir -p ~/.cache/cliphunter/whisper && cd ~/.cache/cliphunter/whisper
curl -LO https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
curl -LO https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin
cd -   # back to the project folder
npm install && npm run build
```

Create `cliphunter.config.local.json` as in step 3 (with paths such as `/opt/homebrew/bin/whisper-cli` and `~/.cache/cliphunter/whisper/…` written out in full), then do steps 4–6.

---

## 9. Troubleshooting

| Problem | Fix |
|---|---|
| `doctor`: Claude CLI FAIL / not authenticated | Run `claude` and log in. If you installed Claude with npm and it still fails, use the native installer (`irm https://claude.ai/install.ps1 \| iex`). |
| GPU encoding: none found | Update the NVIDIA driver. Make sure FFmpeg is the full Gyan build (`ffmpeg -encoders` must list `h264_nvenc`). Rendering still works on the CPU, just slower. |
| Subtitles skipped | Check that `whisperExecutable` and `whisperModelPath` in `cliphunter.config.local.json` point to files that exist. |
| Hindi text shows as boxes | Windows ships *Nirmala UI*. On Linux, install `fonts-noto` (Noto Sans Devanagari). |
| Link import fails with a "sign in / bot" message | The site needs a login. Set `"download": { "cookiesFromBrowser": "chrome" }` (or `edge` / `firefox`) in the local config. Only do this for your own account and videos. |
| Friends get "Host not allowed" | Use the IP link printed at start-up, not a different name for the computer. |
| Low disk space errors | Delete old projects in the app, or free space. Heavy steps stop when less than 3 GB is free. |
