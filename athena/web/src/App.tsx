import { useEffect } from 'react';
import type { ReactElement } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useSession } from './lib/session';
import { Landing } from './pages/Landing';
import { Start } from './pages/Start';
import { Workspace } from './pages/Workspace';

function ScrollToTop() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (!hash) window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
}

function Guard({ children }: { children: ReactElement }) {
  const { signedIn } = useSession();
  if (signedIn === null) return <div className="boot" role="status">Loading your workspace…</div>;
  if (!signedIn) return <Navigate to="/start" replace />;
  return children;
}

export function App() {
  return (
    <>
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/start" element={<Start />} />
        <Route path="/app" element={<Guard><Workspace /></Guard>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
