// Reads a model response body in whichever shape the provider used. Verified against the real Prune on
// 2026-10-31: OpenAI-style models answer in `choices`; Gemini models answer in Gemini's own `candidates`
// shape even through /v1/chat/completions. Other providers' shapes are unverified: an unrecognised shape
// yields an empty answer (never a crash), and the caller treats empty plus truncated as a failure to answer.

export interface ParsedCompletion {
  text: string;
  promptTokens: number | null;
  /** For Gemini this includes hidden "thinking" tokens, which are billed. */
  completionTokens: number | null;
  finishReason: string | null;
  /** The model stopped because it hit the output limit, so the answer may be cut off or empty. */
  truncated: boolean;
  model: string | null;
  shape: 'openai' | 'gemini' | 'unknown';
}

const TRUNCATED = new Set(['length', 'max_tokens', 'max_output_tokens']);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function parseCompletion(data: unknown): ParsedCompletion {
  const o = (typeof data === 'object' && data !== null ? data : {}) as Record<string, any>;
  let text = '';
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let finishReason: string | null = null;
  let model: string | null = typeof o['model'] === 'string' ? (o['model'] as string) : null;
  let shape: ParsedCompletion['shape'] = 'unknown';

  if (Array.isArray(o['choices'])) {
    shape = 'openai';
    const c = (o['choices'][0] ?? {}) as Record<string, any>;
    const content = c['message']?.content;
    text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p: any) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('') : '';
    finishReason = typeof c['finish_reason'] === 'string' ? c['finish_reason'] : null;
    promptTokens = num(o['usage']?.prompt_tokens);
    completionTokens = num(o['usage']?.completion_tokens);
  } else if (Array.isArray(o['candidates'])) {
    shape = 'gemini';
    const cand = (o['candidates'][0] ?? {}) as Record<string, any>;
    const parts: any[] = Array.isArray(cand['content']?.parts) ? cand['content'].parts : [];
    text = parts.filter((p) => p && typeof p.text === 'string' && !p.thought).map((p) => p.text as string).join('');
    finishReason = typeof cand['finishReason'] === 'string' ? cand['finishReason'] : null;
    const u = (o['usageMetadata'] ?? {}) as Record<string, unknown>;
    promptTokens = num(u['promptTokenCount']);
    const visible = num(u['candidatesTokenCount']);
    const thinking = num(u['thoughtsTokenCount']);
    completionTokens = visible === null && thinking === null ? null : (visible ?? 0) + (thinking ?? 0);
    model = typeof o['modelVersion'] === 'string' ? (o['modelVersion'] as string) : model;
  }

  return {
    text,
    promptTokens,
    completionTokens,
    finishReason,
    truncated: finishReason !== null && TRUNCATED.has(finishReason.toLowerCase()),
    model,
    shape,
  };
}
