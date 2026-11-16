import { useState } from 'react';
import { api, type ProjectDetail } from './api';
import { toast, toastError } from './ui';

/** Per-project overrides of the global configuration. */
export function SettingsPanel({ project, onSaved }: { project: ProjectDetail; onSaved: () => void }) {
  const e = project.effectiveConfig;
  const [game, setGame] = useState(e.analysis.gameTitle);
  const [count, setCount] = useState(e.clips.count);
  const [minDur, setMinDur] = useState(e.clips.minDurationSeconds);
  const [maxDur, setMaxDur] = useState(e.clips.maxDurationSeconds);
  const [minScore, setMinScore] = useState(e.clips.minEntertainmentScore);
  const [mode, setMode] = useState(e.render.compositionMode);
  const [fps, setFps] = useState(e.render.fps);
  const [normalize, setNormalize] = useState(e.audio.normalize);
  const [volume, setVolume] = useState(e.audio.volume);
  const [music, setMusic] = useState(e.audio.backgroundMusicPath);
  const [intro, setIntro] = useState(e.text.introText);
  const [ending, setEnding] = useState(e.text.endingText);
  const [captions, setCaptions] = useState(e.text.aiCaptions);
  const [subs, setSubs] = useState(e.text.subtitles);
  const [spoken, setSpoken] = useState(e.text.spokenLanguage);
  const [subLangs, setSubLangs] = useState<string[]>(e.text.subtitleLanguages);
  const [hindiScript, setHindiScript] = useState(e.text.hindiScript);
  const toggleLang = (l: string) =>
    setSubLangs((cur) => {
      if (cur.includes(l)) return cur.length > 1 ? cur.filter((x) => x !== l) : cur;
      const next = [...cur.filter((x) => x !== 'original'), l];
      return next.slice(-2);
    });

  const save = async () => {
    try {
      await api.updateProject(project.id, {
        settings: {
          analysis: { gameTitle: game },
          clips: { count, minDurationSeconds: minDur, maxDurationSeconds: maxDur, minEntertainmentScore: minScore },
          render: { compositionMode: mode, fps },
          audio: { normalize, volume, backgroundMusicPath: music },
          text: { introText: intro, endingText: ending, aiCaptions: captions, subtitles: subs, spokenLanguage: spoken, subtitleLanguages: subLangs, hindiScript },
        },
      });
      toast('Settings saved. Changes to clip count/score apply on “Re-run selection”; render settings apply to the next render.', 'ok');
      onSaved();
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <section className="card settings">
      <h3>Analysis</h3>
      <div className="form-grid">
        <label><span>Game</span><input value={game} onChange={(x) => setGame(x.target.value)} placeholder="auto-detect" /></label>
      </div>
      <h3>Clip selection</h3>
      <div className="form-grid">
        <label><span>Number of clips</span><input type="number" min={1} max={500} value={count} onChange={(x) => setCount(Number(x.target.value))} /></label>
        <label><span>Min duration (s)</span><input type="number" min={3} value={minDur} onChange={(x) => setMinDur(Number(x.target.value))} /></label>
        <label><span>Max duration (s)</span><input type="number" min={5} value={maxDur} onChange={(x) => setMaxDur(Number(x.target.value))} /></label>
        <label><span>Min entertainment score</span><input type="number" min={0} max={10} step={0.5} value={minScore} onChange={(x) => setMinScore(Number(x.target.value))} /></label>
      </div>
      <h3>Rendering</h3>
      <div className="form-grid">
        <label>
          <span>Layout</span>
          <select value={mode} onChange={(x) => setMode(x.target.value as typeof mode)}>
            <option value="blur">Blurred background (whole frame)</option>
            <option value="crop">Full-screen center crop</option>
            <option value="smart">Smart crop (follows the action)</option>
          </select>
        </label>
        <label><span>Frame rate</span><select value={fps} onChange={(x) => setFps(Number(x.target.value))}>{[24, 30, 60].map((f) => <option key={f} value={f}>{f} fps</option>)}</select></label>
        <div className="small muted">Output: {e.render.width}×{e.render.height} H.264 + AAC, yuv420p, fast-start MP4.</div>
      </div>
      <h3>Audio</h3>
      <div className="form-grid">
        <label className="check"><input type="checkbox" checked={normalize} onChange={(x) => setNormalize(x.target.checked)} /> Normalize loudness (−14 LUFS)</label>
        <label><span>Game audio volume</span><input type="number" min={0} max={4} step={0.1} value={volume} onChange={(x) => setVolume(Number(x.target.value))} /></label>
        <label className="grow"><span>Background music file (optional — only use music you have rights to)</span><input value={music} onChange={(x) => setMusic(x.target.value)} placeholder="/path/to/royalty-free-track.mp3" /></label>
      </div>
      <h3>Text</h3>
      <div className="form-grid">
        <label><span>Intro text</span><input value={intro} onChange={(x) => setIntro(x.target.value)} placeholder="(none)" /></label>
        <label><span>Ending text</span><input value={ending} onChange={(x) => setEnding(x.target.value)} placeholder="(none)" /></label>
        <label className="check"><input type="checkbox" checked={captions} onChange={(x) => setCaptions(x.target.checked)} /> Show AI title caption</label>
      </div>
      <h3>Subtitles</h3>
      <div className="form-grid">
        <label className="check"><input type="checkbox" checked={subs} onChange={(x) => setSubs(x.target.checked)} /> Add subtitles when speech is detected (local whisper.cpp)</label>
        <label>
          <span>Spoken language</span>
          <select value={spoken} onChange={(x) => setSpoken(x.target.value)} disabled={!subs}>
            <option value="auto">Auto-detect (any language)</option>
            <option value="hi+en">Hindi + English (mixed / Hinglish)</option>
            <option value="en">English only</option>
            <option value="hi">Hindi only</option>
          </select>
        </label>
        <div className="lang-pick">
          <span className="small muted">Subtitle languages (max 2, shown top → bottom)</span>
          <div className="seg">
            {[['hi', 'Hindi'], ['en', 'English'], ['original', 'As spoken']].map(([code, label]) => (
              <button key={code} type="button" disabled={!subs} className={subLangs.includes(code!) ? 'active' : ''} onClick={() => (code === 'original' ? setSubLangs(['original']) : toggleLang(code!))}>
                {subLangs.includes(code!) ? `${subLangs.indexOf(code!) + 1}. ` : ''}{label}
              </button>
            ))}
          </div>
        </div>
        <label>
          <span>Hindi script</span>
          <select value={hindiScript} onChange={(x) => setHindiScript(x.target.value as typeof hindiScript)} disabled={!subs || !subLangs.includes('hi')}>
            <option value="devanagari">देवनागरी (Devanagari)</option>
            <option value="roman">Hinglish (Latin letters)</option>
          </select>
        </label>
        <div className="small muted">Speech is transcribed on this Mac; missing languages are translated with your Claude CLI. .srt caption files are saved with each clip.</div>
      </div>
      <div className="actions">
        <button className="btn primary" onClick={() => void save()}>Save settings</button>
      </div>
    </section>
  );
}
