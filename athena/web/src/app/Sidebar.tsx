import { useRef, useState } from 'react';
import type { Budget, ChatSummary, DocOut } from '../lib/types';
import { bytes, timeAgo, usd } from '../lib/format';
import type { Pack, UploadState } from './useUpload';

interface Props {
  docs: DocOut[];
  chats: ChatSummary[];
  activeChat: string | null;
  budget: Budget | null;
  upload: UploadState | null;
  onUpload: (file: File, pack: Pack) => void;
  onSample: (kind: 'agreement' | 'invoice') => void;
  onNewChat: (docIds: string[]) => void;
  onSelectChat: (id: string) => void;
  onDeleteDoc: (id: string) => void;
  onSaveLimit: (usd: number) => Promise<void>;
  onEnd: (deleteData: boolean) => void;
}

const STATUS: Record<string, string> = { ready: 'Ready', partial: 'Partly read', uploading: 'Uploading', created: 'Uploading', pages_received: 'Indexing', processing: 'Indexing', failed: 'Failed' };

export function Sidebar(p: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [pack, setPack] = useState<Pack>('general');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState(false);
  const [confirmDoc, setConfirmDoc] = useState<string | null>(null);
  const [limit, setLimit] = useState<string>('');
  const [ending, setEnding] = useState(false);
  const [saving, setSaving] = useState(false);
  const b = p.budget;
  const usable = p.docs.filter((d) => d.status === 'ready' || d.status === 'partial');
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const spentPct = b && b.limit_usd > 0 ? Math.min(100, (b.spent_usd / b.limit_usd) * 100) : 0;
  const resPct = b && b.limit_usd > 0 ? Math.min(100 - spentPct, (b.reserved_usd / b.limit_usd) * 100) : 0;

  function onFiles(files: FileList | null) {
    const f = files?.[0];
    if (f) p.onUpload(f, pack);
    if (fileRef.current) fileRef.current.value = '';
  }

  return (
    <aside className="ws__side" aria-label="Workspace">
      <div>
        <span className="label muted">Documents</span>
        <div
          className={`drop${drag ? ' drop--on' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); onFiles(e.dataTransfer.files); }}
        >
          {p.upload ? (
            <div role="status" aria-live="polite">
              <b style={{ fontSize: 14 }}>{p.upload.name}</b>
              <div className="progress"><i style={{ width: `${(p.upload.done / Math.max(1, p.upload.total)) * 100}%` }} /></div>
              <small className="muted">
                {p.upload.step === 'reading' && `Reading pages (${p.upload.done} of ${p.upload.total})`}
                {p.upload.step === 'sending' && `Sending text (${p.upload.done} of ${p.upload.total})`}
                {p.upload.step === 'indexing' && 'Saving page references and indexing'}
              </small>
            </div>
          ) : (
            <>
              <button className="btn btn--sm" type="button" onClick={() => fileRef.current?.click()}>Upload a PDF</button>
              <small className="muted">or drop it here · up to 25 MB, 150 pages. Text is read in your browser.</small>
              <label className="field" htmlFor="pack">What kind of document is this?
                <select id="pack" value={pack} onChange={(e) => setPack(e.target.value as Pack)}>
                  <option value="general">General</option>
                  <option value="invoice">Invoice</option>
                </select>
              </label>
              <div className="row">
                <button className="linkbtn" type="button" onClick={() => p.onSample('agreement')}>Try a sample contract</button>
                <button className="linkbtn" type="button" onClick={() => p.onSample('invoice')}>Try a sample invoice</button>
              </div>
            </>
          )}
          <input ref={fileRef} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => onFiles(e.target.files)} aria-label="Choose a PDF" />
        </div>

        {p.docs.length === 0 ? (
          <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>No documents yet. Upload a PDF and Athena will index it for questions.</p>
        ) : (
          <ul className="list">
            {p.docs.map((d) => {
              const ok = d.status === 'ready' || d.status === 'partial';
              return (
                <li key={d.id} className="doc">
                  <label className="doc__name">
                    <input type="checkbox" disabled={!ok} checked={picked.has(d.id)} onChange={() => toggle(d.id)} aria-label={`Select ${d.filename}`} />
                    <b title={d.filename}>{d.filename}</b>
                  </label>
                  <small>
                    {d.page_count} page{d.page_count === 1 ? '' : 's'} · {bytes(d.size_bytes)} · {STATUS[d.status] ?? d.status}
                    {d.pack === 'invoice' ? ' · invoice' : ''}
                    {d.scanned_pages > 0 ? ` · ${d.scanned_pages} not read` : ''}
                  </small>
                  {confirmDoc === d.id ? (
                    <span className="row" style={{ fontSize: 12 }}>
                      Delete this document?
                      <button className="linkbtn" onClick={() => { setConfirmDoc(null); p.onDeleteDoc(d.id); }}>Delete</button>
                      <button className="linkbtn" onClick={() => setConfirmDoc(null)}>Keep</button>
                    </span>
                  ) : (
                    <button className="linkbtn" style={{ justifySelf: 'start' }} onClick={() => setConfirmDoc(d.id)}>Delete</button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <button className="btn btn--ghost btn--sm" style={{ marginTop: 10, width: '100%', justifyContent: 'center' }} disabled={picked.size === 0}
          onClick={() => { p.onNewChat([...picked]); setPicked(new Set()); }}>
          New chat{picked.size ? ` with ${picked.size} document${picked.size === 1 ? '' : 's'}` : ''}
        </button>
        {usable.length > 0 && picked.size === 0 && <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>Tick one or more documents to ask about them.</p>}
      </div>

      <div>
        <span className="label muted">Chats</span>
        {p.chats.length === 0 ? (
          <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>No chats yet. Pick a ready document to start asking.</p>
        ) : (
          <ul className="list">
            {p.chats.map((c) => (
              <li key={c.id}>
                <button className={`chatrow${c.id === p.activeChat ? ' on' : ''}`} onClick={() => p.onSelectChat(c.id)}>
                  <b>{c.title}</b>
                  <small>{timeAgo(c.updated_at)}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <span className="label muted">Spending limit</span>
        {b ? (
          <>
            <div className="meter" style={{ marginTop: 12 }} role="img" aria-label={`${usd(b.spent_usd)} spent of ${usd(b.limit_usd)}`}>
              <i style={{ width: `${spentPct}%` }} />
              <b style={{ left: `${spentPct}%`, width: `${resPct}%` }} />
            </div>
            <div className="foot" style={{ marginTop: 8 }}>
              <span>{usd(b.spent_usd)} of {usd(b.limit_usd)} used{b.reserved_usd > 0 ? ` · ${usd(b.reserved_usd)} reserved` : ''}</span>
            </div>
            <form
              className="field"
              style={{ marginTop: 12 }}
              onSubmit={async (e) => {
                e.preventDefault();
                const v = Number(limit);
                if (!Number.isFinite(v) || limit === '') return;
                setSaving(true);
                try { await p.onSaveLimit(v); setLimit(''); } finally { setSaving(false); }
              }}
            >
              <label htmlFor="newlimit">Change the limit (USD, up to {usd(b.max_limit_usd, 2)})</label>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input id="newlimit" type="number" min="0" max={b.max_limit_usd} step="any" placeholder={b.limit_usd.toString()} value={limit} onChange={(e) => setLimit(e.target.value)} inputMode="decimal" />
                <button className="btn btn--sm" disabled={saving || limit === ''}>Save</button>
              </div>
            </form>
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>Athena checks this before every call.</p>
          </>
        ) : (
          <p className="muted" style={{ fontSize: 13 }}>Loading…</p>
        )}
      </div>

      <div className="foot" style={{ marginTop: 'auto', display: 'grid', gap: 8 }}>
        {ending ? (
          <div className="card" style={{ fontSize: 13 }}>
            <b>End this session?</b>
            <span className="muted">Delete my data removes your documents and chats. Sign out only forgets this browser's token.</span>
            <div className="row">
              <button className="btn btn--sm" onClick={() => p.onEnd(true)}>Delete my data</button>
              <button className="btn btn--ghost btn--sm" onClick={() => p.onEnd(false)}>Sign out only</button>
              <button className="linkbtn" onClick={() => setEnding(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className="linkbtn" style={{ justifySelf: 'start' }} onClick={() => setEnding(true)}>End session</button>
        )}
      </div>
    </aside>
  );
}
