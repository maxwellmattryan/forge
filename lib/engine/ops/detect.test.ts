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

test('merge.requiredChecks suggestions come from pull_request workflows', () => {
  const repo = tempRepo();
  try {
    const dir = path.join(repo.dir, '.github', 'workflows');
    fs.mkdirSync(dir, { recursive: true });
    const write = (file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);
    write(
      'ci.yml',
      [
        'name: CI',
        'on:',
        '  pull_request:',
        '  push:',
        '    branches: [main]',
        'jobs:',
        '  test:',
        '    runs-on: ubuntu-latest',
        '  lint:',
        '    name: Lint',
        '    runs-on: ubuntu-latest',
        '  build:',
        '    runs-on: ${{ matrix.os }}',
        '    strategy:',
        '      matrix:',
        '        os: [ubuntu-latest, macos-latest]',
        '  release:',
        "    if: github.ref == 'refs/heads/main'",
        '    runs-on: ubuntu-latest',
        '',
      ].join('\n'),
    );
    write('deploy.yml', ['on:', '  push:', 'jobs:', '  deploy:', '    runs-on: ubuntu-latest', ''].join('\n'));
    write('docs.yml', ['on:', '  pull_request:', '    paths:', "      - 'docs/**'", 'jobs:', '  docs:', '    runs-on: ubuntu-latest', ''].join('\n'));
    write('broken.yml', 'on: [pull_request\njobs: {\n');
    // The key would refuse these two, so they are not offered: a name over 100 characters, and one already listed from another file.
    write('extra.yml', ['on: pull_request', 'jobs:', '  long:', `    name: ${'x'.repeat(101)}`, '    runs-on: ubuntu-latest', '  lint:', '    name: Lint', '    runs-on: ubuntu-latest', ''].join('\n'));
    assert.deepEqual(detect(repo.dir).suggestions['merge.requiredChecks'], [
      { name: 'test', workflow: '.github/workflows/ci.yml' },
      { name: 'Lint', workflow: '.github/workflows/ci.yml' },
    ]);
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
