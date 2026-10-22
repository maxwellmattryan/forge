// lib/doctor.ts checks that need no repo: the dashboard build a plugin checkout off main lacks until built.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dashboardCheck, doctor } from '../lib/doctor.ts';
import { loadConfig } from '../lib/core/config/load.ts';
import { tempRepo } from './helpers.ts';

test('dashboard built check', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-dist-'));
  try {
    assert.deepEqual(dashboardCheck(tmp), { name: 'dashboard built', ok: true, warn: true, detail: 'not built: run npm ci && npm run build:dashboard' });
    assert.deepEqual(dashboardCheck(path.join(tmp, 'missing')), { name: 'dashboard built', ok: true, warn: true, detail: 'not built: run npm ci && npm run build:dashboard' });
    fs.writeFileSync(path.join(tmp, 'manifest.json'), '{}');
    assert.deepEqual(dashboardCheck(tmp), { name: 'dashboard built', ok: true, detail: 'ok' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('doctor reports the dashboard built check', async () => {
  const repo = tempRepo();
  try {
    const { config } = loadConfig(repo.dir);
    config.pr.enabled = false;
    const report = await doctor(repo.dir, config, true);
    const row = report.checks.find((c) => c.name === 'dashboard built');
    assert.deepEqual(row, dashboardCheck(), 'doctor() includes the row for the plugin dist');
    assert.equal(row?.ok, true, 'never fails the report');
  } finally {
    repo.cleanup();
  }
});
