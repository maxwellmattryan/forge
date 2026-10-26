// `npm run test:render [-- --scenario NAME]... [--dist DIR]`: seeds each dashboard scenario, serves it
// from a dashboard build in-process beside a second project and a removed one, and loads every view (and
// the job drawer), the Overview, the Machine page and a project switch in headless Chrome. A check fails
// on a console error, an uncaught page error, a same-origin 5xx, an expected text that never shows, or a
// failed load. Outside `npm test`: it needs Chrome and a build, and CI's `render` job runs it.
// docs/TESTING.md › "Dashboard scenarios and the render check".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { PLUGIN_ROOT } from '../lib/core/paths.ts';
import { startServer } from '../lib/server/start.ts';
import { addProject } from '../lib/engine/project/machine-index.ts';
import { VIEWS } from '../dashboard/src/lib/nav.ts';
import type { ViewId } from '../dashboard/src/lib/nav.ts';
import { SCENARIO_DIR, SCENARIO_ENV_DROPPED, catalogText, listScenarios, loadScenario, seedScenario } from './scenario.ts';
import type { Seeded } from './scenario.ts';

const USAGE = 'usage: npm run test:render [-- --scenario NAME]... [--dist DIR]';
const DEFAULT_DIST = path.join(PLUGIN_ROOT, 'dashboard', 'dist');
const TEXT_TIMEOUT_MS = 10_000;
// Errors a view logs after its text appears, such as a failed follow-up fetch, must land in this
// view's result rather than the next one's or nowhere, so each page stays open this long after its
// last expected text. This is a check script, not a test: a fixed wait here costs 300 ms a view.
const SETTLE_MS = 300;
const LOAD_TIMEOUT_MS = 30_000;
/** The repo's own scenario seeded once per run as every scenario's second project, whatever scenarioDir is. */
const COMPANION = 'empty';
const OTHER_PROJECT = 'other-project';
/** A registered project whose directory is gone: the Overview and the switcher show it as missing. */
const GONE_PROJECT = 'gone-project';

export type RenderCheckId = ViewId | 'overview' | 'machine' | 'switch' | 'add' | 'drawer';

export interface RenderProblem {
  scenario: string;
  view: RenderCheckId;
  problem: string;
}

export interface RenderResult {
  checked: number;
  passed: number;
  problems: RenderProblem[];
}

/** An error main() reports as its message and exits with `exitCode` (2 usage, 1 setup). */
class RenderError extends Error {
  declare exitCode: 1 | 2;
  constructor(message: string, exitCode: 1 | 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** The flags; throws the usage line on anything else. `scenarios` is null for all of them. */
export function parseRenderArgs(argv: string[]): { scenarios: string[] | null; dist: string } {
  const scenarios: string[] = [];
  let dist: string | null = null;
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined || value.startsWith('--')) throw new Error(USAGE);
    if (flag === '--scenario') scenarios.push(value);
    else if (flag === '--dist' && dist === null) dist = path.resolve(value);
    else throw new Error(USAGE);
  }
  return { scenarios: scenarios.length ? scenarios : null, dist: dist ?? DEFAULT_DIST };
}

/** Chrome from FORGE_RENDER_CHROME, else the installed Google Chrome; nothing is ever downloaded. */
export function launchBrowser(env: NodeJS.ProcessEnv = process.env): Promise<Browser> {
  const exe = env.FORGE_RENDER_CHROME;
  return chromium.launch(exe ? { executablePath: exe } : { channel: 'chrome' });
}

const firstLine = (e: unknown): string =>
  String((e as Error)?.message ?? e)
    .split('\n')
    .find((l) => l.trim())
    ?.trim() ?? 'unknown error';

/** Opens `url` in a fresh page, runs `act` on it, and returns every problem the page raised. */
async function checkPage(context: BrowserContext, url: string, act: (page: Page, problems: string[]) => Promise<void>): Promise<string[]> {
  const problems: string[] = [];
  const origin = new URL(url).origin;
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console error: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.origin === origin && r.status() >= 500) problems.push(`HTTP ${r.status()} ${u.pathname}`);
  });
  try {
    await page.goto(url, { waitUntil: 'load', timeout: LOAD_TIMEOUT_MS });
    await act(page, problems);
    await page.waitForTimeout(SETTLE_MS);
  } catch (e) {
    problems.push(`load failed: ${firstLine(e)}`);
  } finally {
    await page.close().catch(() => {});
  }
  return problems;
}

async function waitForTexts(scope: Page | ReturnType<Page['locator']>, texts: string[], timeout: number, problems: string[], exact = false): Promise<void> {
  for (const t of texts) {
    try {
      await scope.getByText(t, { exact }).first().waitFor({ state: 'visible', timeout });
    } catch {
      problems.push(`missing text "${t}"`);
    }
  }
}

