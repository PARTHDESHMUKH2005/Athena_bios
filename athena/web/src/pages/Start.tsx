import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Art, Logo } from '../components/bits';
import { ApiError } from '../lib/api';
import { errorCopy } from '../lib/format';
import { useSession } from '../lib/session';

/** The sign-in screen's counterpart: there are no accounts, so this creates an anonymous workspace with a spending limit. */
export function Start() {
  const { signedIn, budget, start } = useSession();
  const nav = useNavigate();
  const [limit, setLimit] = useState('0.25');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const max = budget?.max_limit_usd ?? 1;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const v = Number(limit);
    if (!Number.isFinite(v) || v < 0) return setErr('Enter a spending limit of zero or more.');
    if (v > max) return setErr(`The limit can be at most $${max.toFixed(2)} for this demo.`);
    setBusy(true);
    setErr(null);
    try {
      await start(v);
      nav('/app');
    } catch (ex) {
      const c = errorCopy(ex instanceof ApiError ? ex.code : 'network');
      setErr(`${c.title}. ${c.text}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="startpage">
      <header className="wrap startpage__bar"><Logo /><Link className="btn btn--ghost btn--sm" to="/">Back to site</Link></header>
      <div className="wrap">
        <div className="start">
          <form className="start__form" onSubmit={submit} noValidate>
            <h1 className="h-md" style={{ fontSize: 'clamp(30px,3.4vw,46px)' }}>Start a workspace</h1>
            <p className="muted" style={{ maxWidth: '40ch' }}>No account. You get a private workspace in this browser and a spending limit you set. Athena will never go over it.</p>
            {signedIn && (
              <p className="notice" role="status">You already have a workspace in this browser. <Link to="/app"><b>Continue to it</b></Link>, or create a fresh one below.</p>
            )}
            <label className="field" htmlFor="limit">Spending limit (USD)
              <input id="limit" type="number" min="0" max={max} step="any" value={limit} onChange={(e) => setLimit(e.target.value)} inputMode="decimal" aria-describedby="limit-help" />
            </label>
            <p id="limit-help" className="muted" style={{ fontSize: 13, marginTop: -8 }}>A typical answer costs a fraction of a cent. The most this demo allows is ${max.toFixed(2)}.</p>
            {err && <p className="errtext" role="alert">{err}</p>}
            <button className="btn btn--accent" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create workspace'}</button>
            <p className="muted" style={{ fontSize: 13 }}>Your workspace token is kept in this browser. Delete your data any time from the workspace menu.</p>
          </form>
          <div className="start__art"><Art kind="streaks" /></div>
        </div>
      </div>
    </div>
  );
}
