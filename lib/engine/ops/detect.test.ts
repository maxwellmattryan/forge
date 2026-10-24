// What `forge init detect` proposes, on a scratch repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from '../../../test/helpers.ts';
import { detect } from './detect.ts';

test('worktrees.copy suggestions leave out .env files', () => {
  const repo = tempRepo();
  try {
    fs.writeFileSync(path.join(repo.dir, '.gitignore'), 'CLAUDE.md\n.env.local\n');
    fs.writeFileSync(path.join(repo.dir, 'CLAUDE.md'), '# local notes\n');
    fs.writeFileSync(path.join(repo.dir, '.env.local'), 'DB_PASSWORD=local\n');
    const d = detect(repo.dir) as ReturnType<typeof detect> & { suggestions: Record<string, unknown> };
    assert.deepEqual(d.suggestions['worktrees.copy'], ['CLAUDE.md']);
    assert.deepEqual(d.untracked.env, ['.env.local']);
  } finally {
    repo.cleanup();
  }
});
