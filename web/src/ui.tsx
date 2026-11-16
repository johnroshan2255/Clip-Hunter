import { useEffect, useState, type ReactNode } from 'react';

type Toast = { id: number; kind: 'ok' | 'error' | 'info'; text: string };
let push: ((t: Omit<Toast, 'id'>) => void) | null = null;

export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  push?.({ text, kind });
}

export function toastError(err: unknown): void {
  toast(err instanceof Error ? err.message : String(err), 'error');
}

export function ToastHost() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    let n = 0;
    push = (t) => {
      const id = ++n;
      setItems((xs) => [...xs, { ...t, id }]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.kind === 'error' ? 8000 : 4000);
    };
    return () => {
      push = null;
    };
  }, []);
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>
      ))}
    </div>
  );
}

export function ProgressBar({ value, tone }: { value: number; tone?: 'ok' | 'warn' | 'danger' }) {
  return (
    <div className="progress">
      <div className={`progress-fill ${tone ?? ''}`} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal ${wide ? 'wide' : ''}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  completed: 'ok',
  analyzed: 'ok',
  done: 'ok',
  running: 'info',
  analyzing: 'info',
  rendering: 'info',
  validating: 'info',
  queued: 'muted',
  pending: 'muted',
  created: 'muted',
  skipped: 'muted',
  failed: 'danger',
  cancelled: 'warn',
};

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill ${STATUS_TONE[status] ?? 'muted'}`}>{status}</span>;
}

export function ScoreBadge({ score }: { score: number }) {
  const tone = score >= 8 ? 'ok' : score >= 6 ? 'info' : score >= 4 ? 'warn' : 'danger';
  return <span className={`score ${tone}`}>{score.toFixed(1)}</span>;
}
