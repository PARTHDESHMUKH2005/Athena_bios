PRAGMA foreign_keys = ON;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE budgets (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  limit_micro INTEGER NOT NULL CHECK (limit_micro >= 0),
  spent_micro INTEGER NOT NULL DEFAULT 0 CHECK (spent_micro >= 0),
  reserved_micro INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micro >= 0),
  per_call_cap_micro INTEGER NOT NULL CHECK (per_call_cap_micro >= 0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  pack TEXT NOT NULL DEFAULT 'general',
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created','uploading','pages_received','processing','ready','partial','failed')),
  page_count INTEGER NOT NULL CHECK (page_count > 0),
  pages_received INTEGER NOT NULL DEFAULT 0,
  scanned_pages INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT,
  workflow_instance_id TEXT,
  summary_text TEXT,
  summary_call_id TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_documents_ws ON documents(workspace_id, created_at DESC);

CREATE TABLE pages (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_no INTEGER NOT NULL CHECK (page_no > 0),
  text TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'text' CHECK (source IN ('text','ocr','empty')),
  needs_ocr INTEGER NOT NULL DEFAULT 0 CHECK (needs_ocr IN (0,1)),
  ocr_status TEXT NOT NULL DEFAULT 'none'
    CHECK (ocr_status IN ('none','pending','done','skipped_budget','skipped_cap','failed')),
  image_key TEXT,
  PRIMARY KEY (document_id, page_no)
);

CREATE TABLE sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  page_start INTEGER NOT NULL,
  page_end INTEGER NOT NULL,
  token_est INTEGER NOT NULL,
  UNIQUE (document_id, ordinal)
);

CREATE VIRTUAL TABLE sections_fts USING fts5(
  title, text, content='sections', content_rowid='id'
);
CREATE TRIGGER sections_ai AFTER INSERT ON sections BEGIN
  INSERT INTO sections_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
END;
CREATE TRIGGER sections_ad AFTER DELETE ON sections BEGIN
  INSERT INTO sections_fts(sections_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
END;
CREATE TRIGGER sections_au AFTER UPDATE ON sections BEGIN
  INSERT INTO sections_fts(sections_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
  INSERT INTO sections_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
END;

CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New chat',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_chats_ws ON chats(workspace_id, updated_at DESC);

CREATE TABLE chat_documents (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  PRIMARY KEY (chat_id, document_id)
);

CREATE TABLE llm_calls (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  purpose TEXT NOT NULL
    CHECK (purpose IN ('answer','summarize','extract','ocr','memory_summary','repair')),
  workload TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('economy','standard','strong')),
  model_requested TEXT NOT NULL,
  model_used TEXT,
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved','sent','ok','failed','unknown_cost','blocked_shield','budget_stopped')),
  attempt INTEGER NOT NULL DEFAULT 1,
  est_micro INTEGER NOT NULL DEFAULT 0,
  cost_micro INTEGER,
  cost_without_prune_micro INTEGER,
  cache_hit INTEGER CHECK (cache_hit IN (0,1)),
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  receipt_json TEXT,
  verify_status TEXT NOT NULL DEFAULT 'missing'
    CHECK (verify_status IN ('verified','failed','unverified','missing')),
  error_class TEXT,
  error_detail TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX idx_calls_ws ON llm_calls(workspace_id, created_at DESC);
CREATE INDEX idx_calls_chat ON llm_calls(chat_id, created_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','note')),
  content TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'answer' CHECK (mode IN ('answer','summarize','extract')),
  client_msg_id TEXT,
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('pending','done','paused','failed')),
  call_id TEXT REFERENCES llm_calls(id) ON DELETE SET NULL,
  model_used TEXT,
  citations_json TEXT,
  pause_json TEXT,
  trace_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (chat_id, client_msg_id)
);
CREATE INDEX idx_messages_chat ON messages(chat_id, created_at);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  content, content='messages', content_rowid='rowid'
);
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TABLE summaries (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  covers_until INTEGER NOT NULL,
  text TEXT NOT NULL,
  call_id TEXT REFERENCES llm_calls(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_summaries_chat ON summaries(chat_id, created_at DESC);

CREATE TABLE rate_limits (
  workspace_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, bucket, window_start)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT,
  type TEXT NOT NULL,
  ref_id TEXT,
  detail_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_events_ref ON events(ref_id, created_at);

INSERT INTO settings(key, value, updated_at) VALUES ('kill_switch', '0', 0);
