import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'dashboard' }
  | { name: 'projects' }
  | { name: 'editor'; code: string; branch: string }
  | { name: 'bench' };

export function parseRoute(path: string): Route {
  const m = path.match(/^\/p\/([^/]+)(?:\/b\/([^/]+))?\/?$/);
  if (m) return { name: 'editor', code: decodeURIComponent(m[1]).toUpperCase(), branch: m[2] ? decodeURIComponent(m[2]) : 'main' };
  if (path.startsWith('/projects')) return { name: 'projects' };
  if (path.startsWith('/bench')) return { name: 'bench' };
  return { name: 'dashboard' };
}

export const editorPath = (code: string, branch = 'main') =>
  branch === 'main' ? `/p/${code}` : `/p/${code}/b/${encodeURIComponent(branch)}`;

export function navigate(path: string) {
  if (location.pathname === path) return;
  history.pushState(null, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
}

const subscribe = (cb: () => void) => {
  addEventListener('popstate', cb);
  return () => removeEventListener('popstate', cb);
};

export function useRoute(): Route {
  const path = useSyncExternalStore(subscribe, () => location.pathname);
  return parseRoute(path);
}
