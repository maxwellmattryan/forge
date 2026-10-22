# lib/core/format/

File and terminal formats Forge reads and writes itself, with no dependencies: YAML, zip archives and ANSI styles.

- Each file is a pure leaf: no job state, no config, no process.

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `ansi.ts` | ANSI styles and terminal-safe text for human output. |
| `yaml.ts` | A deliberately small YAML subset so Forge stays zero-dependency. |
| `zip.ts` | A minimal zip writer for the support bundle (lib/engine/ops/bundle.ts): Forge has no runtime dependencies, and zlib gives deflate and CRC-32. |
<!-- forge:map:end -->
