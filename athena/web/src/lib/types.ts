// Shapes returned by the Athena API (see ../../src/orchestrator.ts and ../../src/app.ts). Kept as a small
// hand-written mirror so the web build never imports Worker code.

export interface Budget {
  limit_usd: number;
  spent_usd: number;
  reserved_usd: number;
  remaining_usd: number;
  per_call_cap_usd: number;
  max_limit_usd: number;
}

export interface DocOut {
  id: string;
  filename: string;
  pack: 'general' | 'invoice';
  status: 'created' | 'uploading' | 'pages_received' | 'processing' | 'ready' | 'partial' | 'failed';
  page_count: number;
  pages_received: number;
  scanned_pages: number;
  size_bytes: number;
  has_summary: boolean;
  created_at: number;
}

export interface Citation {
  document_id: string;
  page_start: number;
  page_end: number;
  section_id: number;
}

export interface TraceStep {
  step: string;
  label: string;
  detail: string;
  ms: number;
}

export interface PauseInfo {
  reason: 'insufficient_allowance' | 'service_cap';
  est_usd: number;
  remaining_usd: number;
  options: ('shorter' | 'raise_budget' | 'cancel')[];
}

export interface Usage {
  call_id: string;
  model_used: string | null;
  tier: string;
  cost_usd: number;
  cache_hit: boolean;
  verify_status: 'verified' | 'failed' | 'unverified' | 'missing' | string;
  /** Signed by Prune. Null when the receipt carries no such field. */
  cost_without_prune_usd?: number | null;
  /** Athena's own estimate, not signed. */
  naive_baseline_usd?: number | null;
}

export interface GateFailure {
  type: 'quote' | 'number' | 'page';
  detail: string;
}
/** Result of the no-AI citation and number check. */
export interface Gate {
  pass: boolean;
  failures: GateFailure[];
  abstained: boolean;
  mode: 'quotes' | 'pages_only';
  summary: string;
}

export type Mode = 'answer' | 'summarize' | 'extract';

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'note';
  status: 'pending' | 'done' | 'paused' | 'failed';
  content: string;
  mode: Mode;
  model_used: string | null;
  call_id: string | null;
  citations: Citation[];
  pause: PauseInfo | null;
  trace: TraceStep[];
  created_at: number;
  usage?: Usage | null;
  gate?: Gate | null;
}

export interface ChatSummary {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

export interface ChatDetail {
  chat: ChatSummary;
  documents: { id: string; filename: string; pack: string; status: string }[];
  messages: Message[];
  summary: { text: string; created_at: number } | null;
}

export interface UsageReport {
  totals: {
    spent_usd: number;
    calls: number;
    answers: number;
    avg_cost_per_answer_usd: number;
    cache_hits: number;
    receipts: number;
    receipts_verified: number;
  };
  by_chat: { chat_id: string; answers: number; cost_usd: number }[];
  series: { chat_id: string; n: number; cost_usd: number }[];
  /** Cost per good answer and the checker's own error rate (older servers omit these). */
  cpga?: Cpga;
  success_rate?: number | null;
  gate?: GateStats;
  attempts_by_answer?: AttemptsByAnswer[];
}

export interface Cpga {
  good_answers: number;
  attempted: number;
  success_rate: number | null;
  spend_usd: number;
  cost_per_request_usd: number | null;
  cpga_usd: number | null;
  cpga_excluding_checker_usd: number | null;
  cpga_including_judge_usd: number | null;
  uncertain_calls: number;
}
export interface GateStats {
  measured: boolean;
  n: number;
  false_pass_rate: number | null;
  false_fail_rate: number | null;
  last_run: number | null;
}
export interface AttemptsByAnswer {
  message_id: string;
  chat_id: string;
  good: boolean;
  attempts: { call_id: string; rung: 'first' | 'escalation'; tier: string; model: string | null; status: string; cost_usd: number | null; verify_status: string }[];
}

export interface VerifyResult {
  verify_status: 'verified' | 'failed' | 'unverified' | 'missing' | string;
  reason?: string | null;
  reason_text?: string | null;
  verified_at?: number | null;
  override?: boolean;
  saved?: boolean;
}

/** Extra fields on GET /api/receipts/:call_id. All optional so an older server still works. */
export interface ReceiptExtras {
  verify?: { status: string; reason: string | null; reason_text: string | null; verified_at: number | null };
  cost?: { actual_usd: number | null; without_prune_usd: number | null; naive_baseline_usd: number | null };
  baseline?: {
    formula_version: string;
    formula: string;
    inputs_signed: boolean;
    inputs_note: string;
    tooltip: string;
    savings_note: string;
    naive_input_tokens: number | null;
    inputs: { full_document_tokens: number; full_chat_history_tokens: number; question_tokens: number; system_tokens: number; output_tokens: number; model: string };
  } | null;
}

export interface ReceiptView {
  call: {
    id: string;
    purpose: string;
    tier: string;
    model_used: string | null;
    status: string;
    attempt: number;
    cost_usd: number | null;
    cost_without_prune_usd: number | null;
    est_usd?: number;
    cache_hit: boolean;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    created_at: number;
    finished_at: number | null;
  };
  receipt_json: string | null;
  verify_status: string;
}

export type ReceiptViewFull = ReceiptView & ReceiptExtras;

export interface AskResult {
  message: Message;
  usage: Usage | null;
}

export interface AppConfig {
  tiers: { tier: 'economy' | 'standard' | 'strong'; model: string }[];
  limits: { maxFileBytes: number; maxPages: number; maxCharsPerPage: number; maxPagesPerBatch: number; minCharsForText: number };
  packs: string[];
}
