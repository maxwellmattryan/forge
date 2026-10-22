// The dashboard's small UI helpers under dashboard/src/lib/, one describe per module: where
// tooltips, menus and toasts open, message senders, the protected-paths summary, agent activity,
// the screenshots panel and the job drawer's action dock.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { TIP_DELAY_MS, placeTip } from '../dashboard/src/lib/tooltip.ts';
import { keepFocus, placeMenu } from '../dashboard/src/lib/menu.ts';
import { toastPlacement } from '../dashboard/src/lib/toast-place.ts';
import { TINT, logSender, threadSender, type Sender } from '../dashboard/src/lib/sender.ts';
import type { ItemKind } from '../dashboard/src/lib/session-parse.ts';
import type { ThreadFrom } from '../dashboard/src/lib/thread.ts';
import { PROTECTED_ROWS, protectedSummary, showParkReason } from '../dashboard/src/lib/protected.ts';
import type { ProtectedHit, ProtectedPaths } from '../dashboard/src/lib/types.ts';
import { activityLine, newestActivity, ownerLiveness, roundAgents, sortedActivity } from '../dashboard/src/lib/agent-activity.ts';
import { screenshotTiles } from '../dashboard/src/lib/screenshots.ts';
import { safeUrl } from '../dashboard/src/lib/markdown.ts';
import { dockModel } from '../dashboard/src/lib/dock.ts';

describe('tooltip', () => {
  // dashboard/src/lib/tooltip.ts: where an icon button's tooltip opens.
  const VIEW = { vw: 1440, vh: 900 };
  // A 28×28 button at x 900..928, y 100..128.
  const BUTTON = { top: 100, bottom: 128, left: 900, right: 928 };

  test('hover waits 400 ms', () => {
    assert.equal(TIP_DELAY_MS, 400);
  });

  test('placeTip centres the tip 6 px below the button when there is room', () => {
    // Centre 914, an 80×24 tip: left 874, top 128 + 6.
    assert.deepEqual(placeTip({ ...BUTTON, ...VIEW, width: 80, height: 24 }), { left: 874, top: 134 });
  });

  test('placeTip keeps the tip 8 px inside the right edge', () => {
    const at = placeTip({ top: 100, bottom: 128, left: 1410, right: 1438, ...VIEW, width: 120, height: 24 });
    assert.deepEqual(at, { left: 1440 - 120 - 8, top: 134 });
  });

  test('placeTip keeps the tip 8 px inside the left edge', () => {
    const at = placeTip({ top: 100, bottom: 128, left: 0, right: 28, ...VIEW, width: 120, height: 24 });
    assert.deepEqual(at, { left: 8, top: 134 });
  });

  test('placeTip flips above near the bottom', () => {
    // Below would end at 860 + 6 + 40 = 906, past 900 - 8: above at 832 - 6 - 40.
    assert.deepEqual(placeTip({ top: 832, bottom: 860, left: 900, right: 928, ...VIEW, width: 80, height: 40 }), { left: 874, top: 786 });
    // Ending exactly 8 px above the bottom still fits below.
    assert.deepEqual(placeTip({ top: 800, bottom: 828, left: 900, right: 928, ...VIEW, width: 80, height: 58 }), { left: 874, top: 834 });
    // One pixel more flips.
    assert.equal(placeTip({ top: 800, bottom: 828, left: 900, right: 928, ...VIEW, width: 80, height: 59 }).top, 800 - 6 - 59);
  });

  test('placeTip pins a tip larger than the viewport to the top-left margin', () => {
    assert.deepEqual(placeTip({ top: 50, bottom: 78, left: 100, right: 128, vw: 200, vh: 100, width: 300, height: 150 }), { left: 8, top: 8 });
  });
});

