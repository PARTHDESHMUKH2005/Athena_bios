import { Fragment, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Chev } from '../components/bits';
import { AnswerCostBar } from '../components/AnswerCostBar';
import { VerifyBadge } from '../components/VerifyBadge';
import { api } from '../lib/api';
import { RETRYABLE_AFTER_FAIL, errorCopy, usd } from '../lib/format';
import type { Budget, ChatDetail, Message, Mode } from '../lib/types';

export interface ChatPanelProps {
  detail: ChatDetail;
  /** A request is in flight (ask, resume or retry). */
  sending: boolean;
  /** The question just typed, shown until the server row appears. */
  pendingQuestion: string | null;
  budget: Budget | null;
  selectedId: string | null;
  onSend: (text: string, mode: Mode, short: boolean) => void;
  onCite: (docId: string, page: number, message: Message) => void;
  onOpen: (messageId: string, tab: 'act' | 'rec') => void;
  onResume: (messageId: string, action: 'shorter' | 'full' | 'cancel') => void;
  onRaise: (messageId: string, newLimitUsd: number) => Promise<void>;
  onRetry: (callId: string) => void;
  onSummary: () => void;
  onDeleteChat: () => void;
}

const CITE = /\[p\.\s*(\d+)(?:\s*[-–]\s*(\d+))?\]/g;

function withCites(msg: Message, detail: ChatDetail, onCite: ChatPanelProps['onCite']) {
  const out: ReactNode[] = [];
  let last = 0;
  const text = msg.content;
  for (const m of text.matchAll(CITE)) {
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const page = Number(m[1]);
    const hit = msg.citations.find((c) => page >= c.page_start && page <= c.page_end);
    const docId = hit?.document_id ?? detail.documents[0]?.id;
    out.push(
      <button key={start} className="cite" disabled={!docId} onClick={() => docId && onCite(docId, page, msg)} aria-label={`Open page ${page}`}>
        p.{m[2] ? `${m[1]}-${m[2]}` : m[1]}
      </button>,
    );
    last = start + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function PauseCard({ m, budget, onResume, onRaise }: { m: Message; budget: Budget | null; onResume: ChatPanelProps['onResume']; onRaise: ChatPanelProps['onRaise'] }) {
  const [raising, setRaising] = useState(false);
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const p = m.pause!;
  const max = budget?.max_limit_usd ?? 1;
  return (
    <div className="card card--warn" role="group" aria-label="Paused: needs your decision">
      <h4>{p.reason === 'service_cap' ? 'A spending limit stopped this call' : 'Not enough allowance for this answer'}</h4>
      {p.reason === 'service_cap' ? (
        <p>A spending limit on the service side stopped this call. You can shorten the question or try again later.</p>
      ) : (
        <p>This question needs about <b>{usd(p.est_usd)}</b>. You have <b>{usd(p.remaining_usd)}</b> left. Nothing has been sent.</p>
      )}
      {raising ? (
        <form
          className="row"
          style={{ alignItems: 'end', flexWrap: 'nowrap' }}
          onSubmit={async (e: FormEvent) => {
            e.preventDefault();
            const v = Number(val);
            if (!Number.isFinite(v) || val === '') return;
            setBusy(true);
            try { await onRaise(m.id, v); } finally { setBusy(false); }
          }}
        >
          <label className="field" htmlFor={`raise-${m.id}`} style={{ flex: 1 }}>New limit (USD, up to {usd(max, 2)})
            <input id={`raise-${m.id}`} type="number" min="0" max={max} step="any" value={val} onChange={(e) => setVal(e.target.value)} autoFocus inputMode="decimal" />
          </label>
          <button className="btn btn--sm" disabled={busy || val === ''}>Save and continue</button>
          <button className="linkbtn" type="button" onClick={() => setRaising(false)}>Back</button>
        </form>
      ) : (
        <div className="row">
          {p.options.includes('shorter') && <button className="btn btn--sm" onClick={() => onResume(m.id, 'shorter')}>Make it shorter</button>}
          {p.options.includes('raise_budget') && <button className="btn btn--ghost btn--sm" onClick={() => setRaising(true)}>Raise my limit</button>}
          <button className="btn btn--ghost btn--sm" onClick={() => onResume(m.id, 'cancel')}>Cancel</button>
        </div>
      )}
    </div>
  );
}

/** The named "Billing uncertain" state: the request was sent but no receipt came back. Retrying is the user's click. */
function BillingUncertain({ m, onRetry, onOpen }: { m: Message; onRetry: ChatPanelProps['onRetry']; onOpen: ChatPanelProps['onOpen'] }) {
  const [est, setEst] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    if (m.call_id) api.receipt(m.call_id).then((r) => live && setEst(r.call.est_usd ?? null)).catch(() => undefined);
    return () => { live = false; };
  }, [m.call_id]);
  return (
    <div className="a">
      <div className="card card--warn" role="alert">
        <h4><span className="badge badge--sim">Billing uncertain</span></h4>
        <p>We sent this request but did not get a receipt. We can&rsquo;t tell whether you were charged. Retry costs up to <b>{est == null ? 'the estimate' : usd(est)}</b>.</p>
        <div className="row">
          {m.call_id && <button className="btn btn--sm" onClick={() => onRetry(m.call_id!)}>Retry once</button>}
          <button className="linkbtn" onClick={() => onOpen(m.id, 'act')}>Show activity</button>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>The estimate was counted against your allowance as a precaution. Nothing is retried automatically.</p>
      </div>
    </div>
  );
}

