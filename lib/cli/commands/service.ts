// `forge service install|uninstall|status`: the per-user login service that starts the machine
// dashboard at login (lib/engine/project/login-service.ts). Routed before mainRoot(), so it works
// outside any repo, like `forge project`.
import { ForgeError } from '#core/errors.ts';
import { defaultServiceOptions, installService, serviceStatus, uninstallService } from '#engine/project/login-service.ts';
import { out, usageError } from './args.ts';
import type { HelpGroup } from '../types.ts';

const SERVICE: HelpGroup = {
  name: 'service',
  summary: 'the per-user login service that starts the machine dashboard at login (a LaunchAgent on macOS, a systemd user unit on Linux)',
  commands: [
    {
      command: 'service install',
      args: '',
      summary:
        "install the login service for the current user and load it ({installed, manager, file, log, loaded, replaced, error?, note?}): it runs <node> <plugin>/bin/forge dash --service from /, starts at login, restarts 30 s after a crash but not after a clean exit, and appends its output to <FORGE_HOME>/runtime/service.log. Its environment carries only PATH (sanitised), HOME, USER, LOGNAME, SHELL, LANG, LC_*, TZ, TMPDIR and FORGE_HOME from this shell, never a token. A reinstall overwrites its own file and reloads it, which restarts a running service dashboard; with a dashboard you started running, `note` says the service takes over at the next login",
      common: true,
      exits: [[1, 'not supported on this platform yet (native Windows, the BSDs), a variable or path with a control character (nothing is written), the load failed (the file stays; loaded: false with error), or a daemon session ran it']],
    },
    {
      command: 'service uninstall',
      args: '',
      summary: 'unload the login service and remove exactly its file ({manager, file, removed}); the log stays, and with no file nothing runs (removed: false)',
      exits: [[1, 'not supported on this platform yet, or a daemon session ran it']],
    },
    {
      command: 'service status',
      args: '',
      summary:
        'the login service ({platform, supported, manager, file, installed, loaded, current, log}); loaded and current are null when nothing is installed, and then nothing runs. current is false when the unit runs another bin/forge or node (after forge update or a node upgrade: run forge service install again)',
    },
  ],
};

export const HELP: HelpGroup[] = [SERVICE];

// A login item outlives every session and restarts the machine's dashboard on its own terms: a human's call.
const SERVICE_DAEMON_REFUSAL = 'forge service install|uninstall changes what starts at login, which a daemon session may not do; a human runs it in their own terminal';

/** `forge service <sub>`: prints its result; install exits 1 when the load failed. `words` are the positionals after `service`. */
export function serviceCmd(words: string[], flags: Record<string, any>): void {
  const [sub, ...args] = words;
  if (sub !== 'install' && sub !== 'uninstall' && sub !== 'status') throw usageError(SERVICE);
  if (args.length) throw usageError(SERVICE, sub);
  if (sub !== 'status' && process.env.FORGE_DAEMON === '1') throw new ForgeError(SERVICE_DAEMON_REFUSAL);
  const opts = defaultServiceOptions();
  if (sub === 'status') return out(serviceStatus(opts), flags);
  if (sub === 'uninstall') return out(uninstallService(opts), flags);
  const r = installService(opts);
  out(r, flags);
  if (!r.loaded) process.exitCode = 1;
}