describe('menu', () => {
  // dashboard/src/lib/menu.ts: where the session log's popovers open.
  const VIEW = { vw: 1440, vh: 900 };

  test('placeMenu opens below, right-aligned', () => {
    // A 256×200 panel under a trigger at x 900..1000, y 100..128.
    assert.deepEqual(placeMenu({ top: 100, bottom: 128, right: 1000, ...VIEW, width: 256, height: 200 }), { left: 744, top: 132 });
    assert.deepEqual(placeMenu({ top: 100, bottom: 128, right: 1000, ...VIEW, width: 256, height: 200, gap: 10 }), { left: 744, top: 138 }, 'the gap is configurable');
    // Fits exactly below: stays below.
    assert.deepEqual(placeMenu({ top: 600, bottom: 628, right: 1000, ...VIEW, width: 256, height: 260 }), { left: 744, top: 632 });
  });

  test('placeMenu flips above', () => {
    // Near the bottom: 900 - 828 - 4 - 8 = 60 below, 800 - 4 - 8 = 788 above.
    assert.deepEqual(placeMenu({ top: 800, bottom: 828, right: 1000, ...VIEW, width: 256, height: 200 }), { left: 744, top: 596 });
    // Too tall for below but above has less room: stays below, clamped to the bottom gutter.
    assert.deepEqual(placeMenu({ top: 300, bottom: 328, right: 1000, ...VIEW, width: 256, height: 600 }), { left: 744, top: 292 });
  });

  test('placeMenu clamps to the gutter', () => {
    // A trigger at the left edge: the panel's left stays 8px in.
    assert.equal(placeMenu({ top: 100, bottom: 128, right: 40, ...VIEW, width: 256, height: 200 }).left, 8);
    // A trigger past the right edge: the panel's right edge stays 8px in.
    assert.equal(placeMenu({ top: 100, bottom: 128, right: 1500, ...VIEW, width: 256, height: 200 }).left, 1440 - 8 - 256);
    // A phone narrower than the panel: it shrinks to the viewport less both gutters and starts at the gutter.
    assert.equal(placeMenu({ top: 100, bottom: 128, right: 200, vw: 240, vh: 600, width: 256, height: 200 }).left, 8);
    // A panel taller than the viewport sits at the top gutter.
    assert.equal(placeMenu({ top: 300, bottom: 328, right: 1000, vw: 1440, vh: 400, width: 256, height: 500 }).top, 8);
    // A trigger above the viewport top (scrolled): the panel stays 8px in.
    assert.equal(placeMenu({ top: -60, bottom: -32, right: 1000, ...VIEW, width: 256, height: 200 }).top, 8);
  });

  test('placeMenu aligns start edges', () => {
    // A Select's list under a trigger at x 300..500: left edges meet; vertical placement is the same as end-aligned.
    assert.deepEqual(placeMenu({ top: 100, bottom: 128, left: 300, right: 500, align: 'start', ...VIEW, width: 256, height: 200 }), { left: 300, top: 132 });
    assert.deepEqual(placeMenu({ top: 800, bottom: 828, left: 300, right: 500, align: 'start', ...VIEW, width: 256, height: 200 }), { left: 300, top: 596 }, 'flips above');
    // Near the right edge: the list's right edge stays 8px in.
    assert.equal(placeMenu({ top: 100, bottom: 128, left: 1300, right: 1400, align: 'start', ...VIEW, width: 256, height: 200 }).left, 1440 - 8 - 256);
    // A trigger scrolled past the left edge: the list stays 8px in.
    assert.equal(placeMenu({ top: 100, bottom: 128, left: -40, right: 100, align: 'start', ...VIEW, width: 256, height: 200 }).left, 8);
    // A 360px phone with a list wider than the viewport: it starts at the gutter.
    assert.equal(placeMenu({ top: 100, bottom: 128, left: 200, right: 340, align: 'start', vw: 360, vh: 700, width: 400, height: 200 }).left, 8);
    // align 'end' is the default: an explicit end gives the same as none.
    const end = { top: 100, bottom: 128, left: 300, right: 1000, ...VIEW, width: 256, height: 200 };
    assert.deepEqual(placeMenu({ ...end, align: 'end' }), placeMenu({ top: 100, bottom: 128, right: 1000, ...VIEW, width: 256, height: 200 }));
  });

  /** A stand-in for the DOM bits keepFocus touches: focus() records itself as the document's active element. */
  function fakeDom() {
    const doc = { activeElement: null as unknown, body: { name: 'body' } as unknown };
    type Node = { name: string; focus(): void; [k: string]: unknown };
    const node = (name: string, extra: Record<string, unknown> = {}): Node => {
      const n: Node = { name, ...extra, focus: () => void (doc.activeElement = n) };
      return n;
    };
    return { doc, node };
  }

  test('keepFocus refocuses a button that disabled itself, only if it had focus and nothing took it', () => {
    const { doc, node } = fakeDom();
    const button = node('button');
    button.focus();
    let restore = keepFocus(button as any, doc as any);
    doc.activeElement = doc.body; // Disabled while pending: the browser drops focus to <body>.
    restore();
    assert.equal(doc.activeElement, button);
    restore = keepFocus(button as any, doc as any);
    const other = node('other');
    other.focus();
    restore();
    assert.equal(doc.activeElement, other, 'focus that moved on stays put');
    doc.activeElement = doc.body;
    restore = keepFocus(button as any, doc as any);
    restore();
    assert.equal(doc.activeElement, doc.body, 'a button clicked without focus (Safari) is not focused afterwards');
  });
});

