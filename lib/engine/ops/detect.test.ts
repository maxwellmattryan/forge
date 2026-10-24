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

test('commandEnv.inherit suggestions come from .env.example names and the build tool', () => {
  const empty = tempRepo();
  const repo = tempRepo();
  try {
    assert.deepEqual(detect(empty.dir).suggestions['commandEnv.inherit'], []);
    fs.writeFileSync(path.join(repo.dir, '.env.example'), '# local settings\nDATABASE_URL=\nexport REDIS_URL=\nSTRIPE_SECRET_KEY=\nAPI_TOKEN=\nPORT=3000\nNODE_ENV=development\n\nnot an assignment\n');
    fs.writeFileSync(path.join(repo.dir, 'build.gradle.kts'), 'plugins { id("com.android.application") }\n');
    assert.deepEqual(detect(repo.dir).suggestions['commandEnv.inherit'], ['ANDROID_HOME', 'ANDROID_SDK_ROOT', 'DATABASE_URL', 'JAVA_HOME', 'REDIS_URL']);
  } finally {
    empty.cleanup();
    repo.cleanup();
  }
});
