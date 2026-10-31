// Under every answer: what it actually cost, what it would have cost without Prune's savings (both signed by Prune),
// and Athena's own naive-baseline estimate (not signed). Always in this order, always with these labels.
import { useState } from 'react';
import { usd } from '../lib/format';
import type { Gate, Usage } from '../lib/types';

export const LABELS = {
  actual: 'Actual cost',
  without: 'Without Prune’s savings',
  naive: 'Naive baseline (Athena estimate)',
} as const;
export const BASELINE_TOOLTIP = 'The signature proves what Prune charged. The naive baseline is Athena’s own calculation.';
const FORMULA = [
  'naive_input_tokens = full_document_tokens + full_chat_history_tokens + question_tokens + system_tokens',
  'naive_cost = naive_input_tokens * input_price + actual_output_tokens * output_price',
  'Same model that answered. Token counts are estimates (about 4 characters per token) unless the signed receipt carries them.',
].join('\n');

export function GateBadge({ gate }: { gate: Gate }) {
  if (gate.abstained && gate.pass) return <span className="badge badge--sim" title="The answer says it is not in the document, so there was nothing to check.">Nothing to check</span>;
  const tip = 'This checks the quote and figures appear on the cited page. It does not prove the model relied on that page.';
  return gate.pass ? (
    <span className="badge badge--ok" title={tip}>Citation check passed</span>
  ) : (
    <span className="badge badge--bad" title={tip}>{gate.summary || 'Citation check failed'}</span>
  );
}

export function AnswerCostBar({ usage, gate, onReceipt }: { usage: Usage; gate?: Gate | null; onReceipt?: () => void }) {
  const [open, setOpen] = useState(false);
  const cells: [string, number | null | undefined, string?][] = [
    [LABELS.actual, usage.cost_usd],
    [LABELS.without, usage.cost_without_prune_usd],
    [LABELS.naive, usage.naive_baseline_usd, BASELINE_TOOLTIP],
  ];
  return (
    <div className="costbar" style={{ display: 'grid', gap: 6, marginTop: 8 }}>
      <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
        {cells.map(([label, value, tip]) => (
          <span key={label} title={tip} style={{ display: 'grid', gap: 2 }}>
            <span className="label muted" style={{ fontSize: 11 }}>{label}</span>
            <b style={{ fontVariantNumeric: 'tabular-nums' }}>{value == null ? 'n/a' : usd(value)}</b>
          </span>
        ))}
        <button className="linkbtn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>How is this calculated?</button>
        {onReceipt && <button className="linkbtn" onClick={onReceipt}>Verify receipt</button>}
        {gate && <GateBadge gate={gate} />}
      </div>
      {open && (
        <div className="muted" style={{ fontSize: 12, display: 'grid', gap: 6 }}>
          <div className="mono" style={{ whiteSpace: 'pre-wrap' }}>{FORMULA}</div>
          <span>{BASELINE_TOOLTIP}</span>
          <span>Prune&rsquo;s own savings are separate from Athena&rsquo;s retrieval savings. They are not added together.</span>
        </div>
      )}
    </div>
  );
}
