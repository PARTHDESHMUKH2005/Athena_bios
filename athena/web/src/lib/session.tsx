import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, api, tokenStore } from './api';
import type { Budget } from './types';

interface SessionValue {
  /** null while checking a saved token, false when there is none or it expired. */
  signedIn: boolean | null;
  budget: Budget | null;
  refreshBudget: () => Promise<void>;
  start: (limitUsd: number) => Promise<void>;
  end: () => void;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [signedIn, setSignedIn] = useState<boolean | null>(tokenStore.get() ? null : false);
  const [budget, setBudget] = useState<Budget | null>(null);

  const refreshBudget = useCallback(async () => {
    try {
      setBudget(await api.budget());
      setSignedIn(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'unauthorized') {
        tokenStore.clear();
        setSignedIn(false);
        setBudget(null);
      }
    }
  }, []);

  useEffect(() => {
    if (tokenStore.get()) void refreshBudget();
  }, [refreshBudget]);

  const start = useCallback(async (limitUsd: number) => {
    const s = await api.session();
    tokenStore.set(s.token);
    const b = limitUsd !== s.budget.limit_usd ? await api.setBudget(limitUsd) : s.budget;
    setBudget(b);
    setSignedIn(true);
  }, []);

  const end = useCallback(() => {
    tokenStore.clear();
    setBudget(null);
    setSignedIn(false);
  }, []);

  const value = useMemo(() => ({ signedIn, budget, refreshBudget, start, end }), [signedIn, budget, refreshBudget, start, end]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
