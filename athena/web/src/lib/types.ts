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
    cache_hit: boolean;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    created_at: number;
    finished_at: number | null;
  };
  receipt_json: string | null;
  verify_status: string;
}

export interface AskResult {
  message: Message;
  usage: Usage | null;
}

export interface AppConfig {
  tiers: { tier: 'economy' | 'standard' | 'strong'; model: string }[];
  limits: { maxFileBytes: number; maxPages: number; maxCharsPerPage: number; maxPagesPerBatch: number; minCharsForText: number };
  packs: string[];
}
