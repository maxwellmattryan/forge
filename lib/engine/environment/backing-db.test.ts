// Job databases on a shared Postgres (#316): a template build leaves no forge_tpl session behind,
// and teardown still drops a job's database after its entry loses `database`. Docker and Postgres are
// the in-process fake in test/fixtures/fake-docker.mjs (no docker runs).
import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeDockerHandle, fakeDockerState } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import type { BackingEntry, Config } from '#core/types.ts';
import type { DockerRunner } from '#integrations/docker/types.ts';
import { backingDown, backingUp } from './backing.ts';
import { dbRecordFile, jobDbName } from './backing-db.ts';
import { rootLabel } from './backing-names.ts';

const made: string[] = [];
process.on('exit', () => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** A root named `app` in its own parent, with job j1's directory, and a worktree for j1. */
function appRoot(): { root: string; worktree: string } {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-backing-db-')));
  made.push(parent);
  const root = path.join(parent, 'app');
  fs.mkdirSync(path.join(root, '.forge', 'jobs', 'j1'), { recursive: true });
  const worktree = path.join(parent, 'wt');
  fs.mkdirSync(worktree);
  return { root, worktree };
}

const PG: BackingEntry = { name: 'pg', isolation: 'shared', image: 'postgres:16', ports: [5432], url: 'postgres://{user}:{password}@{host}:{port}/{database}', database: { engine: 'postgres', migrate: 'migrate' } } as BackingEntry;
const config = (backing: BackingEntry[]): Config => ({ ...defaults(), backing }) as Config;

/** The fake's state and a runner over it, counting `docker exec` calls. */
function fake() {
  const state = fakeDockerState();
  const calls: string[][] = [];
  const runner: DockerRunner = (args, o) => {
    calls.push(args);
    const r = fakeDockerHandle(state, args, o?.input);
    return { ok: r.status === 0, ...r };
  };
  return { state, runner, execs: () => calls.filter((c) => c[0] === 'exec').length };
}

const SESSION_TERMINATE = "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'forge_tpl' AND pid <> pg_backend_pid()";

it('a template build ends every forge_tpl session, whether it succeeds or fails', async (t) => {
  for (const row of [
    { name: 'migrate succeeds', ok: true },
    { name: 'migrate fails', ok: false },
  ]) {
    await t.test(row.name, () => {
      const { root, worktree } = appRoot();
      const { state, runner } = fake();
      const container = `forge-app-${rootLabel(root)}-pg`;
      state.sessions.push({ container, user: 'forge_tpl', db: 'template1' }, { container, user: 'app_reader', db: 'postgres' });
      const seen: unknown[] = [];
      const runCommand = () => {
        seen.push(structuredClone(state.sessions));
        // Migrate leaves a forge_tpl connection open on another database.
        state.sessions.push({ container, user: 'forge_tpl', db: 'postgres' });
        return { ok: row.ok, output: '' };
      };
      const [up] = backingUp(root, config([PG]), { id: 'j1' }, runner, { worktree, runCommand });
      // The session left before the build was gone by the time migrate ran.
      assert.deepEqual(seen, [[{ container, user: 'app_reader', db: 'postgres' }]]);
      assert.deepEqual(state.sessions, [{ container, user: 'app_reader', db: 'postgres' }]);
      const pg = state.pg[container];
      assert.equal(pg.roles.forge_tpl.login, false);
      if (row.ok) {
        assert.equal(up!.ok, true, up!.error);
        assert.equal(up!.database!.template_action, 'built');
        assert.equal(pg.dbs[up!.database!.template!].isTemplate, true);
      } else {
        assert.equal(up!.ok, false);
        assert.match(up!.error!, /^template forge_tpl_[0-9a-f]{12}: migrate failed/);
        assert.deepEqual(Object.keys(pg.dbs).filter((d) => d.startsWith('forge_tpl_')), []);
      }
      const log: string[] = state.sql.filter((x: { container: string }) => x.container === container).map((x: { s: string }) => x.s);
      assert.ok(log.lastIndexOf(SESSION_TERMINATE) > log.lastIndexOf('ALTER ROLE "forge_tpl" NOLOGIN PASSWORD NULL'), 'the last terminate follows NOLOGIN');
      const first = log.indexOf(SESSION_TERMINATE);
      assert.ok(first >= 0 && first < log.findIndex((s) => s.startsWith('ALTER ROLE "forge_tpl" LOGIN')), 'the first terminate precedes LOGIN');
    });
  }
});

it('teardown drops the job database of an entry the record names after it loses database', async (t) => {
  const noDatabase = { ...PG, url: 'postgres://postgres@{host}:{port}/postgres' } as BackingEntry;
  delete noDatabase.database;
  for (const row of [
    { name: 'database removed', backing: [noDatabase], failExec: null, execs: null, want: { removed: [], volumes: [], databases: [jobDbName('j1')], ok: true } },
    { name: 'entry removed', backing: [], failExec: null, execs: 0, want: { removed: [], volumes: [], databases: [], ok: true } },
    { name: 'drop fails', backing: [noDatabase], failExec: '^DROP DATABASE', execs: null, want: null },
  ]) {
    await t.test(row.name, () => {
      const { root, worktree } = appRoot();
      const { state, runner, execs } = fake();
      const container = `forge-app-${rootLabel(root)}-pg`;
      const [up] = backingUp(root, config([PG]), { id: 'j1' }, runner, { worktree, runCommand: () => ({ ok: true, output: '' }) });
      assert.equal(up!.ok, true, up!.error);
      const j = jobDbName('j1');
      assert.ok(state.pg[container].dbs[j] && state.pg[container].roles[j]);
      state.failExec = row.failExec;
      const before = execs();
      const down = backingDown(root, config(row.backing), 'j1', runner);
      if (row.want) {
        assert.deepEqual(down, row.want);
        assert.equal(fs.existsSync(dbRecordFile(root, 'j1')), false);
      } else {
        assert.equal(down.ok, false);
        assert.match(down.error!, /^docker exec failed: .*injected failure/);
        assert.equal(fs.existsSync(dbRecordFile(root, 'j1')), true);
      }
      if (row.execs !== null) assert.equal(execs() - before, row.execs);
      if (row.name === 'database removed') assert.deepEqual([state.pg[container].dbs[j], state.pg[container].roles[j]], [undefined, undefined]);
    });
  }
});
