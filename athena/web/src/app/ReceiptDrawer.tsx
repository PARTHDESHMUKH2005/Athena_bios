// The receipt tab: the three cost numbers, the verification result, and a tamper demo that edits a copy of the
// receipt and checks it. The edited copy is only ever verified; the server never saves it.
import { useEffect, useState } from 'react';
import { LABELS, BASELINE_TOOLTIP } from '../components/AnswerCostBar';
import { VerifyBadge } from '../components/VerifyBadge';
import { ApiError, api } from '../lib/api';
import { usd } from '../lib/format';
import type { ReceiptViewFull, VerifyResult } from '../lib/types';

/** Flip one digit of the signed cost, the way a person trying to fake a cheaper bill would. */
export function flipOneDigit(raw: string): string {
  const m = /("cost_with_prune_usd"\s*:\s*)([0-9.eE+-]+)/.exec(raw);
  if (m) {
    const num = m[2]!;
    const i = [...num].findIndex((c) => /[1-9]/.test(c));
    if (i >= 0) {
      const d = Number(num[i]);
      return raw.replace(m[0], m[1]! + num.slice(0, i) + String((d % 9) + 1) + num.slice(i + 1));
    }
  }
  const j = raw.search(/[0-9]/);
  return j < 0 ? raw : raw.slice(0, j) + String((Number(raw[j]) + 1) % 10) + raw.slice(j + 1);
}

export function ReceiptDrawer({ callId, onError }: { callId: string; onError: (e: unknown) => void }) {
  const [r, setR] = useState<ReceiptViewFull | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [tamper, setTamper] = useState(false);
  const [draft, setDraft] = useState('');
  const [tamperResult, setTamperResult] = useState<VerifyResult | null>(null);

  useEffect(() => {
    let live = true;
    setR(null);
    setTamper(false);
    setTamperResult(null);
    api.receipt(callId).then((x) => live && setR(x)).catch(onError);
    return () => { live = false; };
  }, [callId, onError]);

  if (!r) return <p className="muted">Loading the receipt…</p>;
  const c = r.call;
  const v = r.verify ?? { status: r.verify_status, reason: null, reason_text: null, verified_at: null };
  const raw = r.receipt_json ?? '';

  async function verify() {
    setBusy(true);
    try {
      await api.verify(callId);
      setR(await api.receipt(callId));
    } catch (e) { onError(e); } finally { setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(raw); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); }
  }
  async function checkEdited() {
    setBusy(true);
    try { setTamperResult(await api.verifyOverride(callId, draft)); }
    catch (e) { if (e instanceof ApiError && e.code === 'validation_failed') setTamperResult({ verify_status: 'failed', reason_text: 'The edited text could not be read' }); else onError(e); }
    finally { setBusy(false); }
  }

  const cost = r.cost ?? { actual_usd: c.cost_usd, without_prune_usd: c.cost_without_prune_usd, naive_baseline_usd: null };
  return (
    <>
      <span className="label muted">Receipt</span>
      <div style={{ justifySelf: 'start' }}><VerifyBadge status={v.status} reasonText={v.reason_text} /></div>
      <dl className="kv">
        <dt>{LABELS.actual}</dt><dd>{usd(cost.actual_usd)}</dd>
        <dt>{LABELS.without}</dt><dd>{cost.without_prune_usd == null ? 'n/a' : usd(cost.without_prune_usd)}</dd>
        <dt title={BASELINE_TOOLTIP}>{LABELS.naive}</dt><dd title={BASELINE_TOOLTIP}>{cost.naive_baseline_usd == null ? 'n/a' : usd(cost.naive_baseline_usd)}</dd>
        <dt>Tier</dt><dd style={{ textTransform: 'capitalize' }}>{c.tier}</dd>
        <dt>Model</dt><dd>{c.model_used ?? 'unknown'}</dd>
        <dt>Cache</dt><dd>{c.cache_hit ? 'hit' : 'miss'}</dd>
        <dt>Tokens in / out</dt><dd>{c.prompt_tokens ?? '?'} / {c.completion_tokens ?? '?'}</dd>
        <dt>Attempts</dt><dd>{c.attempt}</dd>
      </dl>
      <p className="muted" style={{ fontSize: 12 }}>
        {BASELINE_TOOLTIP} {r.baseline?.inputs_note ?? 'Baseline uses Athena’s stored token counts, which are not signed'}. Prune&rsquo;s own savings are separate from Athena&rsquo;s retrieval savings.
      </p>
      {r.baseline && (
        <details>
          <summary className="linkbtn">How is the baseline calculated?</summary>
          <div className="mono" style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>
            {r.baseline.formula}{'\n\n'}
            document {r.baseline.inputs.full_document_tokens} + history {r.baseline.inputs.full_chat_history_tokens} + question {r.baseline.inputs.question_tokens} + system {r.baseline.inputs.system_tokens} = {r.baseline.naive_input_tokens} input tokens, {r.baseline.inputs.output_tokens} output tokens, model {r.baseline.inputs.model}
          </div>
        </details>
      )}
      <div className="row">
        <button className="btn btn--ghost btn--sm" onClick={verify} disabled={busy || !raw}>{busy ? 'Checking…' : 'Verify again'}</button>
        <button className="btn btn--ghost btn--sm" onClick={copy} disabled={!raw}>{copied ? 'Copied' : 'Copy raw receipt'}</button>
        <button className="btn btn--ghost btn--sm" onClick={() => { setTamper((t) => !t); setDraft(flipOneDigit(raw)); setTamperResult(null); }} disabled={!raw}>{tamper ? 'Hide tamper demo' : 'Try tampering'}</button>
      </div>
      {tamper && (
        <div className="card card--warn" style={{ display: 'grid', gap: 8 }}>
          <h4>Try tampering</h4>
          <p className="muted" style={{ fontSize: 13 }}>This is a copy of the receipt with one digit of the cost changed. Edit it further if you like, then check it. The edited copy is never saved.</p>
          <textarea className="mono" rows={8} value={draft} onChange={(e) => { setDraft(e.target.value); setTamperResult(null); }} aria-label="Edited receipt" spellCheck={false} />
          <div className="row" style={{ alignItems: 'center' }}>
            <button className="btn btn--sm" onClick={checkEdited} disabled={busy || !draft}>Check the edited copy</button>
            <button className="linkbtn" onClick={() => { setDraft(raw); setTamperResult(null); }}>Put the original back</button>
            {tamperResult && <VerifyBadge status={tamperResult.verify_status} reasonText={tamperResult.reason_text} compact />}
          </div>
        </div>
      )}
      {raw && <div className="mono" tabIndex={0}>{(() => { try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; } })()}</div>}
      <p className="muted" id="verify-offline" style={{ fontSize: 12 }}>
        To check offline, export the receipts on the usage screen, then run <code>python bench/verify.py athena-receipts.jsonl</code> or <code>node scripts/verify-receipts.mjs athena-receipts.jsonl</code>.
      </p>
    </>
  );
}
