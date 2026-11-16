import { useEffect, useMemo, useRef, useState } from 'react';
import { api, urls, type Candidate, type ClipFx, type FxEvent, type FxEventType, type ProjectDetail, type SoundInfo, type VoiceEffect } from './api';
import { Modal, toast, toastError } from './ui';

const TYPE_LABEL: Record<FxEventType, string> = { zoom: 'Zoom punch', shake: 'Shake', flash: 'Flash', glitch: 'Glitch', sfx: 'Sound', voice: 'Voice' };
const TYPE_COLOR: Record<FxEventType, string> = { zoom: '#4ea1ff', shake: '#ff9f43', flash: '#ffffff', glitch: '#c56cf0', sfx: '#2ed573', voice: '#ff6b81' };
const DEFAULT_DURATION: Record<FxEventType, number> = { zoom: 0.9, shake: 0.6, flash: 0, glitch: 0.5, sfx: 0, voice: 2 };
const VOICES: VoiceEffect[] = ['chipmunk', 'deep', 'echo', 'robot'];
const LANG_NAME: Record<string, string> = { default: 'Hook title', en: 'English', hi: 'Hindi' };

/** Languages a hook is written in (one per subtitle reel). */
export function hookLangs(p: ProjectDetail): string[] {
  const t = p.effectiveConfig.text;
  if (!t.subtitles) return ['default'];
  const l = t.subtitleLanguages.filter((x) => x !== 'original');
  return l.length ? l : ['default'];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Edit a moment's fun effects. Times in the editor are relative to the clip
 * start; they are stored as absolute source times so trimming the clip keeps
 * effects on the right frames.
 */
export function FxEditor({ project, candidate, clipId, onClose, onSaved }: { project: ProjectDetail; candidate: Candidate; clipId?: string; onClose: () => void; onSaved: () => void }) {
  const start = candidate.start;
  const dur = candidate.end - candidate.start;
  const langs = useMemo(() => hookLangs(project), [project]);
  const [fx, setFx] = useState<Pick<ClipFx, 'hook' | 'replay' | 'events'>>(() => ({ hook: candidate.fx?.hook ?? {}, replay: candidate.fx?.replay ?? null, events: candidate.fx?.events ?? [] }));
  const [source, setSource] = useState<ClipFx['source'] | 'none'>(candidate.fx?.source ?? 'none');
  const [sounds, setSounds] = useState<SoundInfo[]>([]);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const enabled = project.effectiveConfig.fx.enabled;

  useEffect(() => {
    api.sounds().then(setSounds).catch(toastError);
  }, []);

  const rel = (abs: number) => r2(abs - start);
  const seek = (relT: number) => {
    if (video.current) video.current.currentTime = Math.max(0, Math.min(dur, relT));
  };
  const setEvents = (events: FxEvent[]) => setFx((f) => ({ ...f, events: [...events].sort((a, b) => a.t - b.t) }));
  const add = (type: FxEventType) => {
    if (fx.events.length >= 16) return toast('Max 16 effects per clip', 'error');
    const ev: FxEvent = { type, t: r2(start + now), duration: DEFAULT_DURATION[type], strength: 0.6 };
    if (type === 'sfx') ev.sound = sounds[0]?.name ?? 'boom';
    if (type === 'voice') ev.voice = 'chipmunk';
    setEvents([...fx.events, ev]);
  };
  const update = (i: number, patch: Partial<FxEvent>) => setEvents(fx.events.map((e, k) => (k === i ? { ...e, ...patch } : e)));
  const remove = (i: number) => setEvents(fx.events.filter((_, k) => k !== i));
  const play = (name: string) => {
    if (!audio.current) return;
    audio.current.src = urls.sound(name);
    void audio.current.play().catch(() => undefined);
  };

  const save = async (render: boolean) => {
    setBusy(true);
    try {
      const hook = Object.fromEntries(Object.entries(fx.hook ?? {}).filter(([, v]) => v.trim()));
      await api.saveFx(project.id, candidate.id, { hook, replay: fx.replay, events: fx.events });
      setSource('manual');
      if (render && clipId) {
        await api.render(project.id, { clipIds: [clipId] });
        toast(`Saved — re-rendering ${clipId}`, 'ok');
      } else toast(render ? 'Saved. Render the clip to see the effects.' : 'Effects saved', 'ok');
      onSaved();
      if (render) onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const planWithAi = async () => {
    setBusy(true);
    try {
      const plan = await api.planFx(project.id, candidate.id);
      setFx({ hook: plan.hook ?? {}, replay: plan.replay ?? null, events: plan.events });
      setSource('auto');
      toast('AI planned new effects (already saved). Tweak them or render.', 'ok');
      onSaved();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const resetAuto = async () => {
    setBusy(true);
    try {
      await api.resetFx(project.id, candidate.id);
      setFx({ hook: {}, replay: null, events: [] });
      setSource('none');
      toast('Back to automatic: the AI will plan effects on the next render', 'ok');
      onSaved();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const replay = fx.replay;
  return (
    <Modal title={`Effects · ${candidate.title}`} onClose={onClose} wide>
      <audio ref={audio} hidden />
      {!enabled && <div className="alert warn">Fun effects are turned off for this project (Settings → Fun effects). Your edits are kept but not rendered.</div>}
      <div className="fx-editor">
        <div className="fx-player">
          <video ref={video} src={urls.preview(project.id, candidate.id, candidate.start, candidate.end)} controls preload="metadata" playsInline onTimeUpdate={(e) => setNow(r2((e.target as HTMLVideoElement).currentTime))} />
          <div className="fx-timeline" onClick={(e) => {
            const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
            seek(((e.clientX - r.left) / r.width) * dur);
          }}>
            {replay && <div className="fx-replay" style={{ left: `${(rel(replay.start) / dur) * 100}%`, width: `${((replay.end - replay.start) / dur) * 100}%` }} title="Instant replay" />}
            {fx.events.map((e, i) => (
              <span key={i} className="fx-mark" title={`${TYPE_LABEL[e.type]} @ ${rel(e.t)}s`} style={{ left: `${(rel(e.t) / dur) * 100}%`, background: TYPE_COLOR[e.type] }} />
            ))}
            <span className="fx-now" style={{ left: `${(now / dur) * 100}%` }} />
          </div>
          <div className="small muted">At <b>{now.toFixed(1)}s</b> of {dur.toFixed(1)}s — pause where you want an effect, then add it:</div>
          <div className="fx-add">
            {(['zoom', 'shake', 'flash', 'glitch', 'sfx', 'voice'] as FxEventType[]).map((t) => (
              <button key={t} className="btn small" onClick={() => add(t)} style={{ borderColor: TYPE_COLOR[t] }}>+ {TYPE_LABEL[t]}</button>
            ))}
          </div>
        </div>

        <div className="fx-side">
          <div className="fx-source small">
            {source === 'manual' ? <span className="tag">edited by you</span> : source === 'auto' ? <span className="tag">planned by AI</span> : <span className="tag">automatic (AI plans on render)</span>}
          </div>
          <h4>Hook title</h4>
          {langs.map((l) => (
            <label key={l} className="fx-field">
              <span>{LANG_NAME[l] ?? l.toUpperCase()}</span>
              <input value={fx.hook?.[l] ?? ''} maxLength={80} placeholder="e.g. He did NOT see that coming" onChange={(e) => setFx((f) => ({ ...f, hook: { ...(f.hook ?? {}), [l]: e.target.value } }))} />
            </label>
          ))}
          <h4>Instant replay (slow motion)</h4>
          <label className="check">
            <input type="checkbox" checked={!!replay} onChange={(e) => setFx((f) => ({ ...f, replay: e.target.checked ? { start: r2(start + Math.max(0, now - 2)), end: r2(start + Math.min(dur, Math.max(now, 0.8))) } : null }))} /> Replay this part after it happens
          </label>
          {replay && (
            <div className="fx-row">
              <label className="fx-field"><span>from (s)</span><input type="number" step={0.1} min={0} max={dur} value={rel(replay.start)} onChange={(e) => setFx((f) => ({ ...f, replay: { ...f.replay!, start: r2(start + Number(e.target.value)) } }))} /></label>
              <label className="fx-field"><span>to (s)</span><input type="number" step={0.1} min={0} max={dur} value={rel(replay.end)} onChange={(e) => setFx((f) => ({ ...f, replay: { ...f.replay!, end: r2(start + Number(e.target.value)) } }))} /></label>
              <button className="btn small" title="Set the end to the current video time" onClick={() => setFx((f) => ({ ...f, replay: { start: Math.min(f.replay!.start, r2(start + now - 0.6)), end: r2(start + now) } }))}>end = now</button>
            </div>
          )}
          <h4>Effects ({fx.events.length})</h4>
          {!fx.events.length && <p className="small muted">No effects yet. Use the buttons under the video, or let the AI plan them.</p>}
          <div className="fx-list">
            {fx.events.map((e, i) => (
              <div key={i} className="fx-item" style={{ borderLeftColor: TYPE_COLOR[e.type] }}>
                <button className="link small" title="Jump to this moment" onClick={() => seek(rel(e.t))}>{rel(e.t).toFixed(1)}s</button>
                <b>{TYPE_LABEL[e.type]}</b>
                {e.type === 'sfx' && (
                  <>
                    <select value={e.sound} onChange={(x) => update(i, { sound: x.target.value })}>
                      {sounds.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                      {e.sound && !sounds.some((s) => s.name === e.sound) && <option value={e.sound}>{e.sound} (missing)</option>}
                    </select>
                    <button className="icon-btn" title="Listen" onClick={() => e.sound && play(e.sound)}>▶</button>
                  </>
                )}
                {e.type === 'voice' && (
                  <select value={e.voice} onChange={(x) => update(i, { voice: x.target.value as VoiceEffect })}>
                    {VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                )}
                {DEFAULT_DURATION[e.type] > 0 && (
                  <label className="inline small" title="Duration (s)">
                    <input type="number" step={0.1} min={0.1} max={8} value={e.duration} onChange={(x) => update(i, { duration: Number(x.target.value) })} />s
                  </label>
                )}
                {e.type !== 'sfx' && e.type !== 'voice' && (
                  <input type="range" min={0.1} max={1} step={0.1} value={e.strength ?? 0.6} title={`Strength ${e.strength ?? 0.6}`} onChange={(x) => update(i, { strength: Number(x.target.value) })} />
                )}
                <button className="btn small" title="Move to the current video time" onClick={() => update(i, { t: r2(start + now) })}>⌖ now</button>
                <button className="icon-btn danger-text" title="Remove" onClick={() => remove(i)}>✕</button>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="actions fx-actions">
        <button className="btn" disabled={busy} onClick={() => void planWithAi()} title="Ask Claude to plan hook, replay and effects for this moment">✨ Plan with AI</button>
        <button className="btn ghost" disabled={busy || source === 'none'} onClick={() => void resetAuto()} title="Forget edits; the AI plans this clip again on the next render">Reset to automatic</button>
        <span className="spacer" />
        <button className="btn" disabled={busy} onClick={() => void save(false)}>Save</button>
        {clipId && <button className="btn primary" disabled={busy} onClick={() => void save(true)}>Save & re-render</button>}
      </div>
    </Modal>
  );
}
