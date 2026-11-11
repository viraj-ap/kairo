/**
 * Project secrets. The key travels only in invite links' #fragment (never sent to a
 * server) and in this browser's localStorage, keyed by room code.
 */
import { generateProjectKey, isProjectKey } from '../sync/crypto';
import { editorPath } from './router';

const STORE = 'kairo.keys';

function all(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '{}');
  } catch {
    return {};
  }
}

export function getProjectKey(code: string): string | null {
  return all()[code] ?? null;
}

export function setProjectKey(code: string, key: string) {
  const m = all();
  m[code] = key;
  try {
    localStorage.setItem(STORE, JSON.stringify(m));
  } catch {
    /* storage unavailable */
  }
}

export function createProjectKey(code: string): string {
  const k = generateProjectKey();
  setProjectKey(code, k);
  return k;
}

/** `#k=<key>` from the current URL, if present and valid. */
export function keyFromHash(hash = location.hash): string | null {
  const k = new URLSearchParams(hash.replace(/^#/, '')).get('k');
  return k && isProjectKey(k) ? k : null;
}

export function inviteLink(code: string, branch = 'main'): string {
  const key = getProjectKey(code);
  return `${location.origin}${editorPath(code, branch)}${key ? `#k=${key}` : ''}`;
}

/** Accept a full invite link (or "/p/CODE#k=…") and return its parts. */
export function parseInvite(text: string): { code: string; branch: string; key: string } | null {
  const m = text.trim().match(/\/p\/(KAI-[2-9A-HJ-NP-Z]{5})(?:\/b\/([^/#?\s]+))?[^#]*#k=([A-Za-z0-9_-]{43})/i);
  if (!m || !isProjectKey(m[3])) return null;
  return { code: m[1].toUpperCase(), branch: m[2] ? decodeURIComponent(m[2]) : 'main', key: m[3] };
}
