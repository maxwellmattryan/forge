// The systemd user unit: its directives, its quoting, and the program read back from what it renders.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { SYSTEMD_UNIT, readSystemdProgram, renderSystemdUnit, systemdSteps, systemdUnitFile } from './systemd.ts';
import type { ServiceUnit } from './types.ts';

const unit = (program: string[], env: Record<string, string> = { PATH: '/usr/bin:/bin' }): ServiceUnit => ({ program, env, workingDirectory: '/', log: '/home/me/.forge/runtime/service.log' });

test('a user unit quotes every value and reads its program back', () => {
  const u = unit(['/usr/bin/node', '/home/me/a "b"\\c/%n/$HOME/bin/forge', 'dash', '--service'], { PATH: '/usr/bin:/bin', HOME: '/home/me', LANG: 'en_US.UTF-8 %h $X "q"' });
  const lines = renderSystemdUnit(u).split('\n');
  assert.deepEqual(lines, [
    '[Unit]',
    'Description=Forge machine dashboard (forge dash)',
    '',
    '[Service]',
    'Type=simple',
    'ExecStart="/usr/bin/node" "/home/me/a \\"b\\"\\\\c/%%n/$$HOME/bin/forge" "dash" "--service"',
    'WorkingDirectory=/',
    'Environment="HOME=/home/me"',
    'Environment="LANG=en_US.UTF-8 %%h $X \\"q\\""',
    'Environment="PATH=/usr/bin:/bin"',
    'Restart=on-failure',
    'RestartSec=30',
    'StandardOutput=append:/home/me/.forge/runtime/service.log',
    'StandardError=append:/home/me/.forge/runtime/service.log',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ]);
  assert.deepEqual(readSystemdProgram(renderSystemdUnit(u)), u.program);
  for (const program of [['/n'], ['/n', '', 'a b', '%%', '$$', '\\"', '"']]) assert.deepEqual(readSystemdProgram(renderSystemdUnit(unit(program))), program, JSON.stringify(program));
  assert.throws(() => renderSystemdUnit(unit(['/n', 'a\nExecStartPre=/bin/evil'])), /control character/);
  assert.throws(() => renderSystemdUnit(unit(['/n'], { PATH: '/bin\nExecStartPre=/bin/evil' })), /control character/);
});

test('a unit line that is not one Forge wrote reads as no program', () => {
  for (const text of ['', '[Service]\n', 'ExecStart=/usr/bin/node x', 'ExecStart="a', 'ExecStart="a"b', 'ExecStart="a\\']) assert.equal(readSystemdProgram(text), null, text);
  const t0 = performance.now();
  assert.equal(readSystemdProgram(`ExecStart=${'"\\"'.repeat(10_000)}`), null);
  assert.ok(performance.now() - t0 < 1000);
});

test('the unit lives under XDG_CONFIG_HOME, else ~/.config, and systemctl --user drives it', () => {
  const home = path.join(path.sep, 'home', 'me');
  const xdg = path.join(path.sep, 'xdg');
  assert.equal(systemdUnitFile(home, { XDG_CONFIG_HOME: xdg }), path.join(xdg, 'systemd', 'user', SYSTEMD_UNIT));
  assert.equal(systemdUnitFile(home, {}), path.join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT));
  assert.equal(systemdUnitFile(home, { XDG_CONFIG_HOME: 'relative' }), path.join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT));
  assert.deepEqual(systemdSteps(), {
    install: [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', SYSTEMD_UNIT],
    ],
    restart: [['systemctl', '--user', 'try-restart', SYSTEMD_UNIT]],
    uninstall: [['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT]],
    afterUninstall: [['systemctl', '--user', 'daemon-reload']],
    status: [['systemctl', '--user', 'is-active', SYSTEMD_UNIT]],
  });
});
