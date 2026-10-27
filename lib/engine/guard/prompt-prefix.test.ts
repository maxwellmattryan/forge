// The trusted prefix: which files reach a role run's system prompt, in what order, which are refused,
// and how the content-addressed file under .forge/runtime/prompt-prefix/ is reused or replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoTemplate } from '../../../test/helpers.ts';
import { PREFIX_HEAD, PREFIX_MAX_BYTES, buildPrefix, prefixSources, rolePrefix } from './prompt-prefix.ts';
import { loadConfig, trustDigest } from '#core/config/load.ts';

const CONFIG = [
  'project:',
  '  instructions:',
  '    default:',
  '      - AGENTS.md',
  '      - CLAUDE.md',
  '    reviewer:',
  '      - docs/GUIDE.md',
  '      - AGENTS.md',
  '      - ./docs/GUIDE.md',
  '      - MISSING.md',
  '',
].join('\n');

const template = repoTemplate((dir) => {
  const put = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  put('.forge/config.yml', CONFIG);
  put('AGENTS.md', '# Agents\nRule one.\n');
  put('CLAUDE.md', '# Claude\n');
  // No trailing newline: the prefix adds one.
  put('docs/GUIDE.md', 'Guide text');
  put('.forge/notes/learnings.md', '# Learnings\n- lesson\n');
  put('.forge/notes/reviewer.md', '# Reviewer notes\n');
});