describe('toast', () => {
  // dashboard/src/lib/toast-place.ts: the toast never covers the board's controls, the job pane's dock or the status bar.
  test('toast placement avoids the pane, the dock and the status bar', () => {
    const at = (o: Partial<Parameters<typeof toastPlacement>[0]>) => toastPlacement({ narrow: false, paneOpen: false, paneWidth: 640, ...o });
    // md and up: the bottom right, left of an open drawer.
    assert.deepEqual(at({ paneOpen: true }), { edge: 'bottom-right', right: 640 }, 'drawer open: left of the drawer');
    assert.deepEqual(at({ paneOpen: true, paneWidth: 360 }), { edge: 'bottom-right', right: 360 });
    assert.deepEqual(at({ paneOpen: true, paneWidth: -5 }), { edge: 'bottom-right', right: 0 }, 'never right of the viewport edge');
    assert.deepEqual(at({}), { edge: 'bottom-right', right: 0 }, 'drawer closed: the viewport edge');
    // Below md, top-centre.
    assert.deepEqual(at({ narrow: true }), { edge: 'top' }, 'phone, drawer closed');
    assert.deepEqual(at({ narrow: true, paneOpen: true }), { edge: 'top' }, 'phone, drawer open');
  });
});

describe('sender', () => {
  // dashboard/src/lib/sender.ts: who a Thread message or a session log line comes from, and its tint.
  test('senders map log kinds and thread origins to tints', () => {
    assert.deepEqual(TINT, { you: '', cli: 'tint cli', agent: 'tint agent', forge: 'tint forge' } satisfies Record<Sender, string>);
    // Every ItemKind: the Record type makes typecheck fail when a new kind is missing from the table.
    const want: Record<ItemKind, 'agent' | 'cli'> = {
      text: 'agent', thinking: 'agent', tool: 'agent', subagent: 'agent',
      supervisor: 'cli', init: 'cli', result: 'cli', task: 'cli', stderr: 'cli', raw: 'cli', truncated: 'cli', 'rate-limit': 'cli', denied: 'cli', hook: 'cli', other: 'cli', turn: 'cli',
    };
    for (const [kind, sender] of Object.entries(want)) assert.equal(logSender(kind as ItemKind), sender, kind);
    // Every ThreadFrom, held complete by the Record type the same way.
    const wantFrom: Record<ThreadFrom, Sender> = { you: 'you', tracker: 'you', cli: 'cli', forge: 'forge' };
    for (const [from, sender] of Object.entries(wantFrom)) assert.equal(threadSender(from as ThreadFrom), sender, from);
    // People keep the plain plate; the rest tint.
    assert.equal(TINT[threadSender('you')], '');
    assert.equal(TINT[threadSender('tracker')], '');
    assert.equal(TINT[logSender('text')], 'tint agent');
    assert.equal(TINT[logSender('supervisor')], 'tint cli');
    assert.equal(TINT[threadSender('forge')], 'tint forge');
  });
});

