import { useEffect, useState } from 'react';
import { api, download } from '../lib/api';
import { usd } from '../lib/format';
import type { UsageReport } from '../lib/types';
import { CpgaPanel } from './CpgaPanel';

export function UsagePanel({ refreshKey, chatTitles, onError }: { refreshKey: number; chatTitles: Record<string, string>; onError: (e: unknown) => void }) {
  const [u, setU] = useState<UsageReport | null>(null);
  useEffect(() => {
    let live = true;
    api.usage().then((x) => live && setU(x)).catch(onError);
    return () => { live = false; };
  }, [refreshKey, onError]);

  if (!u) return <div className="chat"><p className="muted">Loading usage…</p></div>;
  const t = u.totals;
  const max = Math.max(1e-9, ...u.series.map((s) => s.cost_usd));
  return (
    <div className="ws__main">
      <div className="ws__head"><b>What you've spent</b>
        <button className="btn btn--ghost btn--sm" onClick={async () => { try { download(await api.exportReceipts(), 'athena-receipts.jsonl'); } catch (e) { onError(e); } }}>Export receipts (.jsonl)</button>
      </div>
      <div className="chat">
        {t.answers === 0 ? (
          <div className="card"><h4>Nothing spent yet</h4><p className="muted">Your costs will appear here after the first answer.</p></div>
        ) : (
          <>
            <div className="stats">
              {([
                ['Total spent', usd(t.spent_usd)],
                ['Average per answer', usd(t.avg_cost_per_answer_usd)],
                ['Cache hits', String(t.cache_hits)],
                ['Receipts verified', `${t.receipts_verified} of ${t.receipts}`],
              ] as [string, string][]).map(([k, v]) => (
                <div className="stat" key={k}><span className="label muted">{k}</span><b>{v}</b></div>
              ))}
            </div>
            <CpgaPanel u={u} />
            <div>
              <span className="label muted">Cost per answer</span>
              <div className="bars" style={{ marginTop: 12 }}>
                {u.series.slice(-30).map((s, i) => (
                  <div className="bar" key={i} style={{ gridTemplateColumns: '120px 1fr 80px' }}>
                    <span title={chatTitles[s.chat_id]} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(chatTitles[s.chat_id] ?? 'Chat').slice(0, 14)} · Q{s.n}</span>
                    <i style={{ width: `${Math.max(2, (s.cost_usd / max) * 100)}%` }} />
                    <span>{usd(s.cost_usd)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <span className="label muted">Verify it yourself</span>
              <div className="mono" style={{ marginTop: 10 }}>{'node scripts/verify-receipts.mjs athena-receipts.jsonl'}</div>
              <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>Re-checks every Prune signature on the exported bytes and recomputes the total from the receipts.</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
