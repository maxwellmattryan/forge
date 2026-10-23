// The drawer's Screenshots card: UI evidence that agents saved to the job's screenshots/ dir.
// No DOM access, so node:test can import it. ScreenshotsPanel.svelte renders the tiles; Svelte escapes the names.

/**
 * @param files paths relative to the job dir (`screenshots/…`)
 * @returns one tile per file: its same-origin URL (job id and path percent-encoded) and its name without `screenshots/`
 */
export function screenshotTiles(jobId: string, files: string[] | undefined): { url: string; name: string }[] {
  if (!Array.isArray(files)) return [];
  return files.map((rel) => ({
    url: `/api/jobs/${encodeURIComponent(jobId)}/file?path=${encodeURIComponent(rel)}`,
    name: String(rel).replace(/^screenshots\//, ''),
  }));
}