function scratch(t: { after: (fn: () => void) => void }) {
  const repo = template();
  t.after(repo.cleanup);
  const root = repo.dir;
  const config = loadConfig(root).config;
  const write = (rel: string, text: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  return { root, config, write };
}

const section = (rel: string, text: string) => `\n----- ${rel} -----\n\n${text}`;
const headers = (bytes: Buffer) => [...bytes.toString('utf8').matchAll(/^----- (.*) -----$/gm)].map((m) => m[1]);
const bytesOf = (r: ReturnType<typeof buildPrefix>): Buffer => {
  assert.ok(r && 'bytes' in r, JSON.stringify(r));
  return r.bytes;
};

test('the prefix holds the trusted sources in a fixed order', (t) => {
  const s = scratch(t);
  const built = buildPrefix(s.root, s.config, 'reviewer:code', []);
  const want = PREFIX_HEAD + section('docs/GUIDE.md', 'Guide text\n') + section('AGENTS.md', '# Agents\nRule one.\n') + section('.forge/notes/learnings.md', '# Learnings\n- lesson\n') + section('.forge/notes/reviewer.md', '# Reviewer notes\n');
  assert.equal(bytesOf(built).toString('utf8'), want);
  assert.deepEqual((built as { sources: string[] }).sources, ['docs/GUIDE.md', 'AGENTS.md', '.forge/notes/learnings.md', '.forge/notes/reviewer.md'], './docs/GUIDE.md is the same source, MISSING.md is skipped');
  assert.ok(PREFIX_HEAD.endsWith('.\n') && !PREFIX_HEAD.endsWith('\n\n'), 'the head ends with one newline');

  // A role without its own list takes the default; no notes file for it, so none in the prefix.
  assert.deepEqual(headers(bytesOf(buildPrefix(s.root, s.config, 'builder', []))), ['AGENTS.md', 'CLAUDE.md', '.forge/notes/learnings.md']);
  // A role base that could climb or hide a separator names no notes file.
  for (const role of ['../x', 'Reviewer', 'a/b', '']) assert.ok(!prefixSources(s.root, s.config, role).some((x) => x.kind === 'notes'), JSON.stringify(role));

  // No source at all: no prefix and no refusal.
  const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-prefix-empty-')));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  assert.equal(buildPrefix(empty, s.config, 'reviewer:code', []), null);
  assert.deepEqual(rolePrefix(empty, s.config, 'reviewer:code', []), { file: null, refused: null });
  assert.equal(fs.existsSync(path.join(empty, '.forge')), false, 'nothing written');
});

test('only instruction files, learnings and role notes reach the prefix', (t) => {
  const s = scratch(t);
  const job = '.forge/jobs/some-job-1';
  const planted: Record<string, string> = {
    [`${job}/request.md`]: 'MARK-REQUEST',
    [`${job}/spec.md`]: 'MARK-SPEC',
    [`${job}/build.md`]: 'MARK-BUILD',
    [`${job}/pr-feedback.md`]: 'MARK-PR-FEEDBACK',
    [`${job}/review/round-1/code.md`]: 'MARK-REVIEW',
    [`${job}/verify/round-1.md`]: 'MARK-VERIFY',
    '.forge/reviewers/code.md': 'MARK-CHECKLIST',
  };
  for (const [rel, text] of Object.entries(planted)) s.write(rel, `${text}\n`);
  const bytes = bytesOf(buildPrefix(s.root, s.config, 'reviewer:code', [path.join(s.root, '.forge', 'jobs')]));
  const text = bytes.toString('utf8');
  for (const marker of Object.values(planted)) assert.ok(!text.includes(marker), marker);
  assert.deepEqual(headers(bytes), ['docs/GUIDE.md', 'AGENTS.md', '.forge/notes/learnings.md', '.forge/notes/reviewer.md']);
});

test('every lens and every job gets the same bytes', (t) => {
  const s = scratch(t);
  const jobs = [path.join(s.root, '.forge', 'jobs')];
  s.write('.forge/jobs/first-job/request.md', 'one\n');
  const lenses = ['reviewer:code', 'reviewer:security', 'reviewer:docs'].map((role) => ({ bytes: bytesOf(buildPrefix(s.root, s.config, role, jobs)), file: rolePrefix(s.root, s.config, role, jobs).file }));
  for (const l of lenses.slice(1)) {
    assert.ok(l.bytes.equals(lenses[0].bytes), 'same bytes for every lens');
    assert.equal(l.file, lenses[0].file, 'same file for every lens');
  }
  // A second job of the same checkout: nothing about it enters the prefix.
  s.write('.forge/jobs/second-job/request.md', 'two\n');
  const again = rolePrefix(s.root, s.config, 'reviewer:code', jobs);
  assert.equal(again.file, lenses[0].file);
  assert.ok(fs.readFileSync(again.file!).equals(lenses[0].bytes));
  const text = lenses[0].bytes.toString('utf8');
  for (const no of [s.root, fs.realpathSync(s.root), 'first-job', 'second-job']) assert.ok(!text.includes(no), no);

  s.write('.forge/notes/builder.md', '# Builder notes\n');
  const builder = bytesOf(buildPrefix(s.root, s.config, 'builder', jobs));
  assert.ok(!builder.equals(lenses[0].bytes), 'a builder with its own notes differs');
  assert.ok(headers(builder).includes('.forge/notes/builder.md'));
});

test('a planted symlink or non-file is refused', async (t) => {
  type Row = { name: string; role?: string; plant: (root: string) => void; config?: string; under?: (root: string) => string[]; want: RegExp };
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-prefix-outside-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const learnings = (root: string) => path.join(root, '.forge', 'notes', 'learnings.md');
  const rows: Row[] = [
    {
      name: 'learnings is a symlink to a job file',
      plant: (root) => {
        fs.mkdirSync(path.join(root, '.forge', 'jobs', 'x'), { recursive: true });
        fs.writeFileSync(path.join(root, '.forge', 'jobs', 'x', 'request.md'), 'agent text\n');
        fs.rmSync(learnings(root));
        fs.symlinkSync(path.join(root, '.forge', 'jobs', 'x', 'request.md'), learnings(root));
      },
      want: /^"\.forge\/notes\/learnings\.md" is a symlink, not a regular file$/,
    },
    {
      name: 'an instruction file is a symlink',
      plant: (root) => {
        fs.writeFileSync(path.join(outside, 'elsewhere.md'), 'x\n');
        fs.rmSync(path.join(root, 'AGENTS.md'));
        fs.symlinkSync(path.join(outside, 'elsewhere.md'), path.join(root, 'AGENTS.md'));
      },
      want: /^"AGENTS\.md" is a symlink/,
    },
    {
      name: 'learnings is a directory',
      plant: (root) => {
        fs.rmSync(learnings(root));
        fs.mkdirSync(learnings(root));
      },
      want: /^"\.forge\/notes\/learnings\.md" is not a regular file$/,
    },
    {
      name: 'learnings is a FIFO, refused without blocking',
      plant: (root) => {
        fs.rmSync(learnings(root));
        execFileSync('mkfifo', [learnings(root)]);
      },
      want: /^"\.forge\/notes\/learnings\.md" is not a regular file$/,
    },
    { name: 'the role notes are oversized', plant: (root) => fs.writeFileSync(path.join(root, '.forge', 'notes', 'reviewer.md'), 'x'.repeat(PREFIX_MAX_BYTES + 1)), want: /^"\.forge\/notes\/reviewer\.md" is larger than 256 KiB$/ },
    {
      name: '.forge/notes linked elsewhere',
      plant: (root) => {
        const notes = path.join(root, '.forge', 'notes');
        fs.cpSync(notes, path.join(outside, 'notes'), { recursive: true });
        fs.rmSync(notes, { recursive: true });
        fs.symlinkSync(path.join(outside, 'notes'), notes);
      },
      want: /^"\.forge\/notes\/learnings\.md" is reached through a symlinked directory/,
    },
    {
      name: 'the prefix as a whole is oversized',
      role: 'builder',
      plant: (root) => {
        fs.writeFileSync(path.join(root, 'AGENTS.md'), 'a'.repeat(PREFIX_MAX_BYTES / 2));
        fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'c'.repeat(PREFIX_MAX_BYTES / 2));
      },
      want: /^the prefix would be larger than 256 KiB$/,
    },
    // AC5: instruction entries that name agent-written text.
    {
      name: 'an instruction entry under .forge/jobs/',
      role: 'builder',
      config: 'project:\n  instructions:\n    - .forge/jobs/x/request.md\n',
      plant: (root) => {
        fs.mkdirSync(path.join(root, '.forge', 'jobs', 'x'), { recursive: true });
        fs.writeFileSync(path.join(root, '.forge', 'jobs', 'x', 'request.md'), 'agent text\n');
      },
      want: /^"\.forge\/jobs\/x\/request\.md" lies under \.forge\//,
    },
    {
      name: 'an instruction entry under a worktrees root nested in the checkout',
      role: 'builder',
      config: 'project:\n  instructions:\n    - AGENTS.md\n    - wt/job-a/AGENTS.md\n',
      under: (root) => [path.join(root, '.forge', 'jobs'), path.join(root, 'wt')],
      plant: (root) => {
        fs.mkdirSync(path.join(root, 'wt', 'job-a'), { recursive: true });
        fs.writeFileSync(path.join(root, 'wt', 'job-a', 'AGENTS.md'), 'branch text\n');
      },
      want: /^"wt\/job-a\/AGENTS\.md" lies under a folder role children write$/,
    },
  ];
  for (const row of rows) {
    const repo = template();
    try {
      if (row.config) fs.writeFileSync(path.join(repo.dir, '.forge', 'config.yml'), row.config);
      row.plant(repo.dir);
      const config = loadConfig(repo.dir).config;
      const under = row.under?.(repo.dir) ?? [path.join(repo.dir, '.forge', 'jobs')];
      const built = buildPrefix(repo.dir, config, row.role ?? 'reviewer:code', under);
      assert.ok(built && 'refused' in built, `${row.name}: ${JSON.stringify(built && 'sources' in built ? built.sources : built)}`);
      assert.match(built.refused, row.want, row.name);
      const pre = rolePrefix(repo.dir, config, row.role ?? 'reviewer:code', under);
      assert.deepEqual(pre, { file: null, refused: built.refused }, row.name);
      assert.equal(fs.existsSync(path.join(repo.dir, '.forge', 'runtime', 'prompt-prefix')), false, `${row.name}: no file written`);
    } finally {
      repo.cleanup();
    }
  }
});

