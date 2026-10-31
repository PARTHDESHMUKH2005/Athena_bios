import { useEffect, useState } from 'react';
import { Steps } from '../components/bits';
import { ApiError, api } from '../lib/api';
import { errorCopy, usd } from '../lib/format';
import type { DocOut, Message, ReceiptView } from '../lib/types';

export type Tab = 'act' | 'rec' | 'page';
export interface PageRef {
  docId: string;
  page: number;
  highlight?: string;
}

interface Props {
  tab: Tab;
  onTab: (t: Tab) => void;
  message: Message | null;
  docs: DocOut[];
  pageRef: PageRef | null;
  onPage: (r: PageRef) => void;
  onError: (e: unknown) => void;
}

function Receipt({ callId, onError }: { callId: string; onError: (e: unknown) => void }) {
  const [r, setR] = useState<ReceiptView | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    setR(null);
    api.receipt(callId).then((x) => live && setR(x)).catch(onError);
    return () => { live = false; };
  }, [callId, onError]);

  if (!r) return <p className="muted">Loading the receipt…</p>;
  const c = r.call;
  const vs = r.verify_status;
  async function verify() {
    setBusy(true);
    try {
      await api.verify(callId);
      setR(await api.receipt(callId));
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(r!.receipt_json ?? '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  let pretty = r.receipt_json ?? '';
  try { pretty = JSON.stringify(JSON.parse(pretty), null, 2); } catch { /* show raw */ }
  return (
    <>
      <span className="label muted">Receipt</span>
      <span className={`badge ${vs === 'verified' ? 'badge--ok' : vs === 'failed' ? 'badge--bad' : 'badge--sim'}`} style={{ justifySelf: 'start' }}>
        {vs === 'verified' ? 'Signature verified' : vs === 'failed' ? 'Verification failed' : vs === 'unverified' ? 'Not verified here: verify offline' : 'No receipt'}
      </span>
      <dl className="kv">
        <dt>Tier</dt><dd style={{ textTransform: 'capitalize' }}>{c.tier}</dd>
        <dt>Model</dt><dd>{c.model_used ?? 'unknown'}</dd>
        <dt>Cost</dt><dd>{usd(c.cost_usd)}</dd>
        {c.cost_without_prune_usd != null && (<><dt>Without Prune</dt><dd>{usd(c.cost_without_prune_usd)}</dd></>)}
        <dt>Cache</dt><dd>{c.cache_hit ? 'hit' : 'miss'}</dd>
        <dt>Tokens in / out</dt><dd>{c.prompt_tokens ?? '?'} / {c.completion_tokens ?? '?'}</dd>
        <dt>Attempts</dt><dd>{c.attempt}</dd>
      </dl>
      <div className="row">
        <button className="btn btn--ghost btn--sm" onClick={verify} disabled={busy || !r.receipt_json}>{busy ? 'Checking…' : 'Verify again'}</button>
        <button className="btn btn--ghost btn--sm" onClick={copy} disabled={!r.receipt_json}>{copied ? 'Copied' : 'Copy raw receipt'}</button>
      </div>
      {r.receipt_json && <div className="mono" tabIndex={0}>{pretty}</div>}
      <p className="muted" style={{ fontSize: 12 }}>Costs come from the receipt, not from our estimate. The copy button gives the exact bytes Prune signed.</p>
    </>
  );
}

function PageView({ refv, docs, onPage, onError }: { refv: PageRef; docs: DocOut[]; onPage: (r: PageRef) => void; onError: (e: unknown) => void }) {
  const [text, setText] = useState<string | null>(null);
  const doc = docs.find((d) => d.id === refv.docId);
  useEffect(() => {
    let live = true;
    setText(null);
    api.page(refv.docId, refv.page).then((x) => live && setText(x.text)).catch((e) => { if (e instanceof ApiError && e.code === 'not_found') setText('This page is no longer available.'); else onError(e); });
    return () => { live = false; };
  }, [refv.docId, refv.page, onError]);
  const n = doc?.page_count ?? refv.page;
  const body = (() => {
    if (text === null) return 'Loading…';
    const h = refv.highlight?.trim();
    if (!h) return text;
    const i = text.indexOf(h);
    if (i < 0) return text;
    return (<>{text.slice(0, i)}<mark>{h}</mark>{text.slice(i + h.length)}</>);
  })();
  return (
    <>
      <span className="label muted">{doc?.filename ?? 'Document'} · page {refv.page} of {n}</span>
      <div className="mono" tabIndex={0}>{body}</div>
      <div className="row">
        <button className="btn btn--ghost btn--sm" disabled={refv.page <= 1} onClick={() => onPage({ docId: refv.docId, page: refv.page - 1 })}>Previous</button>
        <button className="btn btn--ghost btn--sm" disabled={refv.page >= n} onClick={() => onPage({ docId: refv.docId, page: refv.page + 1 })}>Next</button>
      </div>
    </>
  );
}

export function Drawer({ tab, onTab, message, docs, pageRef, onPage, onError }: Props) {
  const callId = message?.usage?.call_id ?? message?.call_id ?? null;
  const live = message?.status === 'pending';
  const errCode = message?.trace.find((s) => s.step === 'error')?.detail;
  return (
    <aside className="ws__drawer" aria-label="Details">
      <div className="tabs" role="tablist">
        {([['act', 'Activity'], ['rec', 'Receipt'], ['page', 'Page']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => onTab(k)}>{l}</button>
        ))}
      </div>
      <div className="pane" role="tabpanel">
        {tab === 'act' && (
          !message ? <p className="muted">The steps for each question appear here, live.</p> : (
            <>
              <span className="label muted">Activity</span>
              <Steps steps={message.trace} live={live} />
              {message.trace.length === 0 && <p className="muted">Waiting for the first step…</p>}
              {errCode && <p className="muted" style={{ fontSize: 12 }}>{errorCopy(errCode).text}</p>}
            </>
          )
        )}
        {tab === 'rec' && (callId ? <Receipt callId={callId} onError={onError} /> : <p className="muted">Finish a question to see its receipt.</p>)}
        {tab === 'page' && (pageRef ? <PageView refv={pageRef} docs={docs} onPage={onPage} onError={onError} /> : <p className="muted">Click a page citation in an answer to read that page here.</p>)}
      </div>
    </aside>
  );
}
