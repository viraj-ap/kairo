const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function random(n: number, alphabet = ALPHABET): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

/** Room codes like KAI-7K2QX. */
export const newRoomCode = () => `KAI-${random(5)}`;

export const isRoomCode = (s: string) => /^KAI-[2-9A-HJ-NP-Z]{5}$/.test(s.trim().toUpperCase());

export const newId = (prefix = '') => prefix + random(10, 'abcdefghijkmnpqrstuvwxyz23456789');

export const roomId = (code: string, branch = 'main') => `kairo:${code}:${branch}`;

export function slugifyBranch(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'branch'
  );
}
