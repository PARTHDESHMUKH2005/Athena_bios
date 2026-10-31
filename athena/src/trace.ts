import type { D1Database } from '@cloudflare/workers-types';

export interface TraceStep {
  step: string;
  label: string;
  detail: string;
  ms: number;
}

/** Fixed UI copy for each step (matches athena-content.md). `detail` must never hold document text, prompts or keys. */
export const LABELS: Record<string, string> = {
  context: 'Finding relevant sections',
  tier: 'Choosing a model',
  reserve: 'Reserving budget',
  call: 'Asking through Prune',
  verify: 'Verifying receipt',
  scan: 'Checking the answer',
  escalate: 'Trying a stronger model',
  pause: 'Paused: allowance too low',
  error: 'Stopped',
  done: 'Done',
};

/** The activity timeline. Each step is persisted so a polling client sees live progress. */
export class Trace {
  steps: TraceStep[] = [];
  private db: D1Database;
  private messageId: string;
  private last = Date.now();

  constructor(db: D1Database, messageId: string) {
    this.db = db;
    this.messageId = messageId;
  }

  async add(step: string, detail = ''): Promise<void> {
    const t = Date.now();
    this.steps.push({ step, label: LABELS[step] ?? step, detail, ms: t - this.last });
    this.last = t;
    await this.persist();
  }

  async persist(): Promise<void> {
    await this.db
      .prepare('UPDATE messages SET trace_json = ? WHERE id = ?')
      .bind(JSON.stringify(this.steps), this.messageId)
      .run();
  }
}
