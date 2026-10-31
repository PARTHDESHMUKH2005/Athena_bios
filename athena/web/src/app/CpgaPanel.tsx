// Cost per good answer, next to how often the checker itself is wrong. Shown on the usage screen.
import { usd } from '../lib/format';
import type { UsageReport } from '../lib/types';

const pct = (x: number | null | undefined) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

export function CheckerLine({ gate }: { gate: NonNullable<UsageReport['gate']> }) {
  if (!gate.measured) return <span className="badge badge--warn" style={{ background: 'var(--amber, #fde7b0)', color: '#5b3a00' }}>Checker error rate not measured yet</span>;
  return (
    <span className="muted" style={{ fontSize: 13 }}>
      Checker wrong {pct((gate.false_pass_rate ?? 0) + (gate.false_fail_rate ?? 0))} of the time (false pass {pct(gate.false_pass_rate)}, false fail {pct(gate.false_fail_rate)}) on {gate.n} labelled examples.
    </span>
  );
}

export function CpgaPanel({ u }: { u: UsageReport }) {
  if (!u.cpga || !u.gate) return null;
  const c = u.cpga;
  return (
    <div>
      <span className="label muted">Cost per good answer</span>
      <div className="stats" style={{ marginTop: 12 }}>
        {([
          ['Cost per good answer', c.cpga_usd == null ? 'n/a' : usd(c.cpga_usd)],
          ['Success rate', pct(c.success_rate)],
          ['Cost per request', c.cost_per_request_usd == null ? 'n/a' : usd(c.cost_per_request_usd)],
          ['Good answers', `${c.good_answers} of ${c.attempted}`],
        ] as [string, string][]).map(([k, v]) => <div className="stat" key={k}><span className="label muted">{k}</span><b>{v}</b></div>)}
      </div>
      <p style={{ marginTop: 8 }}><CheckerLine gate={u.gate} /></p>
      <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        A good answer passes the citation and number check. Cost includes every retry and escalation, taken from signed receipts. The check is code, so it adds no cost
        {c.uncertain_calls ? `; ${c.uncertain_calls} call(s) with uncertain billing are not included` : ''}.
      </p>
      {!!u.attempts_by_answer?.length && (
        <details style={{ marginTop: 8 }}>
          <summary className="linkbtn">Attempts per answer</summary>
          <table style={{ marginTop: 8, fontSize: 13, borderCollapse: 'collapse', width: '100%' }}>
            <thead><tr><th align="left">Answer</th><th align="left">Attempt</th><th align="left">Model</th><th align="right">Cost</th></tr></thead>
            <tbody>
              {u.attempts_by_answer.slice(-20).flatMap((a, i) => a.attempts.map((t, j) => (
                <tr key={`${a.message_id}-${j}`}>
                  <td>{j === 0 ? `Q${i + 1}${a.good ? '' : ' (not good)'}` : ''}</td>
                  <td>{t.rung === 'escalation' ? 'escalation' : 'first'} ({t.tier})</td>
                  <td>{t.model ?? 'n/a'}</td>
                  <td align="right">{t.cost_usd == null ? 'n/a' : usd(t.cost_usd)}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
