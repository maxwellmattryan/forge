// The drawer's Screenshots card: UI evidence that agents saved to the job's screenshots/ dir.
// No DOM access, so node:test can import it.
import { esc } from './util.ts';

/**
 * @param files paths relative to the job dir (`screenshots/…`)
 * @returns HTML, or '' when there is nothing to show
 */
export function screenshotsPanel(jobId: string, files: string[] | undefined): string {
  if (!Array.isArray(files) || !files.length) return '';
  const tiles = files
    .map((rel) => {
      const url = `/api/jobs/${encodeURIComponent(jobId)}/file?path=${encodeURIComponent(rel)}`;
      const name = String(rel).replace(/^screenshots\//, '');
      return `<a class="sheet clickable block min-w-0 p-1" href="${esc(url)}" target="_blank" rel="noopener"><img loading="lazy" alt="${esc(name)}" class="w-full h-32 object-contain bg-panel" src="${esc(url)}"><div class="mt-1 truncate font-mono text-[11px] text-muted">${esc(name)}</div></a>`;
    })
    .join('');
  return `<div class="sheet ticks p-4 flex flex-col gap-3"><span class="tk"></span><div class="flex items-center justify-between gap-2"><h3 class="h section">Screenshots</h3><span class="label">${files.length}</span></div><div class="grid grid-cols-2 md:grid-cols-3 gap-2">${tiles}</div></div>`;
}
