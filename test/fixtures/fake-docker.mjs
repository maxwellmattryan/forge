// A model of the docker CLI subset lib/backing.ts uses: containers with labels and running state,
// volumes with labels, and the daemon up or down. backing.test.ts calls handle() in-process; the
// docker-bin/docker shim runs main() with state in $FAKE_DOCKER_STATE and argv appended to $FAKE_DOCKER_LOG.
import fs from 'node:fs';

/** A fresh state: daemon up, nothing created. */
export function emptyState() {
  return { daemon: 'up', version: '27.1.1', containers: {}, volumes: {}, failRun: false, failStart: false, failRm: false, envFiles: [] };
}

const flagValues = (args, flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
const labelsOf = (args) => Object.fromEntries(flagValues(args, '--label').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const fail = (stderr) => ({ status: 1, stdout: '', stderr });

/** One docker call against `state` (mutated in place): { status, stdout, stderr }. */
export function handle(state, args) {
  const [cmd, ...rest] = args;
  if (state.daemon !== 'up') return fail('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');
  if (cmd === 'version') return ok(`${state.version}\n`);
  const last = rest[rest.length - 1];
  if (cmd === 'inspect') {
    const c = state.containers[last];
    if (!c) return fail(`Error: No such container: ${last}`);
    return ok(`${JSON.stringify(c.running)} ${JSON.stringify(c.labels)}\n`);
  }
  if (cmd === 'volume') {
    const [sub] = rest;
    const v = state.volumes[last];
    if (sub === 'inspect') return v ? ok(`${JSON.stringify(v.labels)}\n`) : fail(`Error: No such volume: ${last}`);
    if (sub === 'create') {
      state.volumes[last] ??= { labels: labelsOf(rest) };
      return ok(`${last}\n`);
    }
    if (sub === 'rm') {
      if (!v) return fail(`Error: No such volume: ${last}`);
      delete state.volumes[last];
      return ok(`${last}\n`);
    }
  }
  if (cmd === 'run') {
    const envFile = flagValues(rest, '--env-file')[0];
    if (envFile) {
      const st = fs.statSync(envFile);
      state.envFiles.push({ path: envFile, mode: st.mode & 0o777, body: fs.readFileSync(envFile, 'utf8') });
    }
    if (state.failRun) return fail('Error response from daemon: driver failed programming external connectivity\nport is already allocated');
    const name = flagValues(rest, '--name')[0];
    if (state.containers[name]) return fail(`Error response from daemon: Conflict. The container name "/${name}" is already in use`);
    for (const v of flagValues(rest, '-v')) state.volumes[v.slice(0, v.indexOf(':'))] ??= { labels: {} };
    state.containers[name] = { running: true, labels: labelsOf(rest), image: last, ports: flagValues(rest, '-p') };
    return ok('0123456789abcdef\n');
  }
  if (cmd === 'start') {
    if (state.failStart) return fail('Error response from daemon: cannot start container');
    const c = state.containers[last];
    if (!c) return fail(`Error response from daemon: No such container: ${last}`);
    c.running = true;
    return ok(`${last}\n`);
  }
  if (cmd === 'rm') {
    if (state.failRm) return fail('Error response from daemon: removal in progress');
    if (!state.containers[last]) return fail(`Error: No such container: ${last}`);
    delete state.containers[last];
    return ok(`${last}\n`);
  }
  if (cmd === 'ps') {
    const filter = flagValues(rest, '--filter')[0] ?? '';
    const [k, v] = filter.replace(/^label=/, '').split('=');
    const rows = Object.entries(state.containers)
      .filter(([, c]) => c.labels[k] === v)
      .map(([name, c]) =>
        JSON.stringify({
          Names: name,
          State: c.running ? 'running' : 'exited',
          Labels: Object.entries(c.labels)
            .map(([a, b]) => `${a}=${b}`)
            .join(','),
        }),
      );
    return ok(rows.length ? `${rows.join('\n')}\n` : '');
  }
  return fail(`fake docker: unsupported ${args.join(' ')}`);
}

/** The shim's entry: state from $FAKE_DOCKER_STATE (created when missing), argv logged to $FAKE_DOCKER_LOG. */
export function main(argv) {
  const file = process.env.FAKE_DOCKER_STATE;
  const state = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : emptyState();
  if (process.env.FAKE_DOCKER_LOG) fs.appendFileSync(process.env.FAKE_DOCKER_LOG, `${JSON.stringify(argv)}\n`);
  const r = handle(state, argv);
  if (file) fs.writeFileSync(file, JSON.stringify(state));
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exitCode = r.status;
}
