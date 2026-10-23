import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { applyAllowlist, diffUnits, entropyOff, fingerprint, isPlaceholder, loadAllowlist, mask, parseAllowlist, refuseSecrets, scanBranch, scanPaths, scanUnits, secretsBlock, secretsOk, textUnit } from '#engine/guard/secrets.ts';
import { defaults } from '#core/config/load.ts';
import { createJob, jobDir } from '#core/job/store.ts';
import { recordKnown } from '#engine/guard/known-secrets.ts';
import { tempRepo } from './helpers.ts';
import { ALNUM, DIGITS, LOWER, UPPER, base64Of, hexOf, inContext, pem, pick, token } from './secret-fixtures.ts';
import type { TextUnit } from '#engine/guard/types.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const unit = (text: string, p = 'src/app.ts', file = true): TextUnit => ({ path: p, line: 1, text, file, commit: null });
const scan = (text: string, p?: string, file?: boolean) => scanUnits([unit(text, p, file)], { config: defaults() });
const kinds = (text: string, p?: string, file?: boolean) => scan(text, p, file).map((f) => f.kind);
const sha = (v: string) => `sha256:${createHash('sha256').update(v).digest('hex')}`;

test('provider patterns', () => {
  const t = token;
  const cases: [string, string][] = [
    ['aws-access-key', inContext.aws(t.aws())],
    ['github-token', `const gh = "${t.github()}";`],
    ['github-pat', `GH_TOKEN=${t.githubPat()}`],
    ['gitlab-token', `gitlab: ${t.gitlab()}`],
    ['slack-token', `slack ${t.slack()} here`],
    ['stripe-live-key', `stripe('${t.stripe()}')`],
    ['anthropic-key', `ANTHROPIC_API_KEY=${t.anthropic()}`],
    ['openai-key', `OPENAI_API_KEY=${t.openai()}`],
    ['google-api-key', `key: ${t.google()}`],
    ['bearer-token', inContext.bearer(t.bearer())],
    ['url-credential', inContext.urlQuery(t.urlPassword())],
    ['url-credential', inContext.urlUserinfo(t.urlPassword('userinfo'))],
    ['private-key', pem()],
  ];
  for (const [kind, line] of cases) {
    const found = scan(`// header\n${line}\n// footer`);
    assert.deepEqual(found.map((f) => [f.kind, f.line]), [[kind, 2]], `${kind}: ${found.map((f) => f.kind).join(',')}`);
  }
  // Near-misses: one character short, a test key, a reference, a short PEM body, a digit-free sk- body.
  const near = [
    inContext.aws(['AK', 'IA'].join('') + pick(UPPER + DIGITS, 15, 'aws15')),
    `stripe ${['sk', '_te', 'st_'].join('')}${pick(ALNUM, 24, 'test')}`,
    `token ${['gh', 'p_'].join('')}${pick(ALNUM, 35, 'gh35')}`,
    'curl -H "Authorization: Bearer ${TOKEN}"',
    'GET https://api.invalid/x?token=${T}',
    'https://u:${PASS}@h',
    pem('short', 0).replace('\n', `\n${pick(ALNUM, 40, 'shortbody')}\n`),
    `OPENAI_API_KEY=${['sk', '-'].join('')}${pick(UPPER + LOWER, 40, 'nodigit')}`,
  ];
  for (const line of near) assert.deepEqual(kinds(line, 'src/app.ts', false), [], line.slice(0, 40));
  // sk-ant- is only ever anthropic-key, even with a later sk- inside its body.
  const ant = ['sk', '-ant-'].join('') + 'api03-x-' + ['sk', '-'].join('') + pick(ALNUM, 40, 'inner') + '1';
  assert.deepEqual(kinds(`k = ${ant}`), ['anthropic-key']);
  // A PEM split over lines, or written with literal \n in JSON, is one finding at its BEGIN line.
  const block = pem('split', 3);
  assert.deepEqual(scan(`a\nb\n${block}\nc`).map((f) => [f.kind, f.line]), [['private-key', 3]]);
  const json = JSON.stringify({ key: block });
  assert.ok(json.includes('\\n'));
  assert.deepEqual(scan(`{\n  "x": 1,\n  "pem": ${JSON.stringify(json)}\n}`, 'cfg/key.json').map((f) => [f.kind, f.line]), [['private-key', 3]]);
  assert.equal(scan(json)[0].fingerprint, scan(block)[0].fingerprint, 'the body is the same key either way');
});

