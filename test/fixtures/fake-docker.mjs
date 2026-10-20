// A model of the docker CLI subset lib/backing.ts uses: containers with labels and running state,
// volumes with labels, and the daemon up or down. backing.test.ts calls handle() in-process; the
// docker-bin/docker shim runs main() with state in $FAKE_DOCKER_STATE and argv appended to $FAKE_DOCKER_LOG.
import fs from 'node:fs';

/**
 * A fresh state: daemon up, nothing created. `pg[container]` models each Postgres server psql
 * reaches through `docker exec`; `failExec` is a regex source failing any SQL statement it matches,
 * `notReadyFor[container]` how many pg_isready calls fail first, and `sql` logs every statement.
 */
export function emptyState() {
  return { daemon: 'up', version: '27.1.1', containers: {}, volumes: {}, failRun: false, failStart: false, failRm: false, envFiles: [], pg: {}, failExec: null, notReadyFor: {}, sql: [] };
}

const pgOf = (state, container, admin) =>
  (state.pg[container] ??= { roles: { [admin]: { login: true, verifier: null, memberOf: [], superuser: true } }, dbs: { postgres: { owner: admin, isTemplate: false, allowConn: true, clonedFrom: null, connectRevoked: false } } });

const sqlErr = (msg) => ({ error: `ERROR:  ${msg}` });

/** One SQL statement against a server, as the exact statements lib/backing-db.ts sends; an unknown one fails loudly. */
function statement(pg, admin, s) {
  let m;
  if ((m = /^SELECT datistemplate FROM pg_database WHERE datname = '(\w+)'$/.exec(s))) return { out: pg.dbs[m[1]] ? [pg.dbs[m[1]].isTemplate ? 't' : 'f'] : [] };
  if ((m = /^SELECT 1 FROM pg_roles WHERE rolname = '(\w+)'$/.exec(s))) return { out: pg.roles[m[1]] ? ['1'] : [] };
  if ((m = /^SELECT 1 FROM pg_database WHERE datname = '(\w+)'$/.exec(s))) return { out: pg.dbs[m[1]] ? ['1'] : [] };
  if (s === "SELECT datname FROM pg_database WHERE datname ~ '^forge_tpl_[0-9a-f]{12}$'") return { out: Object.keys(pg.dbs).filter((d) => /^forge_tpl_[0-9a-f]{12}$/.test(d)) };
  if ((m = /^SELECT pg_terminate_backend\(pid\) FROM pg_stat_activity WHERE datname = '(\w+)' AND pid <> pg_backend_pid\(\)$/.exec(s))) return { out: [] };
  if ((m = /^CREATE ROLE "(\w+)" NOLOGIN$/.exec(s))) {
    if (pg.roles[m[1]]) return sqlErr(`role "${m[1]}" already exists`);
    pg.roles[m[1]] = { login: false, verifier: null, memberOf: [] };
    return { out: [] };
  }
  if ((m = /^CREATE ROLE "(\w+)" LOGIN PASSWORD '(SCRAM-SHA-256\$[^']+)' IN ROLE "(\w+)"$/.exec(s))) {
    if (pg.roles[m[1]]) return sqlErr(`role "${m[1]}" already exists`);
    if (!pg.roles[m[3]]) return sqlErr(`role "${m[3]}" does not exist`);
    pg.roles[m[1]] = { login: true, verifier: m[2], memberOf: [m[3]] };
    return { out: [] };
  }
  if ((m = /^ALTER ROLE "(\w+)" LOGIN PASSWORD '(SCRAM-SHA-256\$[^']+)'$/.exec(s))) {
    if (!pg.roles[m[1]]) return sqlErr(`role "${m[1]}" does not exist`);
    Object.assign(pg.roles[m[1]], { login: true, verifier: m[2] });
    return { out: [] };
  }
  if ((m = /^ALTER ROLE "(\w+)" NOLOGIN PASSWORD NULL$/.exec(s))) {
    if (!pg.roles[m[1]]) return sqlErr(`role "${m[1]}" does not exist`);
    Object.assign(pg.roles[m[1]], { login: false, verifier: null });
    return { out: [] };
  }
  if ((m = /^CREATE DATABASE "(\w+)" OWNER "(\w+)"$/.exec(s))) {
    if (pg.dbs[m[1]]) return sqlErr(`database "${m[1]}" already exists`);
    pg.dbs[m[1]] = { owner: m[2], isTemplate: false, allowConn: true, clonedFrom: null, connectRevoked: false };
    return { out: [] };
  }
  if ((m = /^CREATE DATABASE "(\w+)" TEMPLATE "(\w+)" OWNER "(\w+)"$/.exec(s))) {
    const src = pg.dbs[m[2]];
    if (pg.dbs[m[1]]) return sqlErr(`database "${m[1]}" already exists`);
    if (!src) return sqlErr(`template database "${m[2]}" does not exist`);
    if (!src.isTemplate) return sqlErr(`permission denied to copy database "${m[2]}"`);
    if (src.allowConn && src.open) return sqlErr(`source database "${m[2]}" is being accessed by other users`);
    pg.dbs[m[1]] = { owner: m[3], isTemplate: false, allowConn: true, clonedFrom: m[2], connectRevoked: false };
    return { out: [] };
  }
  if ((m = /^REVOKE CONNECT ON DATABASE "(\w+)" FROM PUBLIC$/.exec(s))) {
    if (!pg.dbs[m[1]]) return sqlErr(`database "${m[1]}" does not exist`);
    pg.dbs[m[1]].connectRevoked = true;
    return { out: [] };
  }
  if ((m = /^ALTER DATABASE "(\w+)" OWNER TO "(\w+)"$/.exec(s))) {
    if (!pg.dbs[m[1]]) return sqlErr(`database "${m[1]}" does not exist`);
    pg.dbs[m[1]].owner = m[2];
    return { out: [] };
  }
  if ((m = /^ALTER DATABASE "(\w+)" WITH IS_TEMPLATE (true|false)( ALLOW_CONNECTIONS false)?$/.exec(s))) {
    if (!pg.dbs[m[1]]) return sqlErr(`database "${m[1]}" does not exist`);
    pg.dbs[m[1]].isTemplate = m[2] === 'true';
    if (m[3]) pg.dbs[m[1]].allowConn = false;
    return { out: [] };
  }
  if ((m = /^DROP DATABASE (IF EXISTS )?"(\w+)"$/.exec(s))) {
    const d = pg.dbs[m[2]];
    if (!d) return m[1] ? { out: [] } : sqlErr(`database "${m[2]}" does not exist`);
    if (d.isTemplate) return sqlErr('cannot drop a template database');
    delete pg.dbs[m[2]];
    return { out: [] };
  }
  if ((m = /^DROP ROLE IF EXISTS "(\w+)"$/.exec(s))) {
    delete pg.roles[m[1]];
    return { out: [] };
  }
  return { error: `fake docker: unsupported sql ${s}` };
}

