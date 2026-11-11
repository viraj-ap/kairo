import { lazy, Suspense } from 'react';
import { useRoute } from './lib/router';
import { support } from './lib/support';
import { Dashboard } from './ui/Dashboard';
import { Unsupported } from './ui/Unsupported';
import { Toast } from './ui/Toast';

const Editor = lazy(() => import('./ui/Editor').then((m) => ({ default: m.Editor })));
const Bench = lazy(() => import('./bench/Bench').then((m) => ({ default: m.Bench })));

export function App() {
  const route = useRoute();
  if (route.name === 'editor' || route.name === 'bench') {
    if (!support.webcodecs || !support.opfs) return <Unsupported />;
  }
  return (
    <Suspense fallback={<Loading />}>
      {route.name === 'editor' ? (
        <Editor key={`${route.code}/${route.branch}`} code={route.code} branch={route.branch} />
      ) : route.name === 'bench' ? (
        <Bench />
      ) : (
        <Dashboard view={route.name} />
      )}
      <Toast />
    </Suspense>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="center-screen">
      <div className="spinner" />
      <p>{label}…</p>
    </div>
  );
}
