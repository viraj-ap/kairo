/** Projects this browser has opened, for the dashboard. The room itself is the source of truth. */

export interface ProjectEntry {
  code: string;
  name: string;
  updatedAt: number;
  durationFrames: number;
  fps: number;
}

const KEY = 'kairo.projects';

export function listProjects(): ProjectEntry[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]') as ProjectEntry[];
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function upsertProject(p: Partial<ProjectEntry> & { code: string }) {
  const list = listProjects();
  const i = list.findIndex((x) => x.code === p.code);
  const prev = i >= 0 ? list[i] : { code: p.code, name: 'Untitled project', updatedAt: Date.now(), durationFrames: 0, fps: 30 };
  const next = { ...prev, ...p, updatedAt: p.updatedAt ?? Date.now() };
  if (i >= 0) list[i] = next;
  else list.push(next);
  save(list);
}

export function removeProject(code: string) {
  save(listProjects().filter((p) => p.code !== code));
}

function save(list: ProjectEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
}
