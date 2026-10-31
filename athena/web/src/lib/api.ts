import type { AppConfig, AskResult, Budget, ChatDetail, ChatSummary, DocOut, Mode, ReceiptViewFull, UsageReport, VerifyResult } from './types';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
const TOKEN_KEY = 'athena.token';

// localStorage can throw (private windows, blocked storage), so keep an in-memory fallback.
let memoryToken: string | null = null;
export const tokenStore = {
  get(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY) ?? memoryToken;
    } catch {
      return memoryToken;
    }
  },
  set(t: string) {
    memoryToken = t;
    try {
      localStorage.setItem(TOKEN_KEY, t);
    } catch {
      /* in-memory only */
    }
  },
  clear() {
    memoryToken = null;
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  },
};

export class ApiError extends Error {
  code: string;
  status: number;
  retryable: boolean;
  callId?: string;
  constructor(code: string, message: string, status: number, retryable: boolean, callId?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.callId = callId;
  }
}

interface Opts {
  body?: unknown;
  raw?: BodyInit;
  contentType?: string;
  auth?: boolean;
  blob?: boolean;
}

async function request<T>(method: string, path: string, opts: Opts = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = tokenStore.get();
  if (opts.auth !== false && token) headers['authorization'] = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (opts.raw !== undefined) {
    body = opts.raw;
    if (opts.contentType) headers['content-type'] = opts.contentType;
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await fetch(BASE + path, { method, headers, body });
  } catch {
    throw new ApiError('network', "Can't reach Athena. Check your connection and try again.", 0, true);
  }
  if (!res.ok) {
    let code = 'internal';
    let message = 'Something went wrong on our side. Your documents are saved.';
    let retryable = false;
    let callId: string | undefined;
    try {
      const j = (await res.json()) as { error?: { code: string; message: string; retryable: boolean; call_id?: string } };
      if (j.error) ({ code, message, retryable } = j.error), (callId = j.error.call_id);
    } catch {
      /* not JSON */
    }
    throw new ApiError(code, message, res.status, retryable, callId);
  }
  if (opts.blob) return (await res.blob()) as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export const api = {
  health: () => request<{ ok: boolean; mock_prune: boolean; kill_switch: boolean }>('GET', '/api/health', { auth: false }),
  session: () => request<{ workspace_id: string; token: string; budget: Budget }>('POST', '/api/session', { body: {}, auth: false }),
  config: () => request<AppConfig>('GET', '/api/config'),
  budget: () => request<Budget>('GET', '/api/budget'),
  setBudget: (limit_usd: number) => request<Budget>('PUT', '/api/budget', { body: { limit_usd } }),

  docs: () => request<{ documents: DocOut[] }>('GET', '/api/documents'),
  doc: (id: string) => request<{ document: DocOut }>('GET', `/api/documents/${id}`),
  createDoc: (b: { filename: string; size_bytes: number; page_count: number; pack: 'general' | 'invoice' }) =>
    request<{ document_id: string }>('POST', '/api/documents', { body: b }),
  uploadFile: (id: string, file: Blob) => request<{ size_bytes: number }>('PUT', `/api/documents/${id}/file`, { raw: file, contentType: 'application/pdf' }),
  putPages: (id: string, pages: { page_no: number; text: string }[]) =>
    request<{ pages_received: number; scanned_pages: number }>('POST', `/api/documents/${id}/pages`, { body: { pages } }),
  finalize: (id: string) => request<{ status: string; sections: number }>('POST', `/api/documents/${id}/finalize`, { body: { ocr: 'skip', auto_summary: false } }),
  deleteDoc: (id: string) => request<{ deleted: boolean }>('DELETE', `/api/documents/${id}`),
  page: (id: string, n: number) => request<{ page_no: number; text: string; source: string }>('GET', `/api/documents/${id}/pages/${n}`),
  file: (id: string) => request<Blob>('GET', `/api/documents/${id}/file`, { blob: true }),

  chats: () => request<{ chats: ChatSummary[] }>('GET', '/api/chats'),
  createChat: (document_ids: string[], title?: string) => request<{ chat_id: string }>('POST', '/api/chats', { body: { document_ids, title } }),
  chat: (id: string) => request<ChatDetail>('GET', `/api/chats/${id}`),
  deleteChat: (id: string) => request<{ deleted: boolean }>('DELETE', `/api/chats/${id}`),
  ask: (chatId: string, b: { client_msg_id: string; content: string; mode: Mode; output: 'short' | 'normal' }) =>
    request<AskResult>('POST', `/api/chats/${chatId}/messages`, { body: b }),
  resume: (chatId: string, messageId: string, action: 'shorter' | 'full' | 'cancel') =>
    request<AskResult>('POST', `/api/chats/${chatId}/messages/${messageId}/resume`, { body: { action } }),
  summary: (chatId: string) => request<Blob>('GET', `/api/chats/${chatId}/summary`, { blob: true }),

  receipt: (callId: string) => request<ReceiptViewFull>('GET', `/api/receipts/${callId}`),
  verify: (callId: string) => request<VerifyResult>('POST', `/api/receipts/${callId}/verify`, { body: {} }),
  /** Check an edited copy of a receipt (the tamper demo). The server never saves it. */
  verifyOverride: (callId: string, receiptText: string) =>
    request<VerifyResult>('POST', `/api/receipts/${callId}/verify`, { body: { receipt_override_raw: receiptText } }),
  retry: (callId: string) => request<AskResult>('POST', `/api/calls/${callId}/retry`, { body: {} }),
  usage: () => request<UsageReport>('GET', '/api/usage'),
  exportReceipts: () => request<Blob>('GET', '/api/export/receipts.jsonl', { blob: true }),
};

/** Save a Blob as a file download. */
export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
