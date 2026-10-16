// Loaded with --import into every Node process the suite starts (see test/helpers.ts).
// Node 22's compile cache skips type-stripped modules, so each CLI start strips every lib/*.ts again
// and pays for loading the stripper itself: about 150 ms a start, against 40 ms from this cache.
// Newer versions cache TypeScript, but still start the CLI about a quarter faster from here.
// Plain JS on purpose: a .ts hook would load the stripper on every start, which is the cost it avoids.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import * as nodeModule from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.env.FORGE_TEST_STRIP_CACHE;
const { registerHooks, stripTypeScriptTypes } = nodeModule;

// stripTypeScriptTypes is experimental: a Node without it just starts uncached.
if (dir && typeof registerHooks === 'function' && typeof stripTypeScriptTypes === 'function') {
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith('file:') || !url.endsWith('.ts') || url.includes('/node_modules/')) return nextLoad(url, context);
      const src = fs.readFileSync(fileURLToPath(url), 'utf8');
      // Keyed by content, so an edited file is never served stale.
      const file = path.join(dir, `${createHash('sha256').update(src).digest('hex')}.js`);
      let source;
      try {
        source = fs.readFileSync(file, 'utf8');
      } catch {
        // The API's one-time ExperimentalWarning would land on the stderr that tests assert on.
        const emitWarning = process.emitWarning;
        process.emitWarning = () => {};
        try {
          source = stripTypeScriptTypes(src);
        } finally {
          process.emitWarning = emitWarning;
        }
        // Parallel test files miss on the same files at once: write aside and rename, so a reader
        // never sees half a module.
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, source);
        fs.renameSync(tmp, file);
      }
      return { format: 'module', source, shortCircuit: true };
    },
  });
}