test('placeholders are not findings', () => {
  const ghx = ['gh', 'p_'].join('') + 'x'.repeat(36);
  const awsExample = ['AK', 'IA', 'IOSF', 'ODNN7', 'EXA', 'MPLE'].join('');
  const lines = [
    'GET /x?token=${API_TOKEN}',
    'GET /x?token=$API_TOKEN_VALUE',
    'GET /x?token=<token>&y=1',
    'GET /x?token={{token}}',
    `token: ${ghx}`,
    `aws = ${awsExample}`,
    'GET /login?password=changeme123',
    'GET /x?token=abababababab',
    'postgres://app:password@db/app',
  ];
  for (const l of lines) assert.deepEqual(kinds(l), [], l);
  for (const v of ['${X}', '$X', '<token>', '{{ token }}', '{user}', '{password}', '{database}', 'aaaabbbb', 'my-example-key-1234', 'PASSWORD', 'your_api_key_here', 'abc****def123']) assert.equal(isPlaceholder(v), true, v);
  // Only Forge's own url placeholders, not any `{name}`.
  for (const v of [token.github(), token.urlPassword(), '{zq7xkw3m}']) assert.equal(isPlaceholder(v), false, v);
});

test('entropy candidates and thresholds', () => {
  const b64 = base64Of('entropy-0');
  assert.equal(b64.length, 44);
  assert.deepEqual(kinds(`const k = "${b64}";`), ['high-entropy']);
  assert.deepEqual(kinds(`KEY = ${b64}`), ['high-entropy']);
  const hex = hexOf('hex');
  assert.deepEqual(kinds(`const token = "${hex}";`), ['high-entropy']);
  const not = [
    `sha = "${hex}"`,
    'id: "123e4567-e89b-12d3-a456-426614174000"',
    'slug: "secret-scanner-gate-in-verify-and-commit-hooks"',
    'path: "dashboard/src/components/threadpanel/secretnote"',
    `integrity: "sha512-${createHash('sha512').update('x').digest('base64')}"`,
    `blob: "${Array.from({ length: 7 }, (_, i) => base64Of(`blob${i}`)).join('').slice(0, 300)}"`,
    `short: "${base64Of('short').slice(0, 32)}"`,
    'word: "ThisIsACamelCaseWordWithNoDigitsAtAll"',
  ];
  for (const l of not) assert.deepEqual(kinds(l), [], l);
  // A 33-character value is a candidate; 32 is not.
  assert.deepEqual(kinds(`v = "${pick(ALNUM, 30, 'e33')}Ab1"`), ['high-entropy']);
});

test('entropy exemptions keep provider patterns', () => {
  const b64 = base64Of('entropy-0');
  const text = `"x": "${b64}",\nkey ${token.aws()}`;
  const config = { ...defaults(), worktrees: { ...defaults().worktrees, generated: ['dist/**'] } };
  for (const p of ['package-lock.json', 'web/a.min.js', 'dist/app.js', 'Cargo.lock', 'icons/a.svg']) {
    const found = scanUnits([unit(text, p)], { config });
    assert.deepEqual(found.map((f) => [f.kind, f.line]), [['aws-access-key', 2]], p);
  }
  assert.deepEqual(scan(`${text}\n\0`).map((f) => f.kind), ['aws-access-key'], 'NUL byte');
  assert.deepEqual(scan(text, 'src/app.ts').map((f) => f.kind).sort(), ['aws-access-key', 'high-entropy'], 'an ordinary file gets both');
  for (const label of ['(commit message abc)', '(pr body)', '(tracker comment)']) assert.deepEqual(kinds(text, label, false), ['aws-access-key'], label);
  assert.equal(entropyOff('a/b/yarn.lock', null), true);
  assert.equal(entropyOff('src/app.ts', null), false);
  // A diff file whose added lines hold a NUL keeps only the provider patterns.
  const diff = ['diff --git a/bin.dat b/bin.dat', '--- /dev/null', '+++ b/bin.dat', '@@ -0,0 +1,3 @@', `+"${b64}"`, '+\0\0', `+${token.aws()}`, ''].join('\n');
  const d = diffUnits(diff, 'staged');
  assert.deepEqual(scanUnits(d.units, { config: null }).map((f) => [f.kind, f.line, f.commit]), [['aws-access-key', 3, 'staged']]);
});

