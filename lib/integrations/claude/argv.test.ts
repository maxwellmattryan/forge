// buildArgv's file-tool rewrite, dollar cap and deny tail, absRule, and the session env's billing scrub, in-process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DENY_TOOLS, PROMPT_TOOL, absRule, billingOf, buildArgv, sessionEnv } from './argv.ts';

const session = { id: '00000000-0000-4000-8000-000000000000', resume: false };
const allowedOf = (argv: string[]) => argv[argv.indexOf('--allowedTools') + 1];

test('buildArgv scopes the file tools to the write roots', () => {
  const roots = ['/r/.forge/jobs', '/w'];
  const rows: { name: string; tools: string[]; roots?: string[]; want: string }[] = [
    { name: 'bare Edit and Write', tools: ['Agent', 'Read', 'Edit', 'Write', 'Bash(forge:*)'], want: 'Agent,Read,Bash(forge:*),Edit(//r/.forge/jobs/**),Edit(//w/**)' },
    { name: 'MultiEdit and NotebookEdit too', tools: ['MultiEdit', 'Agent', 'NotebookEdit'], want: 'Agent,Edit(//r/.forge/jobs/**),Edit(//w/**)' },
    { name: 'a scoped Edit(//**) handed straight in is dropped', tools: ['Agent', 'Edit(//**)'], want: 'Agent,Edit(//r/.forge/jobs/**),Edit(//w/**)' },
    { name: 'scoped Write and NotebookEdit are dropped', tools: ['Write(~/**)', 'NotebookEdit(x)', 'Read'], want: 'Read,Edit(//r/.forge/jobs/**),Edit(//w/**)' },
    { name: 'no file tool gets no scoped rule', tools: ['Agent', 'Read', 'Bash(forge:*)'], want: 'Agent,Read,Bash(forge:*)' },
    { name: 'no write roots: the file tools only go', tools: ['Agent', 'Edit'], roots: [], want: 'Agent' },
    { name: 'a lookalike is not a file tool', tools: ['Editor', 'Agent'], want: 'Editor,Agent' },
  ];
  for (const row of rows) {
    const argv = buildArgv('claude --allowedTools {allowedTools} {session}', { pluginRoot: '/p', session, allowedTools: row.tools, writeRoots: row.roots ?? roots });
    assert.equal(allowedOf(argv), row.want, row.name);
  }
});