test('the prefix file is reused only when its bytes match', (t) => {
  const s = scratch(t);
  const jobs = [path.join(s.root, '.forge', 'jobs')];
  const bytes = bytesOf(buildPrefix(s.root, s.config, 'reviewer:code', jobs));
  const dir = path.join(fs.realpathSync(s.root), '.forge', 'runtime', 'prompt-prefix');
  const file = path.join(dir, `${crypto.createHash('sha256').update(bytes).digest('hex')}.md`);

  const first = rolePrefix(s.root, s.config, 'reviewer:code', jobs);
  assert.deepEqual(first, { file, refused: null });
  assert.ok(fs.readFileSync(file).equals(bytes));
  assert.ok(path.relative(jobs[0], file).startsWith(`..${path.sep}`), 'outside the job folders root');

  // An identical regular file is left untouched.
  const old = new Date('2001-01-01T00:00:00Z');
  fs.utimesSync(file, old, old);
  const before = fs.statSync(file);
  assert.equal(rolePrefix(s.root, s.config, 'reviewer:code', jobs).file, file);
  const after = fs.statSync(file);
  assert.deepEqual([after.ino, after.mtimeMs], [before.ino, before.mtimeMs]);

  // Other bytes at the name are rewritten.
  fs.writeFileSync(file, 'tampered\n');
  assert.equal(rolePrefix(s.root, s.config, 'reviewer:code', jobs).file, file);
  assert.ok(fs.readFileSync(file).equals(bytes));

  // A symlink at the name is replaced, and its target left as it was.
  const target = path.join(s.root, '.forge', 'jobs', 'x', 'planted.md');
  s.write('.forge/jobs/x/planted.md', 'planted\n');
  fs.rmSync(file);
  fs.symlinkSync(target, file);
  assert.equal(rolePrefix(s.root, s.config, 'reviewer:code', jobs).file, file);
  assert.ok(fs.lstatSync(file).isFile() && fs.readFileSync(file).equals(bytes));
  assert.equal(fs.readFileSync(target, 'utf8'), 'planted\n');

  // A directory at the name can't be replaced: no prefix, and why.
  fs.rmSync(file);
  fs.mkdirSync(path.join(file, 'inner'), { recursive: true });
  const blocked = rolePrefix(s.root, s.config, 'reviewer:code', jobs);
  assert.equal(blocked.file, null);
  assert.match(blocked.refused ?? '', /^the prefix file can't be written: /);
});

test('every prefix source is under the trust digest', (t) => {
  const s = scratch(t);
  const built = buildPrefix(s.root, s.config, 'reviewer:code', []);
  const sources = (built as { sources: string[] }).sources;
  assert.deepEqual(sources, ['docs/GUIDE.md', 'AGENTS.md', '.forge/notes/learnings.md', '.forge/notes/reviewer.md']);
  let digest = trustDigest(s.root);
  for (const rel of sources) {
    fs.appendFileSync(path.join(s.root, rel), 'changed\n');
    const next = trustDigest(s.root);
    assert.notEqual(next, digest, rel);
    digest = next;
  }

  // On POSIX a `\` entry names a literal file, not docs/GUIDE.md: the prefix reads the file the digest hashes.
  if (path.sep !== '/') return;
  const b = scratch(t);
  fs.writeFileSync(path.join(b.root, '.forge', 'config.yml'), `project:\n  instructions:\n    - ${JSON.stringify('docs\\GUIDE.md')}\n`);
  const config = loadConfig(b.root).config;
  const guide = path.join(b.root, 'docs', 'GUIDE.md');
  // Only docs/GUIDE.md exists, so the entry names a missing file and nothing of docs/GUIDE.md reaches the prefix.
  const before = bytesOf(buildPrefix(b.root, config, 'builder', []));
  assert.deepEqual(headers(before), ['.forge/notes/learnings.md']);
  assert.ok(!before.toString('utf8').includes('Guide text'));
  fs.appendFileSync(guide, 'changed\n');
  assert.ok(bytesOf(buildPrefix(b.root, config, 'builder', [])).equals(before), 'docs/GUIDE.md is outside the prefix, as it is outside the digest');
  // With the literal file there, it is the source, and the digest covers it.
  b.write('docs\\GUIDE.md', 'Literal text\n');
  const literal = buildPrefix(b.root, config, 'builder', []);
  assert.deepEqual((literal as { sources: string[] }).sources, ['docs\\GUIDE.md', '.forge/notes/learnings.md']);
  assert.ok(bytesOf(literal).toString('utf8').includes('Literal text'));
  const base = trustDigest(b.root);
  fs.appendFileSync(path.join(b.root, 'docs\\GUIDE.md'), 'changed\n');
  assert.notEqual(trustDigest(b.root), base, 'the literal file is under the trust digest');
});
