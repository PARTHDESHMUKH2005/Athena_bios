import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Art, Chev, Logo, Mark, StepCard, Tag } from '../components/bits';
import { PROMPT_TOKENS } from '../lib/facts';
import type { TraceStep } from '../lib/types';

const reduceMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------ navigation ------------------------------ */

const MEGA = {
  platform: {
    label: 'Capabilities',
    blurb: 'A document assistant built to combine low cost, visible spending and proof. Every answer carries the same checks.',
    spot: 'Every answer shows its model, cost and receipt.',
    items: [
      ['Index', ['Read in the browser', 'Page-aware sections']],
      ['Retrieve', ['Only what matches', 'Short memory window']],
      ['Route', ['Economy for lookups', 'Stronger when needed']],
      ['Budget', ['Reserve before the call', 'Pause, never overspend']],
      ['Receipts', ['Signed by Prune', 'Verify offline']],
      ['Guardrails', ['Fenced documents', 'Scanned answers']],
    ],
  },
  cases: {
    label: 'Use cases',
    blurb: 'Start with documents that have clear fields and clear pages. More types follow the same engine.',
    spot: 'Contracts and invoices are live today.',
    items: [
      ['Contracts', ['Terms and notice', 'Liability and law']],
      ['Invoices', ['Fields and totals', 'Line item check']],
      ['Reports', ['Summaries', 'Section questions']],
      ['Support tickets', ['Planned']],
      ['Reviews', ['Planned']],
    ],
  },
} as const;
type MegaKey = keyof typeof MEGA;

function Nav() {
  const [solid, setSolid] = useState(false);
  const [mega, setMega] = useState<MegaKey | null>(null);
  const [hover, setHover] = useState(0);

  useEffect(() => {
    const on = () => setSolid(window.scrollY > 40);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMega(null);
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, []);

  const m = mega ? MEGA[mega] : null;
  return (
    <>
      <header className={`nav${solid || mega ? ' solid' : ''}`}>
        <div className="wrap nav__in">
          <Logo />
          <nav className="nav__links" aria-label="Main">
            {(['platform', 'cases'] as MegaKey[]).map((k) => (
              <button key={k} className="nav__link" aria-expanded={mega === k} onClick={() => { setHover(0); setMega(mega === k ? null : k); }}>
                {k === 'platform' ? 'Platform +' : 'Use cases +'}
              </button>
            ))}
            <a className="nav__link" href="#how">How it works</a>
            <a className="nav__link" href="#proof">Proof</a>
            <a className="nav__link" href="#faq">FAQ</a>
          </nav>
          <div className="nav__cta">
            <Link className="btn btn--ghost btn--sm" to="/app">Open workspace</Link>
            <Link className="btn btn--sm" to="/start">Try Athena <Chev /></Link>
          </div>
        </div>
      </header>
      {m && (
        <div className="mega" onClick={(e) => e.target === e.currentTarget && setMega(null)}>
          <div className="wrap mega__in">
            <div>
              <span className="label">{m.label}</span>
              {m.items.map((it, i) => (
                <button key={it[0]} className={`mega__big${i === hover ? ' on' : ''}`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)}>{it[0]}</button>
              ))}
            </div>
            <div>
              <span className="label">Handles</span>
              <div className="mega__sub">
                {m.items[hover]![1].map((s) => <Link key={s} to="/start" onClick={() => setMega(null)}>{s}</Link>)}
              </div>
            </div>
            <div>
              <span className="label">Spotlight</span>
              <div className="mega__spot">{m.spot}</div>
            </div>
            <div className="mega__blurb">{m.blurb}</div>
          </div>
        </div>
      )}
    </>
  );
}

/* ------------------------------ sections ------------------------------ */

type Scene = {
  tab: string; badge: string; color: string;
  file: string; ask: string; found: string; model: string;
  answer: string; title: string; chips: [string, string][];
  head: [string, string, string]; rows: [string, string, string][];
  tokens: string; cost: string;
};

