/** Local identity shown to collaborators. There are no accounts in the MVP. */

export interface Identity {
  name: string;
  color: string;
}

export const PEER_COLORS = ['#18ff7a', '#00c8ff', '#7c6bff', '#ff6bb5', '#ffb547', '#ff6b5a', '#5af0d6', '#c9f24a'];

const KEY = 'kairo.identity';

export function loadIdentity(): Identity {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (saved?.name) return saved;
  } catch {
    /* fall through */
  }
  const id: Identity = {
    name: `Guest ${Math.floor(1000 + Math.random() * 9000)}`,
    color: PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)],
  };
  saveIdentity(id);
  return id;
}

export function saveIdentity(id: Identity) {
  try {
    localStorage.setItem(KEY, JSON.stringify(id));
  } catch {
    /* storage unavailable */
  }
}
