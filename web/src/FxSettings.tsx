import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { api, urls, type FacecamRect, type FxSettings, type ProjectDetail, type SoundInfo } from './api';
import { toast, toastError } from './ui';

/** Fun-effects options (part of the project settings form). */
export function FunEffectsFields({ fx, onChange }: { fx: FxSettings; onChange: (fx: FxSettings) => void }) {
  const set = <K extends keyof FxSettings>(k: K, v: FxSettings[K]) => onChange({ ...fx, [k]: v });
  const box = (k: 'hookTitle' | 'replay' | 'zoom' | 'shake' | 'flash' | 'glitch' | 'sfx' | 'voice', label: string, hint: string) => (
    <label className="check" title={hint}>
      <input type="checkbox" checked={fx[k]} disabled={!fx.enabled} onChange={(e) => set(k, e.target.checked)} /> {label}
    </label>
  );
  return (
    <div className="form-grid">
      <label className="check"><input type="checkbox" checked={fx.enabled} onChange={(e) => set('enabled', e.target.checked)} /> <b>Add fun effects to clips</b></label>
      <label className="check" title="Claude watches each clip's story, dialogue and loud moments and places effects on the right frames"><input type="checkbox" checked={fx.auto} disabled={!fx.enabled} onChange={(e) => set('auto', e.target.checked)} /> AI picks the effects automatically</label>
      <label>
        <span>Intensity</span>
        <select value={fx.intensity} disabled={!fx.enabled} onChange={(e) => set('intensity', e.target.value as FxSettings['intensity'])}>
          <option value="subtle">Subtle (1–3 effects per clip)</option>
          <option value="normal">Normal (3–6)</option>
          <option value="crazy">Crazy (6–12)</option>
        </select>
      </label>
      <div className="fx-toggles">
        {box('hookTitle', 'Hook title', 'Short title in the first seconds')}
        {box('replay', 'Slow-mo replay', 'Instant replay of the best moment')}
        {box('zoom', 'Zoom punches', 'Quick zoom-in on impacts')}
        {box('shake', 'Camera shake', 'On explosions and crashes')}
        {box('flash', 'Impact flash', 'White flash on hits')}
        {box('glitch', 'Glitch', 'RGB glitch on weird moments')}
        {box('sfx', 'Sound effects', 'Boom, hit, whoosh… plus your own sounds')}
        {box('voice', 'Voice effects', 'Chipmunk / deep / echo / robot on funny lines')}
      </div>
      <label>
        <span>Replay speed</span>
        <select value={fx.replaySpeed} disabled={!fx.enabled || !fx.replay} onChange={(e) => set('replaySpeed', Number(e.target.value))}>
          <option value={0.5}>0.5× (half speed)</option>
          <option value={0.35}>0.35×</option>
          <option value={0.25}>0.25× (very slow)</option>
        </select>
      </label>
      <label>
        <span>Slow-mo smoothness</span>
        <select value={fx.replaySmoothing} disabled={!fx.enabled || !fx.replay} onChange={(e) => set('replaySmoothing', e.target.value as FxSettings['replaySmoothing'])}>
          <option value="blend">Blend frames (fast)</option>
          <option value="motion">Motion interpolation (smoothest, slower render)</option>
          <option value="none">None</option>
        </select>
      </label>
      <label>
        <span>Sound effect volume</span>
        <input type="range" min={0} max={2} step={0.1} value={fx.sfxVolume} disabled={!fx.enabled || !fx.sfx} onChange={(e) => set('sfxVolume', Number(e.target.value))} />
      </label>
      <label>
        <span>Facecam layout (webcam on top)</span>
        <select value={fx.facecam} disabled={!fx.enabled} onChange={(e) => set('facecam', e.target.value as FxSettings['facecam'])}>
          <option value="auto">Auto — when a webcam is detected</option>
          <option value="on">Always (uses the position below)</option>
          <option value="off">Off</option>
        </select>
      </label>
    </div>
  );
}