const SCENES: Scene[] = [
  {
    tab: 'Contracts', badge: 'CT', color: '#f26b3a',
    file: 'MSA_Northwind.pdf · 30 pages', ask: 'What are the payment terms, notice period and liability cap?',
    found: '3 sections, pages 3, 5 and 7', model: 'economy: short lookup',
    answer: 'Payment is due within 30 days of invoice. Either party can end the agreement with 60 days written notice, and liability is capped at the fees paid in the last 12 months.',
    title: 'Key terms · MSA Northwind', chips: [['3 found', 'ok'], ['1 to review', 'warn']],
    head: ['Term', 'Value', 'Source'],
    rows: [['Payment terms', 'Net 30', 'p. 3 §4.1'], ['Notice period', '60 days', 'p. 5 §9.2'], ['Liability cap', '12 months of fees', 'p. 7 §11.3']],
    tokens: '1,184 tok', cost: '$0.00031',
  },
  {
    tab: 'Invoices', badge: 'IN', color: '#2a7de1',
    file: 'INV-20418_Halden.pdf · 2 pages', ask: 'Do the line items add up to the invoice total?',
    found: '2 sections, pages 1 and 2', model: 'economy: field check',
    answer: 'Three line items sum to $4,820.00, which matches the subtotal. With 8% tax the total is $5,205.60, the same as the amount due on page 2.',
    title: 'Line item check · INV-20418', chips: [['Totals match', 'ok']],
    head: ['Item', 'Amount', 'Source'],
    rows: [['Design retainer', '$3,200.00', 'p. 1'], ['Hosting, 12 months', '$1,140.00', 'p. 1'], ['Support hours (6)', '$480.00', 'p. 1']],
    tokens: '842 tok', cost: '$0.00019',
  },
  {
    tab: 'Reports', badge: 'RP', color: '#12a37f',
    file: 'Annual_Policy_Report.pdf · 64 pages', ask: 'Summarize section 4 and list what changed from last year.',
    found: '5 sections, pages 21 to 26', model: 'standard: summary',
    answer: 'Section 4 covers remote work. It extends eligibility to contractors, adds a home office allowance and moves approvals from HR to team leads.',
    title: 'Changes in section 4', chips: [['3 changes', 'ok'], ['1 new', 'warn']],
    head: ['Change', 'Before', 'Source'],
    rows: [['Eligibility', 'Employees only', 'p. 21 §4.1'], ['Home office allowance', 'None', 'p. 23 §4.3'], ['Approvals', 'HR team', 'p. 25 §4.6']],
    tokens: '2,406 tok', cost: '$0.00088',
  },
];

const SCENE_MS = 7000;

