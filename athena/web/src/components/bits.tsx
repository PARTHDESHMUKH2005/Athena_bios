import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { paint } from '../lib/art';
import type { TraceStep } from '../lib/types';
import { ms } from '../lib/format';

export function Art({ kind, className }: { kind: 'terrain' | 'streaks'; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) paint(ref.current, kind);
  }, [kind]);
  return <canvas ref={ref} className={className} aria-hidden="true" />;
}

export function Mark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M5 25 L16 6 L27 25 M10 19 H22" fill="none" stroke="currentColor" strokeWidth="2.6" />
    </svg>
  );
}

export function Logo({ to = '/' }: { to?: string }) {
  return (
    <Link className="logo" to={to} aria-label="Athena home">
      <Mark />
      Athena
    </Link>
  );
}

export const Chev = () => <span className="chev" aria-hidden="true" />;

export function Tag({ children }: { children: ReactNode }) {
  return <span className="tag">{children}</span>;
}

const ICON: Record<string, [string, string]> = {
  context: ['#2a7de1', '⌕'],
  tier: ['#7a4fe0', '⑂'],
  reserve: ['#e08a00', '◐'],
  call: ['#12a37f', '↗'],
  verify: ['#3fa7e8', '✓'],
  escalate: ['#7a4fe0', '↑'],
  scan: ['#2a7de1', '◉'],
  pause: ['#f26b3a', 'Ⅱ'],
  error: ['#b3261e', '!'],
  done: ['#1d7a4b', '✓'],
};

/** One activity card (the Manus-style step). `live` marks the step in progress. */
export function StepCard({ step, live }: { step: TraceStep; live?: boolean }) {
  const [bg, glyph] = ICON[step.step] ?? ['#888', '•'];
  const word = live ? 'Working' : step.step === 'error' ? 'Stopped' : step.step === 'pause' ? 'Paused' : 'Done';
  return (
    <div className="step">
      <div className="step__top">
        <span className="step__ic" style={{ background: bg }}>{glyph}</span>
        {step.label}
        <span className={live ? 'step__live' : 'step__done'}>{word}</span>
      </div>
      <div className="step__sub">
        {step.detail}
        {step.ms != null && step.detail ? ' · ' : ''}
        {step.ms != null ? ms(step.ms) : ''}
      </div>
    </div>
  );
}

export function Steps({ steps, live }: { steps: TraceStep[]; live?: boolean }) {
  return (
    <div className="steps" style={{ width: '100%' }}>
      {steps.map((s, i) => (
        <StepCard key={i} step={s} live={live && i === steps.length - 1} />
      ))}
    </div>
  );
}