test('absRule writes absolute permission rules', () => {
  const rows: { p: string; platform: NodeJS.Platform; want?: string }[] = [
    { p: '/Users/a b/repo', platform: 'darwin', want: '//Users/a b/repo' },
    { p: '/home/x/repo.worktrees', platform: 'linux', want: '//home/x/repo.worktrees' },
    { p: 'C:\\Users\\a\\repo', platform: 'win32', want: '//c/Users/a/repo' },
    ...[',', '(', ')', '*', '?', '[', ']', '{', '}', '\n', '\\'].map((ch) => ({ p: `/r/a${ch}b`, platform: 'linux' as NodeJS.Platform })),
  ];
  for (const row of rows) {
    if (row.want !== undefined) assert.equal(absRule(row.p, row.platform), row.want, row.p);
    else assert.throws(() => absRule(row.p, row.platform), /can't be a permission rule/, JSON.stringify(row.p));
  }
});

test('the deny tail follows every template', () => {
  const deny = ['Edit(//r/CLAUDE.md)', 'Edit(**/CLAUDE.md)'];
  const templates = ['claude {session}', 'claude -p --allowedTools {allowedTools} {session} --permission-mode dontAsk', 'claude {session} --effort low'];
  for (const template of templates) {
    for (const extra of [undefined, deny]) {
      const argv = buildArgv(template, { pluginRoot: '/p', session, allowedTools: ['Agent'], effort: 'high', permissionMode: 'default', ...(extra ? { deny: extra } : {}) });
      const tail = argv.slice(-(2 + PROMPT_TOOL.length));
      assert.deepEqual(tail, ['--disallowedTools', [...DENY_TOOLS, ...(extra ?? [])].join(','), ...PROMPT_TOOL], template);
    }
  }
  for (const t of ['Edit(.forge/notes/**)', 'Edit(.forge/runtime/**)', 'Edit(.forge/jobs/*/job.json)', 'Edit(.forge/jobs/*/events.jsonl)', 'Edit(.forge/local.yml)'])
    assert.ok(DENY_TOOLS.includes(t), t);
});

test('a system prompt to append goes once, before the deny tail', () => {
  const vars = { pluginRoot: '/p', session, allowedTools: ['Agent'], maxBudgetUsd: 5 };
  const plain = buildArgv('claude {session}', vars);
  assert.deepEqual(buildArgv('claude {session}', { ...vars, appendSystemPrompt: null }), plain, 'null changes nothing');
  assert.ok(!plain.includes('--append-system-prompt'));
  const text = 'You are the Foreman.\nRun `forge chat brief` first.';
  const argv = buildArgv('claude {session}', { ...vars, appendSystemPrompt: text });
  assert.equal(argv.filter((w) => w === text).length, 1, 'the text once');
  const at = argv.indexOf('--append-system-prompt');
  assert.equal(argv[at + 1], text);
  assert.ok(at > argv.indexOf('--max-budget-usd') && at < argv.indexOf('--disallowedTools'), 'after the cap, before the deny tail');
  assert.deepEqual([...argv.slice(0, at), ...argv.slice(at + 2)], plain, 'nothing else changes');
});

test("the dollar cap is Forge's, once", () => {
  const caps = (argv: string[]) => argv.flatMap((w, i) => (w === '--max-budget-usd' ? [argv[i + 1]] : w.startsWith('--max-budget-usd=') ? [w] : []));
  const rows: { name: string; template?: string; usd: number | null | undefined; want: string[] }[] = [
    { name: '110', usd: 110, want: ['110.00'] },
    { name: 'zero', usd: 0, want: ['0.01'] },
    { name: 'negative', usd: -50, want: ['0.01'] },
    { name: 'floored to cents', usd: 12.345, want: ['12.34'] },
    { name: 'null', usd: null, want: [] },
    { name: 'not a finite number', usd: Number.NaN, want: [] },
    { name: "the template's spaced cap", template: 'claude {session} --max-budget-usd 999', usd: 5, want: ['5.00'] },
    { name: "the template's = cap", template: 'claude {session} --max-budget-usd=999', usd: 5, want: ['5.00'] },
    { name: "the template's cap with none of Forge's", template: 'claude --max-budget-usd 999 {session}', usd: null, want: [] },
  ];
  for (const row of rows) {
    const argv = buildArgv(row.template ?? 'claude {session}', { pluginRoot: '/p', session, allowedTools: ['Agent'], maxBudgetUsd: row.usd });
    assert.deepEqual(caps(argv), row.want, row.name);
    if (row.want.length) assert.ok(argv.indexOf('--max-budget-usd') < argv.indexOf('--disallowedTools'), `${row.name}: before the deny tail`);
    assert.ok(argv.includes('--session-id'), `${row.name}: the rest of argv stays`);
  }
});

test('sessions lose provider switches unless daemon.auth is api-key', () => {
  const six = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
  const env = { PATH: '/bin', OTHER: 'kept', ...Object.fromEntries(six.map((k) => [k, '1'])) };
  const sub = sessionEnv(env, 'subscription');
  assert.deepEqual(six.filter((k) => k in sub), [], 'subscription drops all six');
  assert.equal(sub.OTHER, 'kept');
  const api = sessionEnv(env, 'api-key');
  assert.deepEqual(six.filter((k) => api[k] === '1'), six, 'api-key keeps all six');

  assert.equal(billingOf({ PATH: '/bin', ANTHROPIC_API_KEY: '' }, 'subscription'), null);
  assert.deepEqual(billingOf({ CLAUDE_CODE_USE_BEDROCK: '1' }, 'subscription'), { vars: ['CLAUDE_CODE_USE_BEDROCK'], passed: false, warn: true });
  assert.deepEqual(billingOf({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'http://proxy' }, 'api-key'), { vars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'], passed: true, warn: true });
  // An API key alone under api-key is the deliberate setup: listed, no warning (doctor's rule).
  assert.deepEqual(billingOf({ ANTHROPIC_API_KEY: 'k' }, 'api-key'), { vars: ['ANTHROPIC_API_KEY'], passed: true, warn: false });
});