test('masking and fingerprints', () => {
  assert.equal(mask(['AK', 'IA'].join('') + '1234567890ABXY'), 'AKIA…XY');
  assert.equal(mask('hunter2x9'), 'hu…');
  assert.equal(mask('hunter2'), '…');
  assert.equal(mask('a`| ' + 'z'.repeat(12) + '\tq'), 'a???…?q');
  assert.equal(mask('|\x01' + 'z'.repeat(8)), '??…');
  const v = token.github();
  const [f] = scan(`x ${v}`);
  assert.equal(f.fingerprint, sha(v));
  assert.equal(f.excerpt, `${v.slice(0, 4)}…${v.slice(-2)}`);
  assert.equal(fingerprint(v), sha(v));
  assert.match(f.fingerprint, /^sha256:[0-9a-f]{64}$/);
  const block = pem('fp', 2);
  const body = block.split('\n').slice(1, -1).join('');
  assert.equal(scan(block)[0].fingerprint, sha(body));
  // Nothing of the value beyond the excerpt is in the finding.
  assert.ok(!JSON.stringify(scan(`x ${v}`)).includes(v.slice(4, -2)));
});

test('allowlist parsing and suppression', () => {
  const fp = sha('anything');
  const parsed = parseAllowlist(['# comment', '', 'fixtures/**', '*.env', fp, 'sha256:ABC', `!${fp}`, '  docs/  '].join('\n'));
  assert.deepEqual(parsed.globs, [{ glob: 'fixtures/**', line: 3 }, { glob: '*.env', line: 4 }, { glob: 'docs/', line: 8 }]);
  assert.deepEqual([...parsed.prints], [[fp, 5]]);
  assert.equal(parsed.entries, 4);
  assert.equal(parsed.problems.length, 2);
  assert.match(parsed.problems[0], /secrets-allow\.txt:6/);
  assert.match(parsed.problems[1], /secrets-allow\.txt:7/);

  const v = token.aws();
  const findings = scanUnits([unit(`k ${v}`, 'fixtures/a.txt'), unit(`k ${v}`, 'src/b.ts'), unit(`msg ${v}`, '(commit message 0123456789ab)', false), unit(`k ${v}`, 'prod.env')], { config: null });
  assert.equal(findings.length, 4);
  const allow = { file: '.forge/secrets-allow.txt', present: true, ...parseAllowlist('fixtures/**\n*.env\n') };
  const r = applyAllowlist(findings, allow);
  assert.deepEqual(r.findings.map((f) => f.path), ['src/b.ts', '(commit message 0123456789ab)']);
  assert.deepEqual(r.allowed.map((f) => [f.path, f.allowedBy]), [['fixtures/a.txt', '.forge/secrets-allow.txt:1'], ['prod.env', '.forge/secrets-allow.txt:2']]);
  // `*` matches every path but never text: a commit message needs its fingerprint.
  const star = applyAllowlist(findings, { file: '.forge/secrets-allow.txt', present: true, ...parseAllowlist('*\n**\n') });
  assert.deepEqual(star.findings.map((f) => f.path), ['(commit message 0123456789ab)']);
  const byPrint = applyAllowlist(findings, { file: '.forge/secrets-allow.txt', present: true, ...parseAllowlist(`# ok\n${sha(v)}\n`) });
  assert.equal(byPrint.findings.length, 0);
  assert.ok(byPrint.allowed.every((f) => f.allowedBy === '.forge/secrets-allow.txt:2'));

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-allow-')));
  try {
    assert.deepEqual(loadAllowlist(dir), { file: '.forge/secrets-allow.txt', present: false, entries: 0, problems: [], globs: [], prints: new Map() });
    fs.mkdirSync(path.join(dir, '.forge'));
    fs.writeFileSync(path.join(dir, 'elsewhere.txt'), `*\n${sha(v)}\n`);
    fs.symlinkSync(path.join(dir, 'elsewhere.txt'), path.join(dir, '.forge', 'secrets-allow.txt'));
    const linked = loadAllowlist(dir);
    assert.equal(linked.present, true);
    assert.equal(linked.entries, 0);
    assert.match(linked.problems[0], /symlink/);
    assert.equal(applyAllowlist(findings, linked).findings.length, 4, 'a symlinked allowlist suppresses nothing');
    fs.rmSync(path.join(dir, '.forge', 'secrets-allow.txt'));
    fs.mkdirSync(path.join(dir, '.forge', 'secrets-allow.txt'));
    assert.match(loadAllowlist(dir).problems[0], /not a regular file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hostile input stays linear', () => {
  const begin = ['-----BEG', 'IN PRIVATE KEY-----'].join('');
  const lines = [
    begin.repeat(400),
    `${begin}${'-----END '.repeat(1000)}${'A '.repeat(3000)}`,
    `authorization: bearer ${'a'.repeat(10_000)}`,
    `x://${'a'.repeat(5000)}:${'b'.repeat(5000)}`,
    `?token=${'='.repeat(10_000)}`,
    `"${'A1b'.repeat(3400)}`,
    `${'k'.repeat(64)} = ${'Ab1+'.repeat(2500)}`,
    "'".repeat(10_000),
  ];
  for (const l of lines) {
    const t0 = performance.now();
    scan(l);
    assert.ok(performance.now() - t0 < 500, `${l.slice(0, 30)}… took ${Math.round(performance.now() - t0)} ms`);
  }
});

test("the repo's tracked files hold no provider-shaped literal", () => {
  const r = scanPaths(ROOT, defaults(), ['**']);
  assert.equal(r.error, undefined);
  assert.ok(r.scanned.files > 100, `scanned ${r.scanned.files} files`);
  const provider = r.findings.filter((f) => f.kind !== 'high-entropy');
  assert.deepEqual(provider.map((f) => `${f.kind} ${f.path}:${f.line}`), []);
});

test('known values are findings the allowlist cannot allow', () => {
  // Low entropy and no provider shape: only knowing the value finds it.
  const v = 'devpassword-plain';
  const plain = scanUnits([unit(`DB=${v}`, 'cfg/.env')], { config: defaults() });
  assert.deepEqual(plain, []);
  const found = scanUnits([unit(`DB=${v}\nagain ${v}`, 'cfg/.env'), unit(`body ${v}`, '(pr body)', false)], { config: defaults(), known: [v, 'short'] });
  assert.deepEqual(found.map((f) => [f.kind, f.path, f.line]), [['known-secret', 'cfg/.env', 1], ['known-secret', '(pr body)', 1]]);
  // A declared value can be short enough to brute-force from its sha256 or a prefix: neither is shown.
  assert.equal(found[0].excerpt, '<known>');
  assert.match(found[0].fingerprint, /^known:[0-9a-f]{12}$/);
  assert.equal(found[0].fingerprint, found[1].fingerprint, 'one value, one id within a process');
  const shaHex = fingerprint(v).slice('sha256:'.length);
  for (const leak of [v, shaHex, mask(v)]) assert.ok(!JSON.stringify(found).includes(leak), leak);
  const allow = { file: '.forge/secrets-allow.txt', present: true, ...parseAllowlist(`**\n${fingerprint(v)}\n`) };
  const r = applyAllowlist(found, allow);
  assert.equal(r.findings.length, 2, 'neither a glob nor the fingerprint allows a known value');
  assert.equal(r.allowed.length, 0);
  assert.equal(secretsOk({ findings: r.findings }, 'warn'), false, 'it blocks under warn');
  assert.equal(secretsBlock(r.findings, 'warn'), true);
  assert.equal(secretsOk({ findings: scan(`k ${token.aws()}`) }, 'warn'), true, 'other kinds still only warn');

  // On a job's branch, committed after the .gitignore was edited around it, and in PR text.
  const repo = tempRepo();
  try {
    const config = defaults();
    const job = createJob(repo.dir, config, { title: 'known' });
    recordKnown(repo.dir, job.id, { DB: v });
    execFileSync('git', ['checkout', '-qb', 'feature'], { cwd: repo.dir });
    fs.writeFileSync(path.join(repo.dir, '.gitignore'), '.env\n');
    fs.writeFileSync(path.join(repo.dir, '.env'), `DB=${v}\n`);
    execFileSync('git', ['add', '-f', '.gitignore', '.env'], { cwd: repo.dir });
    execFileSync('git', ['commit', '-qm', 'add env'], { cwd: repo.dir });
    const branch = scanBranch(repo.dir, config, { id: job.id, worktree: repo.dir, base: 'main' }, { staged: false });
    assert.equal(branch.error, undefined);
    assert.ok(branch.findings.some((f) => f.kind === 'known-secret' && f.path === '.env'), JSON.stringify(branch.findings));
    assert.equal(secretsOk(branch, 'warn'), false);
    assert.throws(
      () => refuseSecrets(repo.dir, config, [textUnit('(pr body)', `uses ${v}`)], { what: 'the PR title or body', id: job.id, gate: 'pr' }),
      (e: any) => e.code === 'secret_found' && /known-secret .*never allowlisted\.$/.test(e.message) && ![v, shaHex, mask(v)].some((l) => e.message.includes(l)),
    );
    const events = fs.readFileSync(path.join(jobDir(repo.dir, job.id), 'events.jsonl'), 'utf8');
    assert.match(events, /"secret-found"/);
    for (const leak of [v, shaHex, mask(v)]) assert.ok(!events.includes(leak), `events.jsonl holds ${leak}`);
    // Without the job id there is nothing to know.
    refuseSecrets(repo.dir, config, [textUnit('(pr body)', `uses ${v}`)], { what: 'the PR title or body' });
  } finally {
    repo.cleanup();
  }
});