describe('protected', () => {
  // dashboard/src/lib/protected.ts: what the card chip, the drawer chip and the Needs-you list show.
  const hit = (path: string, rule: number, reason: string): ProtectedHit => ({ path, rule, glob: path, reason, blob: null });
  const flag = (hits: ProtectedHit[], more = 0): ProtectedPaths => ({ hits, more, at: '2026-10-01T10:00:00.000Z', gate: 'commit', head: null });

  test('protectedSummary', () => {
    assert.equal(protectedSummary({ protectedPaths: null }), null);
    assert.equal(protectedSummary({ protectedPaths: flag([]) }), null, 'no hits: nothing to show');
    assert.equal(protectedSummary({ protectedPaths: { hits: 'x' } as any }), null, 'a malformed flag shows nothing');

    const s = protectedSummary({ protectedPaths: flag([hit('package-lock.json', 4, 'dependency lockfile'), hit('.github/workflows/ci.yml', 1, 'CI/CD configuration'), hit('web/package-lock.json', 4, 'dependency lockfile')]) });
    assert.deepEqual(s, {
      reasons: ['CI/CD configuration', 'dependency lockfile'],
      rows: [
        { path: 'package-lock.json', reason: 'dependency lockfile' },
        { path: '.github/workflows/ci.yml', reason: 'CI/CD configuration' },
        { path: 'web/package-lock.json', reason: 'dependency lockfile' },
      ],
      more: 0,
    });

    const many = protectedSummary({ protectedPaths: flag(Array.from({ length: 13 }, (_, i) => hit(`db/migrations/${i}.sql`, 3, 'database migrations')), 7) })!;
    assert.equal(PROTECTED_ROWS, 10);
    assert.equal(many.rows.length, 10);
    assert.equal(many.more, 3 + 7, 'unlisted hits and the flag’s own more');
    assert.deepEqual(many.reasons, ['database migrations']);

    // Paths are data: returned as they are, for the components to render as escaped text.
    const odd = protectedSummary({ protectedPaths: flag([hit('<img src=x onerror=alert(1)>.yml', 1, 'CI/CD configuration')]) })!;
    assert.equal(odd.rows[0].path, '<img src=x onerror=alert(1)>.yml');
  });

  test('showParkReason drops a protected park reason the path list repeats', () => {
    const f = flag([hit('package-lock.json', 4, 'dependency lockfile')]);
    assert.equal(showParkReason({ reason: 'protected paths: package-lock.json', protectedPaths: f }), false);
    assert.equal(showParkReason({ reason: 'protected paths: package-lock.json', protectedPaths: null }), true, 'no list: the reason stays');
    assert.equal(showParkReason({ reason: 'escalated: risky change', protectedPaths: f }), true, 'another park keeps its reason');
    assert.equal(showParkReason({ reason: null, protectedPaths: f }), false);
  });
});

