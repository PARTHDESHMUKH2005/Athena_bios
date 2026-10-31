import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChatPanel } from '../app/ChatPanel';
import { Drawer } from '../app/Drawer';
import type { PageRef, Tab } from '../app/Drawer';
import { Sidebar } from '../app/Sidebar';
import { UsagePanel } from '../app/UsagePanel';
import { useUpload } from '../app/useUpload';
import type { Pack } from '../app/useUpload';
import { Logo } from '../components/bits';
import { ApiError, api, download } from '../lib/api';
import { errorCopy, usd } from '../lib/format';
import { useSession } from '../lib/session';
import type { ChatDetail, ChatSummary, DocOut, Message, Mode } from '../lib/types';

interface Toast {
  kind: 'ok' | 'err';
  text: string;
}

export function Workspace() {
  const { budget, refreshBudget, end } = useSession();
  const nav = useNavigate();
  const [docs, setDocs] = useState<DocOut[]>([]);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [view, setView] = useState<'chat' | 'usage'>('chat');
  const [tab, setTab] = useState<Tab>('act');
  const [selMsg, setSelMsg] = useState<string | null>(null);
  const [pageRef, setPageRef] = useState<PageRef | null>(null);
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [usageKey, setUsageKey] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const active = useRef<string | null>(null);

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError) {
        if (e.code === 'unauthorized') {
          end();
          nav('/start');
          return;
        }
        const c = errorCopy(e.code);
        setToast({ kind: 'err', text: `${c.title}. ${e.code === 'validation_failed' || e.code === 'rate_limited' ? e.message : c.text}` });
      } else {
        setToast({ kind: 'err', text: 'Something went wrong. Please try again.' });
      }
    },
    [end, nav],
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === 'err' ? 8000 : 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const loadLists = useCallback(async () => {
    const [d, c] = await Promise.all([api.docs(), api.chats()]);
    setDocs(d.documents);
    setChats(c.chats);
    return d.documents;
  }, []);

  useEffect(() => {
    loadLists().catch(fail);
    void refreshBudget();
  }, [loadLists, refreshBudget, fail]);

  const selectChat = useCallback(
    async (id: string) => {
      active.current = id;
      setChatId(id);
      setView('chat');
      setSelMsg(null);
      setPageRef(null);
      setDetail(null);
      try {
        const d = await api.chat(id);
        if (active.current === id) {
          setDetail(d);
          const last = [...d.messages].reverse().find((m) => m.role === 'assistant');
          if (last) setSelMsg(last.id);
        }
      } catch (e) {
        fail(e);
      }
    },
    [fail],
  );

  const newChat = useCallback(
    async (ids: string[]) => {
      try {
        const r = await api.createChat(ids);
        await loadLists();
        await selectChat(r.chat_id);
      } catch (e) {
        fail(e);
      }
    },
    [fail, loadLists, selectChat],
  );

  const upload = useUpload(async () => void (await loadLists()));
  const finishUpload = useCallback(
    async (p: Promise<{ ok: boolean; message: string }>) => {
      const r = await p;
      setToast({ kind: r.ok ? 'ok' : 'err', text: r.message });
      if (r.ok) {
        const list = await loadLists();
        const newest = list.find((d) => d.status === 'ready' || d.status === 'partial');
        if (newest) await newChat([newest.id]);
      }
    },
    [loadLists, newChat],
  );

  /** Run a request while polling the chat, so the activity timeline fills in live. */
  const withLive = useCallback(
    async (cid: string, question: string | null, fn: () => Promise<void>) => {
      setSending(true);
      setPending(question);
      setTab('act');
      const poll = setInterval(() => {
        api.chat(cid).then((d) => {
          if (active.current !== cid) return;
          setDetail(d);
          const last = [...d.messages].reverse().find((m) => m.role === 'assistant');
          if (last?.status === 'pending') setSelMsg(last.id);
        }).catch(() => undefined);
      }, 800);
      try {
        await fn();
      } catch (e) {
        fail(e);
      } finally {
        clearInterval(poll);
        try {
          const d = await api.chat(cid);
          if (active.current === cid) {
            setDetail(d);
            const last = [...d.messages].reverse().find((m) => m.role === 'assistant');
            if (last) setSelMsg(last.id);
          }
        } catch {
          /* the next action refreshes it */
        }
        setSending(false);
        setPending(null);
        setUsageKey((k) => k + 1);
        void refreshBudget();
        void loadLists().catch(() => undefined);
      }
    },
    [fail, loadLists, refreshBudget],
  );

  const send = useCallback(
    (text: string, mode: Mode, short: boolean) => {
      if (!chatId || sending) return;
      void withLive(chatId, text, async () => {
        await api.ask(chatId, { client_msg_id: crypto.randomUUID(), content: text, mode, output: short ? 'short' : 'normal' });
      });
    },
    [chatId, sending, withLive],
  );
  const resume = useCallback(
    (messageId: string, action: 'shorter' | 'full' | 'cancel') => {
      if (!chatId || sending) return;
      void withLive(chatId, null, async () => {
        await api.resume(chatId, messageId, action);
      });
    },
    [chatId, sending, withLive],
  );
  const raise = useCallback(
    async (messageId: string, limit: number) => {
      if (!chatId) return;
      try {
        await api.setBudget(limit);
        await refreshBudget();
      } catch (e) {
        fail(e);
        return;
      }
      resume(messageId, 'full');
    },
    [chatId, fail, refreshBudget, resume],
  );
  const retry = useCallback(
    (callId: string) => {
      if (!chatId || sending) return;
      void withLive(chatId, null, async () => {
        await api.retry(callId);
      });
    },
    [chatId, sending, withLive],
  );

  const saveLimit = useCallback(
    async (v: number) => {
      try {
        await api.setBudget(v);
        await refreshBudget();
        setToast({ kind: 'ok', text: 'Limit updated.' });
      } catch (e) {
        fail(e);
      }
    },
    [fail, refreshBudget],
  );

  const deleteChat = useCallback(async () => {
    if (!chatId || !window.confirm("Delete this chat? This can't be undone.")) return;
    try {
      await api.deleteChat(chatId);
      active.current = null;
      setChatId(null);
      setDetail(null);
      await loadLists();
    } catch (e) {
      fail(e);
    }
  }, [chatId, fail, loadLists]);

  const deleteDoc = useCallback(
    async (id: string) => {
      try {
        await api.deleteDoc(id);
        await loadLists();
        if (detail?.documents.some((d) => d.id === id)) {
          active.current = null;
          setChatId(null);
          setDetail(null);
        }
      } catch (e) {
        fail(e);
      }
    },
    [detail, fail, loadLists],
  );

  const endSession = useCallback(
    async (wipe: boolean) => {
      if (wipe) {
        try {
          for (const c of (await api.chats()).chats) await api.deleteChat(c.id);
          for (const d of (await api.docs()).documents) await api.deleteDoc(d.id);
        } catch (e) {
          fail(e);
          return;
        }
      }
      end();
      nav('/');
    },
    [end, fail, nav],
  );

  const selected: Message | null = useMemo(() => {
    if (!detail) return null;
    return detail.messages.find((m) => m.id === selMsg) ?? [...detail.messages].reverse().find((m) => m.role === 'assistant') ?? null;
  }, [detail, selMsg]);
  const titles = useMemo(() => Object.fromEntries(chats.map((c) => [c.id, c.title])), [chats]);

  return (
    <div className="app">
      <header className="appbar">
        <Logo to="/" />
        <span className="label muted appbar__ws">Workspace</span>
        <div className="grow" />
        <div className="seg" role="tablist" aria-label="View">
          <button role="tab" aria-selected={view === 'chat'} onClick={() => setView('chat')}>Chat</button>
          <button role="tab" aria-selected={view === 'usage'} onClick={() => setView('usage')}>Usage</button>
        </div>
        {budget && <span className="foot appbar__bud" title="Spent of your spending limit">{usd(budget.spent_usd)} of {usd(budget.limit_usd)}</span>}
      </header>

      <div className="ws">
        <Sidebar
          docs={docs}
          chats={chats}
          activeChat={chatId}
          budget={budget}
          upload={upload.state}
          onUpload={(f: File, pack: Pack) => void finishUpload(upload.run(f, pack))}
          onSample={(k) => void finishUpload(upload.runSample(k))}
          onNewChat={(ids) => void newChat(ids)}
          onSelectChat={(id) => void selectChat(id)}
          onDeleteDoc={(id) => void deleteDoc(id)}
          onSaveLimit={saveLimit}
          onEnd={(wipe) => void endSession(wipe)}
        />

        {view === 'usage' ? (
          <UsagePanel refreshKey={usageKey} chatTitles={titles} onError={fail} />
        ) : detail ? (
          <ChatPanel
            detail={detail}
            sending={sending}
            pendingQuestion={pending}
            budget={budget}
            selectedId={selected?.id ?? null}
            onSend={send}
            onCite={(docId, page, m) => { setSelMsg(m.id); setPageRef({ docId, page }); setTab('page'); }}
            onOpen={(id, t) => { setSelMsg(id); setTab(t); }}
            onResume={resume}
            onRaise={raise}
            onRetry={retry}
            onSummary={async () => {
              try { download(await api.summary(detail.chat.id), 'athena-summary.md'); } catch (e) { fail(e); }
            }}
            onDeleteChat={() => void deleteChat()}
          />
        ) : (
          <div className="ws__main">
            <div className="chat" style={{ justifyContent: 'center' }}>
              <div className="card" style={{ maxWidth: 520, margin: '0 auto' }}>
                <h4>{docs.length ? 'Pick a document to ask about' : 'Start by adding a document'}</h4>
                <p className="muted">
                  {docs.length
                    ? 'Tick one or more ready documents on the left, then choose New chat. Or open an earlier chat.'
                    : 'Upload a text PDF, or try a sample. Athena reads it in your browser, indexes it with page numbers, and then answers with the cost and a receipt.'}
                </p>
                {!docs.length && (
                  <div className="row">
                    <button className="btn btn--sm" disabled={!!upload.state} onClick={() => void finishUpload(upload.runSample('agreement'))}>Try a sample contract</button>
                    <button className="btn btn--ghost btn--sm" disabled={!!upload.state} onClick={() => void finishUpload(upload.runSample('invoice'))}>Try a sample invoice</button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <Drawer tab={tab} onTab={setTab} message={selected} docs={docs} pageRef={pageRef} onPage={setPageRef} onError={fail} />
      </div>

      {toast && (
        <div className={`toast toast--${toast.kind}`} role={toast.kind === 'err' ? 'alert' : 'status'}>
          <span>{toast.text}</span>
          <button className="linkbtn" onClick={() => setToast(null)} aria-label="Dismiss">Dismiss</button>
        </div>
      )}
    </div>
  );
}
