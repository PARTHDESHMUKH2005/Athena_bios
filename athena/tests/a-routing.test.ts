import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { explainEscalation, explainRouting, pickTier } from '../src/tiers.ts';

describe('routing explanations', () => {
  test('every rule produces a plain sentence naming the tier and the reason', () => {
    const base = { purpose: 'answer' as const, documentCount: 1 };
    const cases = [
      { q: 'What is the due date?', ctx: 900, tier: 'economy' as const, word: 'economical' },
      { q: 'Explain the termination clause in detail '.repeat(5), ctx: 4000, tier: 'standard' as const, word: 'standard' },
      { q: 'Compare the two fee schedules', ctx: 900, tier: 'strong' as const, word: 'stronger' },
    ];
    for (const c of cases) {
      const picked = pickTier({ ...base, question: c.q, contextTokens: c.ctx });
      assert.equal(picked.tier, c.tier);
      const text = explainRouting(picked.tier, picked.reason);
      assert.ok(text.includes(c.word), text);
      assert.ok(text.includes(picked.reason), text);
      assert.ok(text.endsWith('.'), text);
      assert.ok(!/gemini|gpt|claude/i.test(text), 'never names a provider model');
    }
  });

  test('budget pressure is stated when the tier was lowered', () => {
    assert.ok(explainRouting('economy', 'general question', { lowered: true }).includes('within your allowance'));
    assert.ok(!explainRouting('economy', 'short lookup').includes('allowance'));
  });

  test('the escalation sentence says from, to, why, and that it is the only retry', () => {
    const t = explainEscalation('economy', 'standard', 'a cited page was not in the text sent');
    assert.ok(t.includes('standard model instead of the economical model'));
    assert.ok(t.includes('a cited page was not in the text sent'));
    assert.ok(t.includes('only retry'));
  });
});
