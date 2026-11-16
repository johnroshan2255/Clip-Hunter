<#
  ClipHunter setup for Windows 10/11 (NVIDIA RTX laptops and desktops).

  Run from the ClipHunter folder in PowerShell:
      powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
  Options:
      -WithMusicRemoval   also install Demucs (+ PyTorch with CUDA, ~3 GB) to remove in-game radio music
      -SkipModels         don't download the speech-recognition models (~575 MB)
      -OpenFirewall       allow friends on your Wi-Fi to reach port 4317 (asks for admin rights)

  Installs (with winget): Node.js LTS, Git, FFmpeg (full build with NVIDIA NVENC), yt-dlp.
  Downloads: whisper.cpp (CUDA build when an NVIDIA GPU is present) + models.
  Then: npm install, build, and writes cliphunter.config.local.json with the tool paths.
  Safe to run again: finished steps are skipped.
#>
param(
  [switch]$WithMusicRemoval,
  [switch]$SkipModels,
  [switch]$OpenFirewall
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # makes Invoke-WebRequest much faster
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Tools = Join-Path $env:LOCALAPPDATA 'cliphunter'
New-Item -ItemType Directory -Force -Path $Tools | Out-Null

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "   OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "   !!  $msg" -ForegroundColor Yellow }
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Winget-Install($id, $cmd) {
  if ($cmd -and (Have $cmd)) { Ok "$id already installed"; return }
  if (-not (Have 'winget')) { throw 'winget is missing. Install "App Installer" from the Microsoft Store, then run this script again.' }
  Write-Host "   installing $id ..."
  winget install --id $id -e --accept-source-agreements --accept-package-agreements --silent | Out-Host
  Refresh-Path
}

# ── 1. Base tools ──
Step 'Node.js, Git, FFmpeg, yt-dlp'
Winget-Install 'OpenJS.NodeJS.LTS' 'node'
Winget-Install 'Git.Git' 'git'
Winget-Install 'Gyan.FFmpeg' 'ffmpeg'
Winget-Install 'yt-dlp.yt-dlp' 'yt-dlp'
Refresh-Path
foreach ($c in 'node', 'npm', 'ffmpeg', 'ffprobe') {
  if (-not (Have $c)) { throw "$c is still not on PATH. Close this window, open a new PowerShell and run the script again." }
}
Ok ("node " + (node --version))
$nvidia = $false
try { $nvidia = [bool](Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'NVIDIA' }) } catch {}
if ($nvidia) {
  $enc = (ffmpeg -hide_banner -encoders 2>$null | Select-String 'h264_nvenc')
  if ($enc) { Ok 'NVIDIA GPU found; FFmpeg has NVENC (fast GPU rendering)' } else { Warn 'NVIDIA GPU found but this FFmpeg has no NVENC; rendering will use the CPU' }
} else { Warn 'No NVIDIA GPU detected; rendering will use another GPU encoder if available, else the CPU' }

# ── 2. Claude Code CLI (uses your Claude subscription; no API key) ──
Step 'Claude Code CLI'
if (Have 'claude') { Ok ("claude " + (claude --version)) }
else {
  Write-Host '   installing Claude Code (native installer) ...'
  Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
  Refresh-Path
  $local = Join-Path $env:USERPROFILE '.local\bin'
  if (Test-Path (Join-Path $local 'claude.exe')) { $env:Path += ";$local" }
  if (Have 'claude') { Ok 'Claude Code installed' } else { Warn 'Claude Code installed; open a new terminal if "claude" is not found' }
}
Warn 'If you have not logged in yet: run  claude  once in a terminal and sign in with your Claude account.'

# ── 3. whisper.cpp (speech-to-text for subtitles) ──
Step 'whisper.cpp (subtitles)'
$whisperDir = Join-Path $Tools 'whisper'
$whisperCli = Get-ChildItem -Path $whisperDir -Recurse -Filter 'whisper-cli.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $whisperCli) {
  $rel = Invoke-RestMethod 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest' -Headers @{ 'User-Agent' = 'cliphunter-setup' }
  $assets = $rel.assets | Where-Object { $_.name -match 'x64\.zip$' }
  $asset = $null
  if ($nvidia) { $asset = $assets | Where-Object { $_.name -match 'cublas' } | Sort-Object name -Descending | Select-Object -First 1 }
  if (-not $asset) { $asset = $assets | Where-Object { $_.name -match '^whisper-bin-x64\.zip$' } | Select-Object -First 1 }
  if (-not $asset) { throw 'Could not find a Windows build of whisper.cpp in the latest release.' }
  Write-Host "   downloading $($asset.name) ($([math]::Round($asset.size / 1MB)) MB) ..."
  $zip = Join-Path $Tools $asset.name
  Invoke-WebRequest $asset.browser_download_url -OutFile $zip
  New-Item -ItemType Directory -Force -Path $whisperDir | Out-Null
  Expand-Archive -Path $zip -DestinationPath $whisperDir -Force
  Remove-Item $zip
  $whisperCli = Get-ChildItem -Path $whisperDir -Recurse -Filter 'whisper-cli.exe' | Select-Object -First 1
}
if (-not $whisperCli) { throw 'whisper-cli.exe not found after extracting whisper.cpp' }
Ok $whisperCli.FullName

