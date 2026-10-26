// A project whose root releases with `release.mechanism: script`, and the fakes `forge release run` takes in
// process: a fake release script that logs each call, a git reader whose preflight passes, and a spawn that
// records each step's argv. Import it through test/helpers.ts.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { BIN } from './cli.ts';

/** The release block the project's .forge/config.yml gets. */
export const SCRIPT_RELEASE = ['release:', '  interim: local', '  versioning: semver', '  mechanism: script', '  script: scripts/release.mjs', '  registry: none', '  cadence: manual', '  publish: confirm'];

/**
 * The fake release script. It appends `{argv, cwd, execPath, token}` to `scripts/calls.log` (token: whether a
 * credential variable reached it). `--draft-notes` prints a fixed draft from 1.0.0, honouring `--bump`, or
 * misbehaves as `scripts/mode` says; `--check merged` exits 0 only while `scripts/merged` exists.
 */
const FAKE_SCRIPT = `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify({ argv, cwd: process.cwd(), execPath: process.execPath, token: process.env.FORGE_FAKE_RELEASE_TOKEN !== undefined }) + '\\n');
const mode = fs.existsSync(path.join(dir, 'mode')) ? fs.readFileSync(path.join(dir, 'mode'), 'utf8').trim() : 'ok';
if (argv[0] === '--draft-notes') {
  if (mode === 'fail') {
    process.stderr.write('drafting\\nrelease: nothing to release: no commits since v1.0.0\\n');
    process.exit(1);
  }
  if (mode === 'text') {
    process.stdout.write('not json\\n');
    process.exit(0);
  }
  const bump = argv[2] ?? 'minor';
  const next = { patch: '1.0.1', minor: '1.1.0', major: '2.0.0' }[bump];
  const out = { current: '1.0.0', next, bump, inferred: 'minor', reasons: ['1 of 1 commits are not fixes, such as "feat: x"'], since: 'v1.0.0', draft: '## ' + next + '\\n\\n<!-- Drafted from the commits since v1.0.0. -->\\n- feat: x' };
  if (mode === 'bad-next') out.next = '1.1';
  if (mode === 'bad-bump') out.bump = 'huge';
  if (mode === 'bad-draft') out.draft = '## 9.9.9\\n';
  if (mode === 'many-reasons') out.reasons = ['a', 'b', 'c', 'd', 'e', 'f'];
  process.stdout.write(JSON.stringify(out) + '\\n');
  process.exit(0);
}
if (argv[0] === '--check') {
  if (fs.existsSync(path.join(dir, 'merged'))) process.exit(0);
  process.stderr.write('release: there is no release PR from release/v' + argv[2] + ' into main\\n');
  process.exit(1);
}
`;

/** Replaces the top-level `release:` block of the project's config.yml with `lines`. */
export function setReleaseBlock(dir: string, lines: string[]): void {
  const file = path.join(dir, '.forge', 'config.yml');
  const text = fs.readFileSync(file, 'utf8');
  const next = text.replace(/^release:\n(?: {2}.*\n)*/m, `${lines.join('\n')}\n`);
  if (next === text) throw new Error('no release: block in config.yml');
  fs.writeFileSync(file, next);
}

/** `forge init write` into `dir`, the fake script at scripts/release.mjs, and the script release block. */
export function initScriptProject(dir: string): void {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, '{}');
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'release.mjs'), FAKE_SCRIPT);
  fs.writeFileSync(path.join(dir, 'package.json'), '{\n  "name": "app",\n  "version": "1.0.0"\n}\n');
  setReleaseBlock(dir, SCRIPT_RELEASE);
}

/** Each call the fake script logged, oldest first. */
export function scriptCalls(dir: string): { argv: string[]; cwd: string; execPath: string; token: boolean }[] {
  const log = path.join(dir, 'scripts', 'calls.log');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** A git reader for `forge release run`'s preflight: the clone is on `base`, clean, and level with its remote. */
export const readyGit = (base: string) => (_dir: string, args: string[]) => {
  if (args[0] === 'symbolic-ref') return { ok: true, stdout: `${base}\n` };
  if (args[0] === 'rev-parse') return { ok: true, stdout: `${'a'.repeat(40)}\n` };
  return { ok: true, stdout: '' };
};

/** A spawn that records each step's argv and exits 0 on the next tick. */
export function recordingSpawn(): { spawn: any; calls: string[][] } {
  const calls: string[][] = [];
  const spawn = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  return { spawn, calls };
}
