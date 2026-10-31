import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { evaluateAbstain, evaluateGate } from '../bench/gate_eval/run.ts';
import type { Labelled } from '../bench/gate_eval/run.ts';

const rows = readFileSync(new URL('../bench/gate_eval/labelled.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Labelled);

describe('gate evaluation set', () => {
  test('has 40 to 50 labelled examples, both labels, unique ids, and the hard cases', () => {
    assert.ok(rows.length >= 40 && rows.length <= 50, String(rows.length));
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
    for (const l of ['supported', 'not_supported']) assert.ok(rows.filter((r) => r.label === l).length >= 15, l);
    const notes = rows.map((r) => r.note).join(' | ');
    for (const hard of ['percent', 'ISO date', 'line break', 'cited page was never sent', 'quote is on page 2', 'invented quote', 'wrong currency']) assert.match(notes, new RegExp(hard, 'i'), hard);
  });
  test('the evaluation counts add up and the error rates are computed from the labels', () => {
    const g = evaluateGate(rows);
    assert.equal(g.true_pass + g.true_fail + g.false_pass + g.false_fail, g.n);
    assert.equal(g.n, rows.length);
    assert.equal(g.false_pass_rate, g.false_pass / g.n);
    assert.equal(g.errors.length, g.false_pass + g.false_fail);
    // The gate is not a magic wand: it must miss the semantic cases it cannot see, and the set must say so.
    assert.ok(g.errors.some((e) => /contradiction|opposite|swapped/.test(e.note)));
  });
  test('abstaining: unanswerable questions have weaker retrieval than answerable ones', async () => {
    const spec = JSON.parse(readFileSync(new URL('../bench/gate_eval/abstain.json', import.meta.url), 'utf8'));
    const ab = await evaluateAbstain(spec);
    const best = (a: boolean) => Math.min(...ab.strengths.filter((s) => s.answerable === a).map((s) => s.strength));
    assert.ok(best(true) > 0, 'every answerable question matched something');
    assert.ok(ab.strengths.filter((s) => !s.answerable).every((s) => s.strength < best(true)), 'unanswerable questions score below the weakest answerable one');
  });
});