$modelDir = Join-Path $Tools 'models'
New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
$model = Join-Path $modelDir 'ggml-large-v3-turbo-q5_0.bin'
$vad = Join-Path $modelDir 'ggml-silero-v5.1.2.bin'
if (-not $SkipModels) {
  if (-not (Test-Path $model)) {
    Write-Host '   downloading speech model (~575 MB) ...'
    Invoke-WebRequest 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin' -OutFile "$model.part"
    Move-Item "$model.part" $model
  }
  if (-not (Test-Path $vad)) {
    Invoke-WebRequest 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin' -OutFile $vad
  }
  Ok 'models ready'
}

# ── 4. Optional: Demucs (remove in-game music) ──
$demucsExe = $null
if ($WithMusicRemoval) {
  Step 'Demucs (music removal, PyTorch + CUDA)'
  if (-not (Have 'py')) { Winget-Install 'Python.Python.3.11' 'py' }
  Refresh-Path
  $torchIndex = if ($nvidia) { 'https://download.pytorch.org/whl/cu124' } else { 'https://download.pytorch.org/whl/cpu' }
  py -3.11 -m pip install --upgrade pip | Out-Host
  py -3.11 -m pip install torch torchaudio --index-url $torchIndex | Out-Host
  py -3.11 -m pip install demucs soundfile | Out-Host
  $scripts = (py -3.11 -c "import sysconfig; print(sysconfig.get_path('scripts'))").Trim()
  $demucsExe = Join-Path $scripts 'demucs.exe'
  if (Test-Path $demucsExe) { Ok $demucsExe } else { Warn 'demucs.exe not found; music removal stays off'; $demucsExe = $null }
}

# ── 5. App ──
Step 'Install and build ClipHunter'
npm install | Out-Host
npm run build | Out-Host
Ok 'built'

Step 'Write cliphunter.config.local.json'
$cfgFile = Join-Path $Root 'cliphunter.config.local.json'
$cfg = if (Test-Path $cfgFile) { Get-Content $cfgFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
function Section($name) {
  if (-not ($cfg.PSObject.Properties.Name -contains $name)) { $cfg | Add-Member -NotePropertyName $name -NotePropertyValue ([pscustomobject]@{}) }
  return $cfg.$name
}
function SetKey($obj, $key, $value) {
  if ($obj.PSObject.Properties.Name -contains $key) { $obj.$key = $value } else { $obj | Add-Member -NotePropertyName $key -NotePropertyValue $value }
}
$text = Section 'text'
SetKey $text 'whisperExecutable' $whisperCli.FullName
if (Test-Path $model) { SetKey $text 'whisperModelPath' $model; SetKey $text 'subtitles' $true }
if (Test-Path $vad) { SetKey $text 'whisperVadModelPath' $vad }
$server = Section 'server'
if (-not ($server.PSObject.Properties.Name -contains 'host')) { SetKey $server 'host' '0.0.0.0' }
if ($demucsExe) { SetKey (Section 'audio') 'demucsExecutable' $demucsExe }
$cfg | ConvertTo-Json -Depth 10 | Set-Content -Path $cfgFile -Encoding UTF8
Ok $cfgFile

if ($OpenFirewall) {
  Step 'Windows Firewall (port 4317, private networks)'
  $rule = 'ClipHunter 4317'
  $cmd = "if (-not (Get-NetFirewallRule -DisplayName '$rule' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName '$rule' -Direction Inbound -Protocol TCP -LocalPort 4317 -Action Allow -Profile Private | Out-Null }"
  Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile', '-Command', $cmd
  Ok 'firewall rule added (private networks only)'
}

Step 'Check'
npm run doctor | Out-Host
Write-Host "`nDone. Next steps:" -ForegroundColor Cyan
Write-Host '  1. If you have not yet: run  claude  and log in.'
Write-Host '  2. Set a password for your friends:  npm run cli -- set-password'
Write-Host '  3. Start:  npm start   (the share link for your Wi-Fi is printed when it starts)'
Write-Host '     Keep the laptop plugged in and stop it from sleeping during long jobs.'