describe('agent-activity', () => {
  const NOW = Date.parse('2026-10-15T10:10:00.000Z');
  const act = (role: string, startedAt: string | null, over: Record<string, unknown> = {}) => ({ role, model: 'opus', startedAt, last: null, ...over }) as any;
  const owner = (status: string, renewedAt: string | null) => ({ status, session: 's', since: '2026-10-15T09:00:00.000Z', renewedAt, expiresAt: null, epoch: 1, jobSession: false }) as any;

  test('activityLine gives role, model, elapsed time and the last thing', () => {
    const a = act('reviewer:security', '2026-10-15T10:06:00.000Z', { last: { kind: 'tool', text: 'Read lib/server.ts', at: null } });
    assert.deepEqual(activityLine(a, NOW), { role: 'reviewer:security', model: 'opus', elapsed: '4m 0s', last: 'Read lib/server.ts' });
    assert.equal(activityLine(act('builder', '2026-10-15T10:06:00.000Z', { model: null }), NOW).model, '—');
    assert.equal(activityLine(act('builder', '2026-10-15T10:06:00.000Z'), NOW).last, null, 'no transcript: the line ends after the elapsed time');
    assert.equal(activityLine(act('builder', null), NOW).elapsed, '—');
    // Markup stays a plain string for the template to escape.
    assert.equal(activityLine(act('b', null, { last: { kind: 'text', text: '<img onerror=x>', at: null } }), NOW).last, '<img onerror=x>');
  });

  test('newestActivity picks the latest start and counts the rest', () => {
    assert.deepEqual(newestActivity([]), { newest: null, more: 0 });
    assert.deepEqual(newestActivity(undefined), { newest: null, more: 0 });
    const list = [act('a', '2026-10-15T10:00:00.000Z'), act('b', '2026-10-15T10:05:00.000Z'), act('c', null)];
    const r = newestActivity(list);
    assert.equal(r.newest?.role, 'b');
    assert.equal(r.more, 2);
    assert.deepEqual(sortedActivity(list).map((x) => x.role), ['b', 'a', 'c']);
  });

  test('ownerLiveness tones a live and an expired lease, and hides a missing driver', () => {
    assert.deepEqual(ownerLiveness(owner('live', '2026-10-15T10:09:40.000Z'), NOW), { tone: 'ok', status: 'live', age: '20s ago' });
    assert.deepEqual(ownerLiveness(owner('expired', '2026-10-15T09:29:00.000Z'), NOW), { tone: 'warn', status: 'expired', age: '41m ago' });
    assert.deepEqual(ownerLiveness(owner('expired', null), NOW), { tone: 'warn', status: 'expired', age: '1h ago' }, 'never renewed: the age is the claim time');
    assert.deepEqual(ownerLiveness(owner('none', null), NOW), { tone: null, status: null, age: null });
    assert.deepEqual(ownerLiveness(null, NOW), { tone: null, status: null, age: null });
  });

  test('roundAgents sorts newest first and times running agents live', () => {
    const row = (role: string, status: string, startedAt: string | null, durationMs: number | null) => ({ role, status, model: 'opus', startedAt, endedAt: null, durationMs, tokens: null, transcript: true });
    const rows = roundAgents({ agents: [row('builder', 'done', '2026-10-15T09:00:00.000Z', 60_000), row('reviewer:code', 'running', '2026-10-15T10:08:00.000Z', null), row('reviewer:ui', 'lost', '2026-10-15T09:30:00.000Z', 1000)] }, NOW);
    assert.deepEqual(rows.map((r) => r.role), ['reviewer:code', 'reviewer:ui', 'builder']);
    assert.equal(rows[0].running, true);
    assert.equal(rows[0].elapsedMs, 120_000);
    assert.equal(rows[2].elapsedMs, 60_000);
    assert.deepEqual(roundAgents(null, NOW), []);
  });
});