/**
 * Checks each scenario's views and drawer at `#/p/<project>/<view>`, then the machine's pages (the Overview and the
 * Machine page, which must list all three projects), a switch to the companion through the sidebar switcher and its Add
 * project entry, which must open the Add project dialog in place without becoming the selection, refuse a relative
 * directory inline and, given the companion's directory, land on its Project page. Throws
 * a RenderError for an unknown scenario (exit 2), and for a build without manifest.json or a Chrome that won't start
 * (exit 1): neither ever passes.
 */
export async function renderCheck(opts: { scenarios?: string[]; scenarioDir?: string; dist?: string; textTimeoutMs?: number; log?: (s: string) => void } = {}): Promise<RenderResult> {
  const dir = opts.scenarioDir ?? SCENARIO_DIR;
  const dist = opts.dist ?? DEFAULT_DIST;
  const timeout = opts.textTimeoutMs ?? TEXT_TIMEOUT_MS;
  const log = opts.log ?? (() => {});
  const names = opts.scenarios ?? listScenarios(dir);
  for (const n of names) {
    try {
      loadScenario(n, dir);
    } catch (e) {
      throw new RenderError((e as Error).message, 2);
    }
  }
  if (!fs.existsSync(path.join(dist, 'manifest.json'))) throw new RenderError(`render check: ${dist} has no manifest.json: run npm run build:dashboard`, 1);
  let browser: Browser;
  try {
    browser = await launchBrowser();
  } catch (e) {
    throw new RenderError(`render check: Chrome did not start (${firstLine(e)}); install Google Chrome or set FORGE_RENDER_CHROME to a Chrome or Chromium binary`, 1);
  }

  const result: RenderResult = { checked: 0, passed: 0, problems: [] };
  const record = (scenario: string, view: RenderCheckId, problems: string[], ms: number) => {
    result.checked++;
    if (!problems.length) {
      result.passed++;
      log(`ok   ${scenario} › ${view}  ${ms} ms`);
    }
    for (const problem of problems) {
      result.problems.push({ scenario, view, problem });
      log(`FAIL ${scenario} › ${view}: ${problem}`);
    }
  };
  const timed = async (scenario: string, view: RenderCheckId, run: () => Promise<string[]>): Promise<void> => {
    const started = Date.now();
    const problems = await run();
    record(scenario, view, problems, Date.now() - started);
  };
  let companion: Seeded | null = null;
  try {
    companion = await seedScenario(COMPANION, { dir: SCENARIO_DIR, log });
    const other = companion;
    for (const name of names) {
      const seeded = await seedScenario(name, { dir, log });
      // A fresh context per scenario, so one scenario's localStorage prefs never reach the next.
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      let server: Awaited<ReturnType<typeof startServer>> | null = null;
      try {
        // Through the machine server, as `forge dash` serves it: the scenario's repo registered in its own home, beside
        // the companion and a project whose directory is gone.
        const home = path.join(path.dirname(seeded.root), 'forge-home');
        const { project } = addProject(home, fs.realpathSync(seeded.root));
        addProject(home, fs.realpathSync(other.root), { name: OTHER_PROJECT });
        addProject(home, path.join(path.dirname(seeded.root), GONE_PROJECT), { name: GONE_PROJECT });
        server = await startServer({ home, port: 0, distDir: dist });
        const base = `${server.url}/`;
        const at = (view: ViewId): string => `${base}#/p/${project.name}/${view}`;
        for (const { id } of VIEWS) {
          await timed(name, id, () => checkPage(context, at(id), (page, p) => waitForTexts(page, seeded.expect.views[id], timeout, p)));
        }
        const drawer = seeded.expect.drawer;
        if (drawer && Object.keys(seeded.jobs).length) {
          const started = Date.now();
          const problems = await checkPage(context, at('pipeline'), async (page, p) => {
            try {
              await page.getByText(drawer.title, { exact: true }).first().click({ timeout });
            } catch {
              p.push(`could not open the drawer for "${drawer.title}"`);
              return;
            }
            await waitForTexts(page.locator('#drawer'), [drawer.title, ...drawer.text], timeout, p);
          });
          record(name, 'drawer', problems, Date.now() - started);
        }
        // The machine's pages, with no project selected: every registered project by name, in the page's own content.
        const registered = [project.name, OTHER_PROJECT, GONE_PROJECT];
        // And the Overview's graph and machine sections, by their titles.
        const sections = ['overview.shippedTitle', 'overview.costTitle', 'overview.machineTitle'].map(catalogText);
        await timed(name, 'overview', () => checkPage(context, base, (page, p) => waitForTexts(page.locator('#view'), [...registered, ...sections], timeout, p, true)));
        await timed(name, 'machine', () => checkPage(context, `${base}#/machine`, (page, p) => waitForTexts(page.locator('#view'), registered, timeout, p, true)));
        // Picking the companion in the sidebar switcher opens its same view, with its content.
        await timed(name, 'switch', () =>
          checkPage(context, at('issues'), async (page, p) => {
            try {
              await page.locator('#project-switcher').click({ timeout });
              await page.getByRole('option', { name: OTHER_PROJECT }).click({ timeout });
              await page.waitForURL((u) => u.hash === `#/p/${OTHER_PROJECT}/issues`, { timeout });
            } catch {
              p.push(`could not switch to ${OTHER_PROJECT} in the project switcher`);
              return;
            }
            await waitForTexts(page.locator('#view'), other.expect.views.issues, timeout, p);
          }),
        );
        // Add project, below the projects, opens the Add project dialog where the person is, never becoming the switcher's
        // selection; Escape closes it in place. A relative directory is refused inline, and the companion's directory
        // (already registered, so added: false) closes the dialog on its Project page.
        const addLabel = catalogText('switcher.add');
        const addTitle = catalogText('addProject.title');
        await timed(name, 'add', () =>
          checkPage(context, at('issues'), async (page, p) => {
            const issues = `#/p/${project.name}/issues`;
            const trigger = page.locator('#project-switcher');
            const dialog = page.getByRole('dialog', { name: addTitle });
            const step = async (what: string, run: () => Promise<void>): Promise<boolean> => {
              try {
                await run();
                return true;
              } catch {
                p.push(what);
                return false;
              }
            };
            const open = () =>
              step('could not choose Add project in the project switcher', async () => {
                await trigger.click({ timeout });
                await page.getByRole('option', { name: addLabel }).click({ timeout });
                await dialog.waitFor({ state: 'visible', timeout });
              });
            const stayed = (what: string) => {
              if (new URL(page.url()).hash !== issues) p.push(`${what} changed the hash to ${new URL(page.url()).hash}`);
            };
            if (!(await open())) return;
            stayed('opening Add project');
            if ((await trigger.textContent({ timeout }))?.includes(addLabel)) p.push('Add project became the selection');
            if (!(await step('Escape did not close the Add project dialog', async () => {
              await page.keyboard.press('Escape');
              await dialog.waitFor({ state: 'hidden', timeout });
            })))
              return;
            stayed('Escape');
            if (!(await open())) return;
            const add = dialog.getByRole('button', { name: catalogText('addProject.add'), exact: true });
            if (!(await step('a relative directory was not refused inline', async () => {
              await page.locator('#add-project-path').fill('src/app', { timeout });
              await add.click({ timeout });
              await dialog.getByText(catalogText('addProject.pathRelative'), { exact: true }).waitFor({ state: 'visible', timeout });
            })))
              return;
            stayed('a refused directory');
            await step(`adding ${other.root} did not open ${OTHER_PROJECT}'s Project page`, async () => {
              await page.locator('#add-project-path').fill(other.root, { timeout });
              await add.click({ timeout });
              await page.waitForURL((u) => u.hash === `#/p/${OTHER_PROJECT}/project`, { timeout });
              await dialog.waitFor({ state: 'hidden', timeout });
            });
          }),
        );
      } finally {
        await server?.close().catch(() => {});
        await context.close().catch(() => {});
        seeded.cleanup();
      }
    }
  } finally {
    companion?.cleanup();
    await browser.close().catch(() => {});
  }
  return result;
}

export const renderExitCode = (result: RenderResult): 0 | 1 => (result.checked > 0 && result.passed === result.checked && !result.problems.length ? 0 : 1);

async function main(): Promise<void> {
  // The in-process server runs as a plain local process against the scratch root, never as part of
  // the daemon session or job that started this script.
  for (const k of Object.keys(process.env)) if (SCENARIO_ENV_DROPPED.test(k)) delete process.env[k];
  let args: ReturnType<typeof parseRenderArgs>;
  try {
    args = parseRenderArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(2);
  }
  const started = Date.now();
  const names = args.scenarios ?? [];
  let result: RenderResult;
  try {
    result = await renderCheck({
      scenarios: args.scenarios ?? undefined,
      dist: args.dist,
      log: (s) => (s.startsWith('ok ') ? process.stdout : process.stderr).write(`${s}\n`),
    });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(e instanceof RenderError ? e.exitCode : 1);
  }
  const scenarios = names.length || listScenarios().length;
  process.stdout.write(`render check: ${result.passed}/${result.checked} views passed in ${scenarios} scenarios (${((Date.now() - started) / 1000).toFixed(1)} s)\n`);
  process.exit(renderExitCode(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
