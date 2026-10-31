-- Additive only: new nullable columns and one new table. Nothing in 0001 is changed or dropped,
-- and every existing query keeps working because none of them uses SELECT * on these tables' new columns.

-- Naive baseline (Athena's own estimate, NOT part of Prune's signed receipt). The inputs are stored so the
-- number can be recomputed: naive_inputs_json holds the token counts, the model and the prices that were used.
ALTER TABLE llm_calls ADD COLUMN naive_input_tokens INTEGER;
ALTER TABLE llm_calls ADD COLUMN naive_cost_micro INTEGER;
ALTER TABLE llm_calls ADD COLUMN naive_formula_version TEXT;
ALTER TABLE llm_calls ADD COLUMN naive_inputs_json TEXT;

-- Result of the last receipt verification.
ALTER TABLE llm_calls ADD COLUMN verify_reason TEXT;
ALTER TABLE llm_calls ADD COLUMN verified_at INTEGER;

-- Result of the no-AI citation and number check for an answer (see src/gate.ts).
ALTER TABLE messages ADD COLUMN gate_json TEXT;

-- Measured error rate of that check on a human-labelled set (bench/gate_eval). One row per run.
CREATE TABLE gate_eval (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  n INTEGER NOT NULL,
  false_pass INTEGER NOT NULL,
  false_fail INTEGER NOT NULL,
  precision REAL,
  recall REAL,
  thresholds_json TEXT,
  created_at INTEGER NOT NULL
);
