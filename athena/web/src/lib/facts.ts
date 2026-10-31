// Numbers shown on the landing page. Every number here is MEASURED, not invented, and says where it came from.
// Update these from bench/out/results.json after a real run. Cost-per-answer results are deliberately NOT shown
// until the real benchmark exists (see athena-content.md: no unfilled placeholders, no made-up numbers).

/** Average prompt tokens per question on the seeded synthetic benchmark (2 agreements x 30 pages, 20 questions).
 *  Measured from the prompts that actually went out (npm run bench). Prompt size, not cost. */
export const PROMPT_TOKENS = {
  naive: 10639, // whole document + whole history, every question
  typical: 2231, // top-8 retrieved sections + whole history
  athena: 2134, // top-8 retrieved sections + short memory window
};
export const PROMPT_TOKENS_NOTE = 'Synthetic 30-page agreements, 20 questions, measured from the prompts sent. Cost results come from the real benchmark.';
