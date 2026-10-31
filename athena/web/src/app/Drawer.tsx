import { useEffect, useState } from 'react';
import { Steps } from '../components/bits';
import { ApiError, api } from '../lib/api';
import { errorCopy, usd } from '../lib/format';
import type { DocOut, Message } from '../lib/types';
import { ReceiptDrawer } from './ReceiptDrawer';

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
        {tab === 'rec' && (callId ? <ReceiptDrawer callId={callId} onError={onError} /> : <p className="muted">Finish a question to see its receipt.</p>)}
        {tab === 'page' && (pageRef ? <PageView refv={pageRef} docs={docs} onPage={onPage} onError={onError} /> : <p className="muted">Click a page citation in an answer to read that page here.</p>)}
      </div>
    </aside>
  );
}
