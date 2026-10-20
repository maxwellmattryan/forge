// `forge version` in human mode.
import { has, txt } from './kit.ts';
import type { Renderer } from './kit.ts';

export const version: Renderer = (d) => (has(d, 'version') && Object.keys(d).length === 1 ? `forge ${txt(d.version)}` : null);