describe('screenshots', () => {
  test('builds encoded same-origin URLs and raw names', () => {
    assert.deepEqual(screenshotTiles('job-1', []), []);
    assert.deepEqual(screenshotTiles('job-1', undefined), []);

    const evil = 'screenshots/"><img src=x onerror=alert(1)>.png';
    const tiles = screenshotTiles('job-1', [evil, 'screenshots/nested/ac18-drawer-375.png']);
    assert.deepEqual(tiles, [
      { url: `/api/jobs/job-1/file?path=${encodeURIComponent(evil)}`, name: '"><img src=x onerror=alert(1)>.png' },
      { url: `/api/jobs/job-1/file?path=${encodeURIComponent('screenshots/nested/ac18-drawer-375.png')}`, name: 'nested/ac18-drawer-375.png' },
    ], 'the name is raw text without screenshots/: Svelte escapes it');
    assert.doesNotMatch(tiles[0].url, /["<> ]/, 'the path is percent-encoded');

    // The job id is encoded too, and every URL stays same-origin through safeUrl.
    const quoted = screenshotTiles('a"b', ['screenshots/a.png']);
    assert.equal(quoted[0].url, '/api/jobs/a%22b/file?path=screenshots%2Fa.png');
    for (const t of [...tiles, ...quoted]) assert.equal(safeUrl(t.url), t.url, t.url);
  });
});

describe('dock', () => {
  // The job drawer's action dock (dashboard/src/lib/dock.ts). Its resume half is resumeModel's, which test/dashboard-view.test.ts owns.
  const p = (id: string) => ({ id, tool: 'Bash', input: '{"command":"ls"}', description: null, agentId: null, blockedPath: null, sessionRules: [], sessionDirs: [], at: '2026-10-14T00:00:01Z' });
  const os = (status: string): any => ({ status, session: status === 'none' ? null : 's1', since: null, renewedAt: null, expiresAt: null, epoch: 1, jobSession: false });
  const pool = (j1: unknown[] = []): any => ({
    inbox: { scope: '_inbox', permissions: [p('i1')] },
    jobs: { j1: { scope: 'j1', permissions: j1 }, other: { scope: 'other', permissions: [p('o1')] } },
  });

  test('dockModel: when the dock shows and what it holds', () => {
    const job = (state: string, o: any = {}): any => ({ id: 'j1', kind: 'feature', state, waitingOn: null, ...o });
    const cases: [string, any, any, { show: boolean; actionable: boolean; prompts: string[] }][] = [
      ['running, live owner, no prompts', job('running', { ownerStatus: os('live') }), pool(), { show: false, actionable: false, prompts: [] }],
      ['running, no ownerStatus, no prompts', job('running'), pool(), { show: false, actionable: false, prompts: [] }],
      ['waiting on pr-review', job('waiting', { waitingOn: 'pr-review', ownerStatus: os('none') }), pool(), { show: false, actionable: false, prompts: [] }],
      ['waiting on spec-approval', job('waiting', { waitingOn: 'spec-approval', ownerStatus: os('none') }), pool(), { show: true, actionable: true, prompts: [] }],
      ['waiting on input', job('waiting', { waitingOn: 'input', ownerStatus: os('live') }), pool(), { show: true, actionable: true, prompts: [] }],
      ['failed', job('failed', { ownerStatus: os('none') }), pool(), { show: true, actionable: true, prompts: [] }],
      ['blocked', job('blocked', { ownerStatus: os('live') }), pool(), { show: true, actionable: true, prompts: [] }],
      ['running, expired lease', job('running', { ownerStatus: os('expired') }), pool(), { show: true, actionable: false, prompts: [] }],
      ['running, own prompt', job('running', { ownerStatus: os('live') }), pool([p('j1a'), { tool: 'Bash' }]), { show: true, actionable: false, prompts: ['j1a'] }],
    ];
    for (const [name, j, pl, want] of cases) {
      const m = dockModel(j, pl);
      assert.equal(m.show, want.show, `${name}: show`);
      assert.equal(m.actionable, want.actionable, `${name}: actionable`);
      assert.deepEqual(
        m.prompts.map((x) => [x.scope, x.prompt.id]),
        want.prompts.map((id) => ['j1', id]),
        `${name}: only the job's own prompts, never the inbox's or another job's`,
      );
    }
    assert.equal(dockModel(job('running', { ownerStatus: os('expired') }), pool()).resume.show, true, 'the expired lease shows the dock through resume');
    assert.equal(dockModel(job('done'), null).show, false, 'no pool and nothing to do');
    assert.equal(dockModel(job('cancelled'), undefined).show, false);
    assert.equal(dockModel(job('running', { ownerStatus: os('live') }), { jobs: { x: { scope: 'j1', permissions: [p('k')] } } } as any).prompts.length, 1, 'scope, not the map key, picks the session');
  });
});