function Answer({ m, p }: { m: Message; p: ChatPanelProps }) {
  if (m.status === 'pending') {
    return (
      <div className="a"><div className="foot"><span className="badge badge--sim">Working</span> Watch the Activity tab.</div></div>
    );
  }
  if (m.status === 'paused' && m.pause) {
    return <div className="a"><PauseCard m={m} budget={p.budget} onResume={p.onResume} onRaise={p.onRaise} /></div>;
  }
  if (m.status === 'failed') {
    const code = m.trace.find((s) => s.step === 'error')?.detail ?? 'internal';
    const c = errorCopy(code);
    const cancelled = m.content === 'Cancelled.';
    if (cancelled) return <div className="a"><div className="foot">Cancelled. Nothing was charged.</div></div>;
    if (code === 'billing_uncertain') return <BillingUncertain m={m} onRetry={p.onRetry} onOpen={p.onOpen} />;
    return (
      <div className="a">
        <div className="card card--warn" role="alert">
          <h4>{c.title}</h4>
          <p>{m.content || c.text}</p>
          <div className="row">
            {m.call_id && RETRYABLE_AFTER_FAIL.has(code) && <button className="btn btn--sm" onClick={() => p.onRetry(m.call_id!)}>Retry once</button>}
            <button className="linkbtn" onClick={() => p.onOpen(m.id, 'act')}>Show activity</button>
          </div>
          {code === 'billing_uncertain' && <p className="muted" style={{ fontSize: 12 }}>Retrying may be charged again.</p>}
        </div>
      </div>
    );
  }
  const u = m.usage;
  return (
    <div className="a">
      {m.mode === 'extract' ? <div className="mono">{m.content}</div> : <div className="a__text">{withCites(m, p.detail, p.onCite).map((x, i) => <Fragment key={i}>{x}</Fragment>)}</div>}
      <div className="foot">
        {u && <span style={{ textTransform: 'capitalize' }}>{u.tier}</span>}
        {u?.model_used && <span>{u.model_used}</span>}
        {u && <span>{usd(u.cost_usd)}</span>}
        {u && <span>{u.cache_hit ? 'Cache hit (free)' : 'Cache miss'}</span>}
        {u && <VerifyBadge status={u.verify_status} compact />}
        {u && <button className="linkbtn" onClick={() => p.onOpen(m.id, 'rec')}>Receipt</button>}
        <button className="linkbtn" onClick={() => p.onOpen(m.id, 'act')}>Activity</button>
      </div>
      {u && <AnswerCostBar usage={u} gate={m.gate} onReceipt={() => p.onOpen(m.id, 'rec')} />}
      {!u && m.gate?.abstained && <div className="foot"><span className="badge badge--sim">Nothing to check</span> Answered without calling a model. Cost: $0.</div>}
    </div>
  );
}

