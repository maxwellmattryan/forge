// The render check's broken build (test/integration/scripts/render-check.test.ts): agents throws,
// evals logs an error, analytics renders nothing, and every other view renders a job whose click
// opens a drawer.
const view = location.hash.replace(/^#\//, '');
if (view === 'agents') throw new Error('render fixture: agents throws');
if (view === 'evals') console.error('render fixture: evals logs an error');
if (view !== 'analytics') {
  const job = document.createElement('button');
  job.textContent = 'Render fixture job';
  job.addEventListener('click', () => {
    const drawer = document.createElement('aside');
    drawer.id = 'drawer';
    drawer.textContent = 'Render fixture job';
    document.body.append(drawer);
  });
  document.body.append(job);
}