function Mockup({ s }: { s: Scene }) {
  return (
    <div className="mock" aria-hidden="true">
      <aside className="mock__side">
        <div className="mock__brand"><Mark /> Athena</div>
        <div className="mock__nav on">New question</div>
        <div className="mock__nav">Documents</div>
        <div className="mock__nav">Usage</div>
        <div className="mock__nav">Receipts</div>
        <div className="mock__group">Today</div>
        {SCENES.map((x) => <div key={x.tab} className={`mock__hist${x === s ? ' on' : ''}`}>{x.file.split(' ·')[0]}</div>)}
        <div className="mock__budget"><span>Allowance</span><b>$0.42 of $1.00</b><i><em style={{ width: '42%' }} /></i></div>
      </aside>
      <div className="mock__main">
        <div className="mock__crumb">Workspace <span>/</span> <b>{s.tab}</b></div>
        <div className="mock__scene" key={s.tab}>
          <div className="mock__ask">{s.ask}</div>
          <div className="mock__file">▤ {s.file}</div>
          <ul className="mock__steps">
            <li>⌕ Finding relevant sections · {s.found}</li>
            <li>⑂ Choosing a model · {s.model}</li>
            <li>✓ Verifying receipt · signature valid</li>
          </ul>
          <p className="mock__answer">{s.answer}</p>
          <div className="mock__card">
            <div className="mock__cardhead">
              <b>{s.title}</b>
              <span>{s.chips.map(([t, k]) => <em key={t} className={`mock__chip ${k}`}>{t}</em>)}</span>
            </div>
            <table>
              <thead><tr>{s.head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>{s.rows.map((r) => <tr key={r[0]}>{r.map((c, i) => <td key={i}>{c}</td>)}</tr>)}</tbody>
            </table>
          </div>
          <div className="mock__cost"><span>{s.model.split(':')[0]}</span><span>{s.tokens}</span><span>{s.cost}</span><span className="ok">Receipt verified</span></div>
        </div>
        <div className="mock__input">What would you like to know?<span>↵</span></div>
      </div>
    </div>
  );
}

function Hero() {
  const [on, setOn] = useState(0);
  const [paused, setPaused] = useState(false);
  const still = reduceMotion();
  const next = () => setOn((i) => (i + 1) % SCENES.length);
  return (
    <section className="hero" aria-label="Introduction">
      <Art kind="terrain" />
      <div className="hero__shade" />
      <div className="wrap hero__in">
        <div className="hero__grid">
          <div className="hero__copy">
            <h1 className="hero__title">Ask any document anything.</h1>
            <p className="hero__sub">Answers with the page they came from, the model that wrote them and exactly what they cost.</p>
            <div className="hero__ctas">
              <Link className="pill pill--light" to="/start">Try Athena</Link>
              <Link className="pill" to="/app">Open workspace</Link>
            </div>
          </div>
          <div className="hero__screen" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
            <Mockup s={SCENES[on]!} />
          </div>
        </div>
        <div className="hero__tabs" role="tablist" aria-label="Document types">
          {SCENES.map((s, i) => (
            <button key={s.tab} role="tab" aria-selected={i === on} className={`htab${i === on ? ' on' : ''}`} onClick={() => setOn(i)}>
              <span className="htab__ic" style={{ background: s.color }}>{s.badge}</span>
              <span>{s.tab}</span>
              {i === on && !still && (
                <i className="htab__bar" style={{ animationDuration: `${SCENE_MS}ms`, animationPlayState: paused ? 'paused' : 'running' }} onAnimationEnd={next} />
              )}
            </button>
          ))}
          <a className="htab htab--soon" href="#types">
            <span className="htab__ic">+</span>
            <span>Tickets and reviews next</span>
          </a>
        </div>
      </div>
    </section>
  );
}

const TYPES: [string, string, boolean][] = [
  ['Contracts', 'Payment terms, notice periods, liability caps, with the page each one came from.', true],
  ['Invoices', 'Vendor, dates, line items and total, with a code check that the items add up.', true],
  ['Reports and policies', 'Ask about section 4, summarize it, find the clause that applies.', true],
  ['Support tickets', 'Topic, urgency, a draft reply for a human to send.', false],
  ['App reviews', 'Sort a pile of reviews into bugs, requests, praise and complaints.', false],
  ['Scanned pages', 'Reading pages that are pictures of text. Flagged today, not yet read.', false],
];

function Types() {
  return (
    <section className="pad" id="types">
      <div className="wrap">
        <div style={{ marginBottom: 40 }}><Tag>Documents</Tag><Tag>Use cases</Tag></div>
        <h2 className="h-lg" style={{ marginBottom: 56, maxWidth: '16ch' }}>Text people already have to read.</h2>
        <div className="grid-cells">
          {TYPES.map(([h, p, live]) => (
            <div className="cell" key={h}>
              <div><h3>{h}</h3><p>{p}</p></div>
              <span className={`chip${live ? ' chip--live' : ''}`}>{live ? 'Live' : 'Planned'}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Statement() {
  return (
    <section className="pad" style={{ paddingTop: 0 }}>
      <div className="wrap">
        <hr className="rule" style={{ marginBottom: 56 }} />
        <p className="statement">Athena reads a document once,<span className="r">sends only what matters, and shows the bill.</span></p>
        <div className="cols3">
          <div><b>It costs less per question</b><p>Index once, then send only the sections that match. Follow-ups use a short memory window, not the whole chat.</p></div>
          <div><b>You see the price first</b><p>Every answer shows its model, its cost and a receipt. The allowance is checked before anything is sent.</p></div>
          <div><b>Failures stay small</b><p>Limited retries, no blind retry when billing is uncertain, and finished work stays saved.</p></div>
        </div>
      </div>
    </section>
  );
}

const STEPS: [string, string, string][] = [
  ['Read', 'Read in your browser', 'Text is pulled from the PDF on your own device, so nothing is re-processed for every question.'],
  ['Index', 'Index once', 'Athena splits the document into sections that remember their page, and stores them so later questions never touch the file again.'],
  ['Retrieve', 'Send only what matters', 'Only the few sections that match your question go to the model, plus a short memory of the conversation.'],
  ['Route', 'Right-size the model', 'A short lookup uses an economical model. A comparison or calculation can use a stronger one. You always see which.'],
  ['Reserve', 'Check the budget first', 'The estimated cost is reserved before the call. If it does not fit, nothing is sent and you choose what to do.'],
  ['Ask', 'One path to any model', 'Every call goes through Prune. Temporary failures retry a few times; spend caps and uncertain billing never retry blindly.'],
  ['Verify', 'Prove it', 'The receipt is checked, citations are validated against what was sent, and the answer is scanned. Cost comes from the receipt.'],
];

function Orbit() {
  const [i, setI] = useState(0);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (reduceMotion()) return;
    const t = setInterval(() => setI((x) => (x + 1) % STEPS.length), 3600);
    return () => clearInterval(t);
  }, [tick]);
  const cx = 280, cy = 250, r = 190;
  return (
    <section className="inv pad" id="how" aria-label="How it works">
      <div className="wrap orbit">
        <svg className="orbit__svg" viewBox="0 0 560 520" role="img" aria-label="The seven steps behind every answer">
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,.35)" />
          {STEPS.map((s, k) => {
            const a = ((-90 + k * (360 / STEPS.length)) * Math.PI) / 180;
            const x = cx + r * Math.cos(a);
            const y = cy + r * Math.sin(a);
            const cos = Math.cos(a);
            const sin = Math.sin(a);
            return (
              <g key={s[0]} className="orbit__node" tabIndex={0} role="button" aria-label={s[1]}
                onClick={() => { setI(k); setTick((t) => t + 1); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setI(k); setTick((t) => t + 1); } }}>
                <circle cx={x} cy={y} r={22} fill="transparent" />
                <circle cx={x} cy={y} r={k === i ? 7 : 6} fill={k === i ? '#fff' : '#000'} stroke="#fff" strokeWidth={1.3} />
                <text className="orbit__lbl" x={x + (cos > 0.2 ? 18 : cos < -0.2 ? -18 : 0)} y={y + (sin > 0.5 ? 30 : sin < -0.5 ? -16 : 4)}
                  textAnchor={cos > 0.2 ? 'start' : cos < -0.2 ? 'end' : 'middle'} opacity={k === i ? 1 : 0.6}>{s[0]}</text>
              </g>
            );
          })}
        </svg>
        <div>
          <h2 className="h-lg" style={{ fontSize: 'clamp(30px,3.6vw,48px)' }}>One answer, seven checks.</h2>
          <p className="muted" style={{ marginTop: 20, maxWidth: '44ch' }}>Every question goes through the same path, so the cost, the model and the proof are always there.</p>
          <div className="orbit__text" aria-live="polite"><h4>{STEPS[i]![1]}</h4><p>{STEPS[i]![2]}</p></div>
        </div>
      </div>
    </section>
  );
}

const DEMO_STEPS: TraceStep[] = [
  { step: 'context', label: 'Finding relevant sections', detail: '3 sections, pages 3 and 5', ms: 14 },
  { step: 'tier', label: 'Choosing a model', detail: 'economy: short lookup', ms: 1 },
  { step: 'reserve', label: 'Reserving budget', detail: 'up to $0.000400', ms: 3 },
  { step: 'call', label: 'Asking through Prune', detail: 'attempt 1', ms: 1630 },
  { step: 'verify', label: 'Verifying receipt', detail: 'signature valid', ms: 22 },
];

function Activity() {
  const [shown, setShown] = useState(DEMO_STEPS.length);
  useEffect(() => {
    if (reduceMotion()) return;
    let timers: ReturnType<typeof setTimeout>[] = [];
    const play = () => {
      setShown(0);
      timers = DEMO_STEPS.map((_, k) => setTimeout(() => setShown(k + 1), 500 + k * 650));
    };
    play();
    const loop = setInterval(play, 500 + DEMO_STEPS.length * 650 + 4200);
    return () => { timers.forEach(clearTimeout); clearInterval(loop); };
  }, []);
  return (
    <section className="pad" id="activity">
      <div className="wrap">
        <div style={{ marginBottom: 32 }}><Tag>Features</Tag><Tag>Activity</Tag></div>
        <h2 className="h-xl" style={{ marginBottom: 56 }}>Every answer shows its work</h2>
        <div className="panel" aria-label="Example activity timeline">
          <div className="steps">
            {DEMO_STEPS.map((s, k) => (
              <div key={s.step} className={k < shown ? '' : 'off step-wrap'} style={{ opacity: k < shown ? 1 : 0.25, transition: 'opacity .35s' }}><StepCard step={s} /></div>
            ))}
          </div>
        </div>
        <div className="two" style={{ marginTop: 72 }}>
          <div><span className="label muted">Activity</span><h3 className="h-md" style={{ marginTop: 28 }}>Watch the steps, not a spinner</h3><p style={{ marginTop: 28 }}>While a question runs, Athena lists what it is doing: which sections it found, which model it chose, how much it reserved, and whether the receipt checked out. When it is done, the same list stays with the answer.</p></div>
          <div><span className="label muted">Why it matters</span><h3 className="h-md" style={{ marginTop: 28 }}>Trust you can inspect</h3><p style={{ marginTop: 28 }}>Each step records what was decided and why, without storing your document text in the log. If something fails, the list ends where it stopped and says what is safe.</p></div>
        </div>
      </div>
    </section>
  );
}

function Proof() {
  const rows: [string, number, boolean][] = [
    ['Whole document + history', PROMPT_TOKENS.naive, false],
    ['Top-8 sections + history', PROMPT_TOKENS.typical, false],
    ['Athena', PROMPT_TOKENS.athena, true],
  ];
  const max = Math.max(...rows.map((r) => r[1]));
  return (
    <section className="pad" id="proof" style={{ paddingTop: 0 }}>
      <div className="wrap">
        <div style={{ marginBottom: 28 }}><Tag>Proof</Tag></div>
        <h2 className="h-lg" style={{ maxWidth: '20ch' }}>What is measured, and what is not yet.</h2>
        <div className="two" style={{ marginTop: 56, gap: 72 }}>
          <div>
            <h3 className="h-md">Prompt size per question</h3>
            <p className="muted" style={{ marginTop: 14, fontSize: 15 }}>Average tokens actually sent on a seeded synthetic benchmark (2 agreements, 30 pages each, 20 questions), measured from the prompts that went out.</p>
            <div className="bigbars">
              {rows.map(([name, v, a]) => (
                <div key={name} className={`bigbar${a ? ' a' : ''}`}>
                  <span>{name}</span>
                  <span><i style={{ width: `${(v / max) * 100}%` }} /></span>
                  <span>{v.toLocaleString('en-US')} tok</span>
                </div>
              ))}
            </div>
            <p className="muted" style={{ marginTop: 20, fontSize: 14 }}>Against apps that also retrieve a few sections, prompt size is similar. The difference there is model choice, caching and budget control, which the real benchmark measures. Cost per answer is not shown here because it has not been run against the live service yet.</p>
          </div>
          <div>
            <h3 className="h-md">Check the receipts yourself</h3>
            <p className="muted" style={{ marginTop: 14, fontSize: 15 }}>Every real answer carries a receipt signed by Prune. Export them all from the workspace and verify with one command.</p>
            <div className="mono" style={{ marginTop: 20 }}>{`$ node scripts/verify-receipts.mjs receipts.jsonl\n\nreceipts checked : 18\nsignature valid  : 18\ntotal from receipts vs recorded: match\nALL RECEIPTS VERIFIED`}</div>
            <p className="muted" style={{ marginTop: 14, fontSize: 13 }}>Example output format from the project's verifier. It catches an edited cost, an edited receipt and a wrong key.</p>
          </div>
        </div>
        <div style={{ marginTop: 72 }}>
          <span className="label muted">Limits, stated plainly</span>
          <ul className="limits" style={{ marginTop: 18 }}>
            <li><span className="label">Text PDFs</span><span>Scanned pages are flagged, not read yet.</span></li>
            <li><span className="label">Summaries</span><span>A summary can lose detail, so follow-ups also pull the earlier messages that matter.</span></li>
            <li><span className="label">Search</span><span>Keyword search can miss a paraphrased question. That is the price of zero retrieval cost.</span></li>
            <li><span className="label">Injection</span><span>Documents are treated as data and answers are scanned. We aim for harmless, not for magic.</span></li>
            <li><span className="label">Results</span><span>Accuracy and cost numbers appear only after the real benchmark runs.</span></li>
          </ul>
        </div>
      </div>
    </section>
  );
}

const SAFETY: [string, string][] = [
  ['Fenced documents', 'Text from a file is data, never instructions. It cannot close its own fence.'],
  ['Answers are scanned', 'Secrets, links the document never contained and risky commands are removed.'],
  ['Two budget layers', 'Athena reserves before the call. Prune enforces the same cap on its side.'],
  ['Retries that stop', 'Spend caps, bad keys and uncertain billing are never retried blindly.'],
  ['No keys in code', 'Provider keys live in the Prune vault. The app holds one Prune key.'],
  ['Signed receipts', 'Cost comes from the receipt. Verify it offline, without trusting us.'],
];

const FAQ: [string, string][] = [
  ['Why not just use ChatGPT or Claude with a PDF?', 'Those do not show the cost of each answer, do not check a budget before the call, and give no signed receipt. Athena is for people who want cost control and proof.'],
  ['How do you know the savings are real?', 'Cost comes only from signed Prune receipts. We compare Athena with two baselines on the same questions, test the accuracy difference statistically, and publish the results once the live benchmark has run.'],
  ['What if the AI service is down?', 'Athena stops safely. It never makes up an answer or bills you twice, and your documents stay saved. You can retry when it is back.'],
  ['What about hidden instructions inside a PDF?', 'The document is fenced off as untrusted text, Shield is on in Prune, and answers are scanned before they are shown. We test with fifteen injection styles.'],
  ['Does a summary lose information?', 'It can. That is why follow-ups also pull in the specific earlier messages that matter.'],
  ['Does it read scanned PDFs?', 'Not yet. Scanned pages are flagged. Reading them is planned.'],
  ['Is my data private?', "Your workspace is separate from everyone else's and protected by a private token. You can delete any document or chat at any time."],
];

function SafetyAndFaq() {
  return (
    <>
      <section className="pad" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div style={{ marginBottom: 28 }}><Tag>Safety</Tag></div>
          <h2 className="h-lg" style={{ marginBottom: 48, maxWidth: '16ch' }}>Safe when things go wrong.</h2>
          <div className="grid-cells">
            {SAFETY.map(([h, p]) => <div className="cell" key={h}><div><h3>{h}</h3><p>{p}</p></div></div>)}
          </div>
        </div>
      </section>
      <section className="pad" id="faq" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div style={{ marginBottom: 28 }}><Tag>FAQ</Tag></div>
          <h2 className="h-lg" style={{ marginBottom: 48 }}>Questions people ask.</h2>
          <div className="faq">
            {FAQ.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}
          </div>
        </div>
      </section>
    </>
  );
}

function Cta() {
  return (
    <section className="pad" style={{ paddingTop: 0 }}>
      <div className="wrap">
        <hr className="rule" style={{ marginBottom: 48 }} />
        <div className="two" style={{ alignItems: 'end' }}>
          <h2 className="h-lg">Ask your first question in a minute.</h2>
          <div>
            <p className="muted" style={{ marginBottom: 24 }}>No account. You set the spending limit. Try the sample contract or upload your own PDF.</p>
            <Link className="btn" to="/start">Try Athena <Chev /></Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer>
      <div className="wrap">
        <div className="foot-grid">
          <div><Logo /><p className="muted" style={{ fontSize: 14, marginTop: 12, maxWidth: '26ch' }}>Ask any document anything. See what it cost.</p></div>
          <div><span className="label">Product</span><a href="#how">How it works</a><Link to="/app">Workspace</Link><a href="#activity">Activity timeline</a></div>
          <div><span className="label">Trust</span><a href="#proof">Proof and limits</a><a href="#faq">FAQ</a></div>
          <div><span className="label">Built with</span><p style={{ fontSize: 15 }}>Prune for every model call and every receipt.<br />Cloudflare Workers, D1 and R2.</p><p className="muted" style={{ fontSize: 13, marginTop: 10 }}>Built for the FORGE "Ship It Lean" track.</p></div>
        </div>
      </div>
    </footer>
  );
}

export function Landing() {
  return (
    <>
      <Nav />
      <main id="top">
        <Hero />
        <Types />
        <Statement />
        <Orbit />
        <Activity />
        <Proof />
        <SafetyAndFaq />
        <Cta />
      </main>
      <Footer />
    </>
  );
}