const GENERAL = ['Summarize this document in five bullets.', 'What are the key dates and deadlines?', 'What obligations does each side have?'];

export function ChatPanel(p: ChatPanelProps) {
  const { detail } = p;
  const [text, setText] = useState('');
  const [mode, setMode] = useState<Mode>('answer');
  const [short, setShort] = useState(false);
  const [samples, setSamples] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const hasInvoice = detail.documents.some((d) => d.pack === 'invoice');
  const isSample = detail.documents.some((d) => d.filename.startsWith('sample-agreement'));
  const inflight = p.sending;
  const lastIsPending = detail.messages[detail.messages.length - 1]?.status === 'pending';

  useEffect(() => {
    if (!isSample) return setSamples([]);
    fetch('/samples/sample-agreement.questions.json')
      .then((r) => (r.ok ? r.json() : []))
      .then((j: { q: string }[]) => setSamples(j.slice(0, 4).map((x) => x.q)))
      .catch(() => setSamples([]));
  }, [isSample, detail.chat.id]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [detail.messages.length, detail.messages[detail.messages.length - 1]?.status, inflight]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || inflight) return;
    p.onSend(t, mode, short);
    setText('');
  }
  const ask = (q: string, m: Mode = 'answer') => { if (!inflight) p.onSend(q, m, short); };
  const suggestions = mode === 'extract' || hasInvoice ? ['Extract the invoice fields'] : samples.length ? samples : GENERAL;

  return (
    <div className="ws__main">
      <div className="ws__head">
        <div style={{ minWidth: 0 }}>
          <b>{detail.chat.title}</b>{' '}
          <span className="muted" style={{ fontSize: 13 }}>· {detail.documents.length} document{detail.documents.length === 1 ? '' : 's'}</span>
        </div>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <button className="btn btn--ghost btn--sm" onClick={p.onSummary}>Download summary</button>
          <button className="btn btn--ghost btn--sm" onClick={p.onDeleteChat}>Delete chat</button>
        </div>
      </div>

      <div className="chat" ref={logRef} role="log" aria-live="polite">
        {detail.messages.length === 0 && !inflight && (
          <div className="card"><h4>Ask about your document</h4><p className="muted">Pick a question below, or type your own. Try one the document cannot answer, and see what Athena says.</p></div>
        )}
        {detail.messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="q">{m.content}</div>
          ) : (
            <div key={m.id} style={{ outline: m.id === p.selectedId ? '0' : '0' }}>
              <Answer m={m} p={p} />
            </div>
          ),
        )}
        {inflight && p.pendingQuestion && !lastIsPending && (
          <>
            <div className="q">{p.pendingQuestion}</div>
            <div className="a"><div className="foot"><span className="badge badge--sim">Working</span> Sending your question.</div></div>
          </>
        )}
      </div>

      <form className="composer" onSubmit={submit}>
        {detail.messages.length === 0 && (
          <div className="sugg">
            {suggestions.map((q) => <button key={q} type="button" disabled={inflight} onClick={() => ask(q, q.startsWith('Extract') ? 'extract' : q.startsWith('Summarize') ? 'summarize' : 'answer')}>{q}</button>)}
          </div>
        )}
        <div className="composer__row">
          <label htmlFor="q" className="sr">Question</label>
          <input id="q" type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask about your document…" autoComplete="off" disabled={inflight} />
          <button className="btn" type="submit" disabled={inflight || !text.trim()}>{inflight ? 'Working…' : 'Send'} <Chev /></button>
        </div>
        <div className="row" style={{ alignItems: 'center' }}>
          <label className="foot" htmlFor="mode">Mode
            <select id="mode" value={mode} onChange={(e) => setMode(e.target.value as Mode)} style={{ marginLeft: 6 }}>
              <option value="answer">Ask</option>
              <option value="summarize">Summarize</option>
              {hasInvoice && <option value="extract">Extract fields</option>}
            </select>
          </label>
          <label className="foot"><input type="checkbox" checked={short} onChange={(e) => setShort(e.target.checked)} /> Shorter answer (cheaper)</label>
        </div>
      </form>
    </div>
  );
}
