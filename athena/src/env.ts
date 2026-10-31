import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  /** The only model credential. Provider keys live in the Prune vault. */
  PRUNE_API_KEY: string;
  PRUNE_BASE_URL: string;
  /** 'bearer' (Authorization: Bearer) or 'x-prune-key'. Docs show both; confirm in Phase 0. */
  PRUNE_AUTH?: string;
  KILL_SWITCH?: string;
  DEFAULT_BUDGET_USD?: string;
  PER_CALL_CAP_USD?: string;
  MAX_WORKSPACE_BUDGET_USD?: string;
  SESSION_LIMIT_PER_HOUR?: string;
  /** Questions per workspace per minute (default 20). The benchmark raises it. */
  MSG_LIMIT_PER_MIN?: string;
  /** Document uploads per workspace per minute (default 10). */
  DOC_LIMIT_PER_MIN?: string;
  RETENTION_DAYS?: string;
  /** JSON: { economy|standard|strong: { model, inPerM, outPerM } } in USD per 1M tokens. */
  MODEL_TIERS?: string;
  ADMIN_TOKEN?: string;
}

/** Subset of ExecutionContext the orchestrator needs. */
export interface ExecLike {
  waitUntil(p: Promise<unknown>): void;
}

export type Fetcher = typeof fetch;