/** Show a frame of the recording and let the user drag a box onto the webcam overlay. */
export function FacecamEditor({ project, onSaved }: { project: ProjectDetail; onSaved: () => void }) {
  const md = project.metadata;
  const [rect, setRect] = useState<FacecamRect | null>(project.facecam?.rect ?? null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ mode: 'move' | 'resize'; x: number; y: number; r: FacecamRect } | null>(null);
  useEffect(() => setRect(project.facecam?.rect ?? null), [project.facecam?.checkedAt]);
  if (!md) return <p className="small muted">Available after the video is analyzed.</p>;
  const t = md.durationSeconds * 0.5;

  const onDown = (mode: 'move' | 'resize') => (e: RPointerEvent) => {
    if (!rect) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, x: e.clientX, y: e.clientY, r: rect };
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    const box = ref.current?.getBoundingClientRect();
    if (!d || !box) return;
    const dx = (e.clientX - d.x) / box.width;
    const dy = (e.clientY - d.y) / box.height;
    const r = d.r;
    if (d.mode === 'move') setRect({ ...r, x: Math.min(1 - r.w, Math.max(0, r.x + dx)), y: Math.min(1 - r.h, Math.max(0, r.y + dy)) });
    else setRect({ ...r, w: Math.min(1 - r.x, Math.max(0.05, r.w + dx)), h: Math.min(1 - r.y, Math.max(0.05, r.h + dy)) });
  };
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      toast(msg, 'ok');
      onSaved();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const status = project.facecam === undefined ? 'Not checked yet (checked automatically on the first render)' : project.facecam.rect ? `Webcam set (${project.facecam.source === 'auto' ? 'found by AI' : 'set by you'})` : 'No webcam in this recording';
  return (
    <div className="facecam-editor">
      <div className="small muted">{status}. Drag the box onto the webcam; drag the corner to resize.</div>
      <div className="facecam-frame" ref={ref} onPointerMove={onMove} onPointerUp={() => (drag.current = null)} style={{ aspectRatio: `${md.video.displayWidth} / ${md.video.displayHeight}` }}>
        <img src={urls.frame(project.id, t)} alt="" draggable={false} />
        {rect && (
          <div className="facecam-box" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }} onPointerDown={onDown('move')}>
            <span className="facecam-handle" onPointerDown={onDown('resize')} />
          </div>
        )}
      </div>
      <div className="row-actions">
        {!rect && <button className="btn small" onClick={() => setRect({ x: 0.7, y: 0.62, w: 0.26, h: 0.32 })}>Place a box</button>}
        <button className="btn small primary" disabled={busy || !rect} onClick={() => void run(() => api.updateProject(project.id, { facecam: rect }), 'Webcam position saved')}>Save position</button>
        <button className="btn small" disabled={busy} onClick={() => void run(() => api.updateProject(project.id, { facecam: null }).then(() => setRect(null)), 'Saved: no webcam')}>No webcam</button>
        <button className="btn small" disabled={busy} onClick={() => void run(() => api.detectFacecam(project.id), 'Webcam detection finished')}>{busy ? 'Working…' : '✨ Detect with AI'}</button>
      </div>
    </div>
  );
}

/** The sound-effects library: built-in sounds plus the user's uploads. */
export function SoundLibrary() {
  const [sounds, setSounds] = useState<SoundInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const load = () => api.sounds().then(setSounds).catch(toastError);
  useEffect(() => {
    void load();
  }, []);
  const play = (n: string) => {
    if (!audio.current) return;
    audio.current.src = urls.sound(n);
    void audio.current.play().catch(() => undefined);
  };
  const upload = async (f: File) => {
    setBusy(true);
    try {
      const r = await api.uploadSound(f);
      toast(`Added sound "${r.name}" — the AI can now use it`, 'ok');
      await load();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  };
  return (
    <div className="sound-lib">
      <audio ref={audio} hidden />
      <div className="small muted">Built-in sounds are original (no copyright issues). Add your own meme sounds — only ones you have the rights to use. The file name becomes the sound's name.</div>
      <div className="sound-grid">
        {sounds?.map((s) => (
          <div key={s.name} className="sound-chip" title={s.description}>
            <button className="icon-btn" onClick={() => play(s.name)} aria-label={`Play ${s.name}`}>▶</button>
            <span>{s.name}</span>
            {!s.builtin && <button className="icon-btn danger-text" title="Delete" onClick={() => confirm(`Delete sound "${s.name}"?`) && void api.deleteSound(s.name).then(load).catch(toastError)}>✕</button>}
          </div>
        ))}
      </div>
      <button className="btn small" disabled={busy} onClick={() => file.current?.click()}>{busy ? 'Uploading…' : '+ Add sound file'}</button>
      <input ref={file} type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
    </div>
  );
}
