// The LaunchAgent plist: its keys, its escaping, and the program read back from what it renders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LAUNCHD_LABEL, launchdSteps, readLaunchAgentProgram, renderLaunchAgent } from './launchd.ts';
import type { ServiceUnit } from './types.ts';

const HOSTILE = `/Users/a&b/<x>/"q"/'s'/</string><key>RunAtLoad</key>`;

const unit = (program: string[]): ServiceUnit => ({
  program,
  env: { PATH: '/usr/bin:/bin', HOME: `/Users/o'neil & co` },
  workingDirectory: '/',
  log: '/Users/me/.forge/runtime/service.log',
});

test('a LaunchAgent escapes every value and reads its program back', () => {
  const u = unit(['/usr/local/bin/node', `${HOSTILE}/bin/forge`, 'dash', '--service']);
  const text = renderLaunchAgent(u);
  assert.ok(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"'));
  const after = (key: string) => text.slice(text.indexOf(`<key>${key}</key>`) + `<key>${key}</key>`.length).trimStart().split('\n')[0];
  assert.equal(after('Label'), `<string>${LAUNCHD_LABEL}</string>`);
  assert.equal(after('WorkingDirectory'), '<string>/</string>');
  assert.equal(after('RunAtLoad'), '<true/>');
  assert.equal(after('ThrottleInterval'), '<integer>30</integer>');
  assert.match(text, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/);
  assert.equal(after('StandardOutPath'), `<string>${u.log}</string>`);
  assert.equal(after('StandardErrorPath'), `<string>${u.log}</string>`);
  assert.match(text, /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>HOME<\/key>\s*<string>\/Users\/o&apos;neil &amp; co<\/string>\s*<key>PATH<\/key>\s*<string>\/usr\/bin:\/bin<\/string>\s*<\/dict>/);
  // The hostile path stays one escaped string: no key it holds is ever read as one.
  assert.equal(text.split('<key>RunAtLoad</key>').length, 2);
  assert.ok(text.includes('&amp;b/&lt;x&gt;/&quot;q&quot;/&apos;s&apos;/&lt;/string&gt;'));
  assert.deepEqual(readLaunchAgentProgram(text), u.program);
  for (const program of [['/n'], ['/node', '', 'a b', '&amp;'], [HOSTILE, HOSTILE]]) assert.deepEqual(readLaunchAgentProgram(renderLaunchAgent(unit(program))), program, JSON.stringify(program));
  assert.throws(() => renderLaunchAgent(unit(['/node', 'a\nb'])), /control character/);
  assert.throws(() => renderLaunchAgent({ ...unit(['/node']), env: { PATH: '/bin\n<key>X</key>' } }), /control character/);
});

test('a plist that is not one Forge wrote reads as no program', () => {
  for (const text of ['', '<plist/>', '<key>ProgramArguments</key><string>x</string>', '<key>ProgramArguments</key><array><string>a</string><integer>1</integer></array>', '<key>ProgramArguments</key><array><string>a</string>']) {
    assert.equal(readLaunchAgentProgram(text), null, text);
  }
  // A long hostile array costs linear time.
  const t0 = performance.now();
  assert.equal(readLaunchAgentProgram(`<key>ProgramArguments</key><array>${'<string>'.repeat(10_000)}`), null);
  assert.ok(performance.now() - t0 < 1000);
});

test('launchctl steps target the user GUI domain', () => {
  assert.deepEqual(launchdSteps(501, '/f.plist'), {
    install: [
      ['launchctl', 'bootout', `gui/501/${LAUNCHD_LABEL}`],
      ['launchctl', 'bootstrap', 'gui/501', '/f.plist'],
    ],
    uninstall: [['launchctl', 'bootout', `gui/501/${LAUNCHD_LABEL}`]],
    status: [['launchctl', 'print', `gui/501/${LAUNCHD_LABEL}`]],
  });
});