/** `docker exec`: pg_isready, or psql with its SQL on stdin, run statement by statement with ON_ERROR_STOP. */
function dockerExec(state, rest, input) {
  const interactive = rest[0] === '-i';
  const [container, prog, ...argv] = interactive ? rest.slice(1) : rest;
  const c = state.containers[container];
  if (!c) return fail(`Error response from daemon: No such container: ${container}`);
  if (!c.running) return fail(`Error response from daemon: container ${container} is not running`);
  const admin = flagValues(argv, '-U')[0];
  if (prog === 'pg_isready') {
    if ((state.notReadyFor[container] ?? 0) > 0) {
      state.notReadyFor[container]--;
      return { status: 2, stdout: '', stderr: '' };
    }
    return ok();
  }
  if (prog !== 'psql' || !interactive) return fail(`fake docker: unsupported exec ${rest.join(' ')}`);
  const pg = pgOf(state, container, admin);
  if (!pg.roles[admin]?.superuser) return fail(`psql: error: FATAL:  role "${admin}" does not exist`);
  const out = [];
  for (const raw of String(input ?? '').split(';\n')) {
    const s = raw.trim();
    if (!s) continue;
    state.sql.push({ container, db: flagValues(argv, '-d')[0], s });
    if (state.failExec && new RegExp(state.failExec).test(s)) return { status: 3, stdout: '', stderr: `psql:<stdin>:1: ERROR:  injected failure\n` };
    const r = statement(pg, admin, s);
    if (r.error) return { status: 3, stdout: '', stderr: `psql:<stdin>:1: ${r.error}\n` };
    out.push(...r.out);
  }
  return ok(out.length ? `${out.join('\n')}\n` : '');
}

const flagValues = (args, flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
const labelsOf = (args) => Object.fromEntries(flagValues(args, '--label').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const fail = (stderr) => ({ status: 1, stdout: '', stderr });

/** One docker call against `state` (mutated in place): { status, stdout, stderr }. */
export function handle(state, args, input) {
  const [cmd, ...rest] = args;
  if (state.daemon !== 'up') return fail('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');
  if (cmd === 'version') return ok(`${state.version}\n`);
  if (cmd === 'exec') return dockerExec(state, rest, input);
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

/** The shim's entry: state from $FAKE_DOCKER_STATE (created when missing), argv logged to $FAKE_DOCKER_LOG, stdin read for `exec -i`. */
export function main(argv) {
  const file = process.env.FAKE_DOCKER_STATE;
  const state = file && fs.existsSync(file) ? { ...emptyState(), ...JSON.parse(fs.readFileSync(file, 'utf8')) } : emptyState();
  if (process.env.FAKE_DOCKER_LOG) fs.appendFileSync(process.env.FAKE_DOCKER_LOG, `${JSON.stringify(argv)}\n`);
  const input = argv[0] === 'exec' && argv[1] === '-i' ? fs.readFileSync(0, 'utf8') : undefined;
  const r = handle(state, argv, input);
  if (file) fs.writeFileSync(file, JSON.stringify(state));
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exitCode = r.status;
}
