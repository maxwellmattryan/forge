// Security checks the three workflow tests share (ci-workflow, release-workflow, main-update-workflow).
// Not a test file: node --test never runs it. Each check returns its findings, [] when the workflow is
// sound, so a test asserts [] on the real workflow and a finding on a hostile edit. They hold security
// properties only, never which jobs, steps or keys a workflow has: those change with every CI edit.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '../lib/yaml.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

type Map = Record<string, any>;
const isMap = (v: unknown): v is Map => !!v && typeof v === 'object' && !Array.isArray(v);
const jobsOf = (wf: any): [string, Map][] => Object.entries(isMap(wf?.jobs) ? wf.jobs : {}).filter((e): e is [string, Map] => isMap(e[1]));
const stepsOf = (job: Map): Map[] => (Array.isArray(job.steps) ? job.steps.filter(isMap) : []);
const label = (job: string, step: Map, i: number) => `${job} › ${step.name ?? step.uses ?? `step ${i + 1}`}`;

/** A workflow under .github/workflows, parsed. */
export function loadWorkflow(file: string): any {
  return parse(fs.readFileSync(path.join(ROOT, '.github', 'workflows', file), 'utf8'));
}

const SHA_PINNED = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/;
const DIGEST_PINNED = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;

/**
 * Every job- and step-level `uses:` not pinned to a commit. A tag or branch can be moved to new code
 * after review; a 40-hex SHA cannot. A local `./` workflow has no ref (it is this repo's own code), and
 * a docker image is pinned by its digest.
 */
export function unpinnedActions(wf: any): string[] {
  const out: string[] = [];
  const check = (where: string, uses: unknown) => {
    if (typeof uses === 'string' && uses.startsWith('./')) return;
    if (typeof uses === 'string' && uses.startsWith('docker://') ? DIGEST_PINNED.test(uses) : typeof uses === 'string' && SHA_PINNED.test(uses)) return;
    out.push(`${where}: not pinned to a full commit SHA: ${String(uses)}`);
  };
  for (const [id, job] of jobsOf(wf)) {
    if ('uses' in job) check(`job ${id}`, job.uses);
    stepsOf(job).forEach((s, i) => { if ('uses' in s) check(label(id, s, i), s.uses); });
  }
  return out;
}

/** Write scopes each job may hold, by job id. Anything else must be read or none. */
export type AllowedWrites = Record<string, Record<string, 'write'>>;

/**
 * Permissions wider than least: a `write-all`/`read-all` shorthand, a write scope at the top level, a
 * write a job's entry in `allowed` does not name, or a token whose permissions nothing declares (GitHub's
 * default may be write to everything).
 */
export function excessPermissions(wf: any, allowed: AllowedWrites): string[] {
  const out: string[] = [];
  const scopes = (where: string, p: unknown, writes: Record<string, 'write'>) => {
    if (!isMap(p)) {
      out.push(`${where}: permissions must be a map of scopes, got ${JSON.stringify(p)}`);
      return;
    }
    for (const [scope, level] of Object.entries(p)) {
      if (level === 'read' || level === 'none') continue;
      if (level === 'write' && writes[scope] === 'write') continue;
      out.push(`${where}: ${scope}: ${String(level)} is not allowed`);
    }
  };
  if (wf?.permissions === undefined) out.push('the workflow sets no top-level permissions');
  else scopes('workflow', wf.permissions, {});
  for (const [id, job] of jobsOf(wf)) {
    if ('permissions' in job) scopes(`job ${id}`, job.permissions, allowed[id] ?? {});
    else if (wf?.permissions === undefined) out.push(`job ${id}: no permissions block and no top-level one, so the token gets the default`);
  }
  return out;
}

const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
// Index and toJSON forms reach the same values: secrets['X'], toJSON(secrets), github['token'], toJSON(github).
const CREDENTIAL = /\bsecrets\b|\bgithub\s*(?:\.\s*token\b|\[\s*['"]token['"]\s*\])|toJSON\(\s*github\s*\)/i;

export type CredentialRef = { where: string; scope: 'step-env' | 'step-with' | 'job-env' | 'workflow-env' | 'run' | 'other'; ref: string };

/** Every `${{ secrets.* }}` and `${{ github.token }}` in the workflow, with where it sits. */
export function credentialRefs(wf: any): CredentialRef[] {
  const out: CredentialRef[] = [];
  const walk = (v: unknown, where: string, scope: CredentialRef['scope']) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(EXPRESSION)) if (CREDENTIAL.test(m[1])) out.push({ where, scope, ref: m[0] });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`, scope));
    else if (isMap(v)) for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`, scope);
  };
  if (!isMap(wf)) return out;
  for (const [k, v] of Object.entries(wf)) {
    if (k === 'jobs') continue;
    walk(v, k, k === 'env' ? 'workflow-env' : 'other');
  }
  for (const [id, job] of jobsOf(wf)) {
    for (const [k, v] of Object.entries(job)) {
      if (k === 'steps') continue;
      walk(v, `jobs.${id}.${k}`, k === 'env' ? 'job-env' : 'other');
    }
    stepsOf(job).forEach((s, i) => {
      for (const [k, v] of Object.entries(s)) {
        const scope = k === 'env' ? 'step-env' : k === 'with' ? 'step-with' : k === 'run' ? 'run' : 'other';
        walk(v, `jobs.${id}.steps[${i}].${k}`, scope);
      }
    });
  }
  return out;
}

/**
 * Credential refs anywhere but the env or with of the step that uses them. Workflow- or job-level env
 * hands the credential to every step, and one interpolated into `run:` lands in the script text, where
 * it can be logged or reshaped by an injected value.
 */
export function secretLeaks(wf: any): string[] {
  const out = credentialRefs(wf)
    .filter((r) => r.scope !== 'step-env' && r.scope !== 'step-with')
    .map((r) => `${r.where}: ${r.ref} must sit only in the env or with of the step that uses it`);
  // `secrets: inherit` (or a map) on a reusable-workflow call hands every secret to the called workflow.
  for (const [id, job] of jobsOf(wf)) if ('secrets' in job) out.push(`job ${id}: must not pass secrets to a reusable workflow`);
  return out;
}

/** Checkouts that leave the job's token in .git/config, where every later step can read it. */
export function persistedCredentials(wf: any): string[] {
  const out: string[] = [];
  for (const [id, job] of jobsOf(wf)) {
    stepsOf(job).forEach((s, i) => {
      if (typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@') && s.with?.['persist-credentials'] !== false)
        out.push(`${label(id, s, i)}: checkout must set persist-credentials: false`);
    });
  }
  return out;
}
