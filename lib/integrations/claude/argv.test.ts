// buildArgv's file-tool rewrite and deny tail, and absRule, in-process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DENY_TOOLS, PROMPT_TOOL, absRule, buildArgv } from './argv.ts';

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
