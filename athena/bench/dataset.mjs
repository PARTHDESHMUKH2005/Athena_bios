// Synthetic benchmark documents with known facts at known pages. SYNTHETIC: every document, party and number
// is generated from a seed; nothing here is a real contract. Same seed, same dataset.
import { mulberry32 } from './stats.mjs';

const money = (v) => `$${v.toLocaleString('en-US')}`;

// Each fact has a clause, a question that shares its keywords, and an optional superseded "distractor" clause
// that reuses the same keywords with a different value (so keyword retrieval can be fooled).
const FACTS = [
  { key: 'payment', vals: [14, 21, 30, 45, 60], q: 'Within how many days must the customer pay each invoice?', s: (v) => `The customer shall pay each invoice within ${v} days of the invoice date.`, d: (v) => `Under the previous agreement, which is no longer in force, invoices were payable within ${v} days.`, gold: (v) => [`${v} days`] },
  { key: 'notice', vals: [30, 60, 90, 120], q: 'How many days of written notice are required to terminate the agreement?', s: (v) => `Either party may terminate this agreement by giving ${v} days written notice.`, d: (v) => `An earlier draft required ${v} days written notice, but it was replaced.`, gold: (v) => [`${v} days`] },
  { key: 'liability', vals: [100000, 250000, 500000, 1000000], q: "What is the cap on the supplier's total liability, in dollars?", s: (v) => `The supplier's total liability under this agreement shall not exceed ${money(v)}.`, d: (v) => `A prior proposal set the liability limit at ${money(v)}, which was rejected.`, gold: (v) => [`${v}`] },
  { key: 'warranty', vals: [6, 12, 18, 24, 36], q: 'For how many months does the warranty period run?', s: (v) => `The warranty period for delivered goods is ${v} months from acceptance.`, d: (v) => `The superseded terms offered a warranty of ${v} months.`, gold: (v) => [`${v} months`] },
  { key: 'delivery', vals: [5, 7, 10, 14, 21], q: 'Within how many business days must goods be delivered after an order?', s: (v) => `Goods must be delivered within ${v} business days of each order.`, d: (v) => `The former schedule allowed delivery within ${v} business days.`, gold: (v) => [`${v} business days`, `${v} working days`] },
  { key: 'latefee', vals: [1, 1.5, 2, 3], q: 'What late fee percentage is charged per month on overdue amounts?', s: (v) => `Overdue amounts accrue a late fee of ${v}% per month.`, d: (v) => `The discontinued price list charged a late fee of ${v}% per month.`, gold: (v) => [`${v}%`, `${v} percent`] },
  { key: 'renewal', vals: [1, 2, 3, 5], q: 'For how many years does the agreement automatically renew?', s: (v) => `This agreement renews automatically for successive terms of ${v} years.`, d: (v) => `The expired order form renewed for terms of ${v} years.`, gold: (v) => [`${v} years`, `${v} year`] },
  { key: 'confidentiality', vals: [2, 3, 5, 7], q: 'For how many years do the confidentiality obligations survive termination?', s: (v) => `The confidentiality obligations survive termination for ${v} years.`, d: (v) => `The withdrawn non-disclosure draft lasted ${v} years.`, gold: (v) => [`${v} years`] },
  { key: 'retention', vals: [30, 90, 180, 365], q: 'How many days is customer data retained after the agreement ends?', s: (v) => `Customer data is retained for ${v} days after the agreement ends.`, d: (v) => `Previously customer data was kept for ${v} days after the end of service.`, gold: (v) => [`${v} days`] },
  { key: 'support', vals: [4, 8, 24, 48], q: 'Within how many hours must support respond to a critical request?', s: (v) => `Support must respond to a critical request within ${v} hours.`, d: (v) => `The legacy support plan promised a response within ${v} hours.`, gold: (v) => [`${v} hours`] },
  { key: 'minimum', vals: [50, 100, 250, 500], q: 'What is the minimum order quantity in units?', s: (v) => `The minimum order quantity is ${v} units.`, d: (v) => `The trial arrangement set a minimum order of ${v} units.`, gold: (v) => [`${v} units`] },
  { key: 'penalty', vals: [0.5, 1, 2], q: 'What penalty percentage applies for each day of late delivery?', s: (v) => `A penalty of ${v}% of the order value applies for each day of late delivery.`, d: (v) => `The abandoned proposal used a penalty of ${v}% per day.`, gold: (v) => [`${v}%`, `${v} percent`] },
  { key: 'law', vals: ['England and Wales', 'New York', 'Delaware', 'Singapore', 'Ontario'], q: 'Which jurisdiction governs this agreement?', s: (v) => `This agreement is governed by the laws of ${v}.`, d: (v) => `The earlier template named ${v} as the governing law.`, gold: (v) => [v] },
  { key: 'audit', vals: [5, 10, 15, 30], q: 'How many days of notice must be given before an audit?', s: (v) => `The customer may audit the supplier's records on ${v} days notice.`, d: (v) => `The old audit clause required ${v} days notice.`, gold: (v) => [`${v} days`] },
];

