// The machine dashboard over a scratch FORGE_HOME: each dir registered by name (its default or the one
// given), one server started on port 0 with the fixture dist, and `api(name, path)` for a project
// route's path. Server tests use it instead of startServer, so none touches the suite's own home.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addProject } from '#engine/project/machine-index.ts';
import { startServer } from '../../lib/server/start.ts';
import type { RunningServer, ServerOptions } from '../../lib/server/types.ts';
import { FIXTURE_DIST } from '../dist.ts';

export type ServedProjects = RunningServer & {
  home: string;
  port: number;
  /** The registered names, in the order of `dirs`. */
  names: string[];
  /** A project route's path: `/api/p/<name><p>`. */
  api(name: string, p: string): string;
  /** Closes the server and removes the home. */
  cleanup(): Promise<void>;
};

export async function serveProjects(dirs: (string | { dir: string; name?: string })[], opts: ServerOptions = {}): Promise<ServedProjects> {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-machine-home-')));
  const names = dirs.map((d) => {
    const { dir, name } = typeof d === 'string' ? { dir: d, name: undefined } : d;
    return addProject(home, fs.realpathSync(dir), name ? { name } : {}).project.name;
  });
  const running = await startServer({ distDir: FIXTURE_DIST, port: 0, ...opts, home });
  return {
    ...running,
    home,
    port: Number(new URL(running.url).port),
    names,
    api: (name, p) => `/api/p/${name}${p}`,
    async cleanup() {
      await running.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
