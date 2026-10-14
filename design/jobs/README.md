# Running the migration through Forge

Two ways, same five jobs.

**One request, let the planner split it.** Commit `design/` on `main`, add the resource below to `.forge/config.yml`, then paste `EPIC.md` into `/forge` (or the command bar). With `pipeline.split: ask` the planner proposes the five children with their dependencies; `/forge approve <id>` creates them and runs the unblocked one. Each child reads its own file here as its request.

**One job at a time.** Create a GitHub issue from each `0N-*.md` (title = the first line) and run `/forge issue <ref>` in order, or paste each file into `/forge` after the previous PR merges.

Config (`.forge/config.yml`), so the spec-writer and designer read the drawing before they write:

```yaml
resources:
  - { name: Drafting design system, kind: files, url: design/README.md, use: "source of truth for the dashboard's look: tokens, components, states; MIGRATION.md maps old classes to new" }
pipeline:
  design: reference   # the designer grounds each spec in design/; `mockup` if you want a side-by-side page per job
```

The `ui` and `accessibility` lenses already fire on `dashboard/**`; their checks compare against `design/components/*/preview.html`.
