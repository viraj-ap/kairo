import { createContext, useContext } from 'react';
import type { EditorSession } from '../model/session';

export const SessionContext = createContext<EditorSession | null>(null);

export function useSession(): EditorSession {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside editor');
  return s;
}
