import { describe, expect, it } from 'vitest';
import { describeConflict, describeShift, shortTime } from '../src/model/conflicts';

const w = { name: 'Intro', fps: 30, trackName: (id: string) => ({ v2: 'V2' })[id] ?? id, mainAuthor: 'Sam', branchAuthor: 'You' };

describe('plain-language conflicts', () => {
  it('formats short timecodes', () => {
    expect(shortTime(45 * 30, 30)).toBe('0:45');
    expect(shortTime(60 * 30, 30)).toBe('1:00');
    expect(shortTime(45, 30)).toBe('0:01.5');
  });

  it('describes a move conflict like an editor would', () => {
    const d = describeConflict({ field: 'start', main: 1800, branch: 1350 }, w);
    expect(d.line).toBe("You moved 'Intro' to 0:45 · Sam moved it to 1:00");
    expect(d.main).toBe("Sam moved 'Intro' to 1:00");
    expect(d.branch).toBe("You moved 'Intro' to 0:45");
  });

  it('describes track, opacity, transition and effect conflicts', () => {
    expect(describeConflict({ field: 'trackId', main: 'v1', branch: 'v2' }, w).branch).toBe("You moved 'Intro' to track V2");
    expect(describeConflict({ field: 'opacity', main: 0.5, branch: 0.25 }, w).line).toBe("You set 'Intro' to 25% opacity · Sam set it to 50% opacity");
    expect(describeConflict({ field: 'transitionIn', main: null, branch: { kind: 'wipe', duration: 10 } }, w).line).toBe(
      "You gave 'Intro' a wipe transition · Sam removed the transition from it",
    );
    expect(describeConflict({ field: 'effect', main: 'sepia', branch: 'duotone' }, w).branch).toBe("You applied the duotone effect to 'Intro'");
  });

  it('describes delete vs edit', () => {
    expect(describeConflict({ field: '*', main: null, branch: { start: 1 } }, w).line).toBe("You edited 'Intro' · Sam deleted it");
    expect(describeConflict({ field: '*', main: { start: 1 }, branch: null }, w).line).toBe("You deleted 'Intro' · Sam edited it");
  });

  it('labels grouped shifts', () => {
    expect(describeShift(12, 60, 30, ['V1'])).toBe('Shifted 12 clips +2.0 s on V1');
    expect(describeShift(3, -15, 30, ['V1', 'Titles'])).toBe('Shifted 3 clips −0.5 s on V1, Titles');
  });
});
