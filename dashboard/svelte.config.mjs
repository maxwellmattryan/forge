// Shared by Vite and svelte-check: runes mode everywhere, so legacy `export let` and `$:` fail the build.
export default { compilerOptions: { runes: true } };
