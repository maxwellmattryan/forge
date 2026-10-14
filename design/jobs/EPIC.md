Restyle the dashboard in the Drafting design system

The dashboard's look is being replaced by the Drafting design system in `design/` (read `design/README.md` first, then `design/MIGRATION.md`; `design/components/*/preview.html` shows every component in both themes). The result is an engineering drawing of the factory: a cyanotype sheet (or vellum, the light theme) ruled with an 8/64px grid, everything drawn in 1px line, hatching instead of tints, red markup where a person is needed, no rounded corners, no blur, no gradients. Behaviour, routes, `/api` shapes, config keys and copy semantics do not change; this is visual, plus two new appearance preferences.

Split this into five jobs, one PR each, in this order, each depending on the previous one:

1. Foundations — `design/jobs/01-foundations.md`
2. Iconography — `design/jobs/02-iconography.md` (depends on 1)
3. Shell — `design/jobs/03-shell.md` (depends on 2)
4. Job surfaces — `design/jobs/04-job-surfaces.md` (depends on 3)
5. Appearance settings and polish — `design/jobs/05-appearance-and-polish.md` (depends on 4)

Each job's file is its request: goal, behaviour, acceptance criteria and approach. Shared rules for all five: the dashboard loads no external assets (fonts are vendored, OFL); new classes are Tailwind v4 `@utility`s named as in `design/drafting.css`; all copy goes through `en.json`; both themes are checked at desktop and phone width; `dashboard/dist/` is rebuilt in the same commit; `npm test`, `npm run check:dashboard` and the i18n and dist tests stay green.