const SUBJECTS = ['The Supplier', 'The Customer', 'Each party', 'The parties', 'The service provider'];
const VERBS = ['shall cooperate in good faith regarding', 'acknowledges the importance of', 'will maintain records concerning', 'agrees to coordinate on', 'remains responsible for', 'shall review'];
const OBJECTS = ['the schedule of services', 'the integration of systems', 'quality procedures', 'joint governance meetings', 'reporting formats', 'change requests', 'project documentation', 'the allocation of personnel', 'environmental standards', 'training materials', 'the escalation path', 'shared tooling'];
const TAILS = ['as set out in the relevant schedule.', 'in accordance with ordinary business practice.', 'subject to the other terms of this agreement.', 'and will report progress to the steering group.'];
const PARTY_A = ['Northwind', 'Contoso', 'Fabrikam', 'Tailspin', 'Litware', 'Adatum'];
const PARTY_B = ['Harbor Logistics', 'Summit Systems', 'Bluebird Retail', 'Granite Works', 'Maple Analytics', 'Orchard Foods'];

const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const shuffle = (r, xs) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/**
 * @returns {{ seed:number, synthetic:true, docs: { filename:string, pack:'general', pages:string[], facts:{ key:string, q:string, gold:string[], page:number, wrong:string[] }[] }[] }}
 */
export function buildDataset({ seed = 1, docs = 3, pages = 30, facts = 12 } = {}) {
  const r = mulberry32(seed);
  const nFacts = Math.min(facts, FACTS.length);
  const out = [];
  for (let d = 0; d < docs; d++) {
    const a = PARTY_A[d % PARTY_A.length];
    const b = PARTY_B[(d + Math.floor(r() * 3)) % PARTY_B.length];
    const chosen = shuffle(r, FACTS).slice(0, nFacts);
    const pagesText = Array.from({ length: pages }, (_, p) => {
      const lines = [p === 0 ? `AGREEMENT ${d + 1} BETWEEN ${a.toUpperCase()} AND ${b.toUpperCase()}` : `SECTION ${p + 1}`];
      for (let i = 0; i < 12; i++) lines.push(`${pick(r, SUBJECTS)} ${pick(r, VERBS)} ${pick(r, OBJECTS)} ${pick(r, TAILS)}`);
      return lines;
    });
    const placed = chosen.map((f) => {
      const value = pick(r, f.vals);
      const page = Math.floor(r() * pages);
      pagesText[page].splice(1 + Math.floor(r() * 10), 0, f.s(value));
      const wrong = [];
      if (r() < 0.5 && f.vals.length > 1) {
        const other = pick(r, f.vals.filter((v) => v !== value));
        let dpage = Math.floor(r() * pages);
        if (dpage === page) dpage = (dpage + 1) % pages;
        pagesText[dpage].splice(1 + Math.floor(r() * 10), 0, f.d(other));
        wrong.push(...f.gold(other));
      }
      return { key: f.key, q: f.q, gold: f.gold(value), page: page + 1, wrong };
    });
    out.push({ filename: `agreement-${d + 1}.pdf`, pack: 'general', pages: pagesText.map((l) => l.join('\n')), facts: shuffle(r, placed) });
  }
  return { seed, synthetic: true, docs: out };
}

export const FACT_KEYS = FACTS.map((f) => f.key);
