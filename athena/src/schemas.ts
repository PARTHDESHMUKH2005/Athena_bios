import { z } from 'zod';

// Request schemas, shared by the Worker and the web client. Response shapes are the TypeScript
// interfaces in orchestrator.ts (MessageOut, UsageOut, AskResult); AskResultSchema below is used by tests.

export const LIMITS = {
  maxFileBytes: 25 * 1024 * 1024,
  maxPages: 150,
  maxCharsPerPage: 20_000,
  maxPagesPerBatch: 25,
  minCharsForText: 25,
} as const;

export const PutBudgetBody = z.object({ limit_usd: z.number().min(0) });

export const CreateDocumentBody = z.object({
  filename: z.string().min(1).max(255),
  size_bytes: z.number().int().min(0),
  page_count: z.number().int().min(1),
  pack: z.enum(['general', 'invoice']).default('general'),
});

export const PagesBody = z.object({
  pages: z
    .array(
      z.object({
        page_no: z.number().int().min(1),
        text: z.string(),
        needs_ocr: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(LIMITS.maxPagesPerBatch),
});

export const FinalizeBody = z.object({
  ocr: z.enum(['auto', 'skip']).default('skip'),
  auto_summary: z.boolean().default(false),
});

export const CreateChatBody = z.object({
  document_ids: z.array(z.string().min(1)).min(1).max(5),
  title: z.string().min(1).max(120).optional(),
});

export const AskBody = z.object({
  client_msg_id: z.string().min(1).max(100),
  content: z.string().min(1).max(4000),
  mode: z.enum(['answer', 'summarize', 'extract']).default('answer'),
  output: z.enum(['short', 'normal']).default('normal'),
});

export const ResumeBody = z.object({ action: z.enum(['shorter', 'full', 'cancel']) });

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    request_id: z.string(),
    call_id: z.string().optional(),
  }),
});

export const AskResultSchema = z.object({
  message: z.object({
    id: z.string(),
    role: z.string(),
    status: z.enum(['pending', 'done', 'paused', 'failed']),
    content: z.string(),
    citations: z.array(z.object({ document_id: z.string(), page_start: z.number(), page_end: z.number(), section_id: z.number() })),
    trace: z.array(z.object({ step: z.string(), label: z.string(), detail: z.string(), ms: z.number() })),
  }),
  usage: z
    .object({
      call_id: z.string(),
      model_used: z.string().nullable(),
      tier: z.string(),
      cost_usd: z.number(),
      cache_hit: z.boolean(),
      verify_status: z.string(),
    })
    .nullable(),
});
