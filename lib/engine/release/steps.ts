// The mechanism table that turns one repo's strategy into release steps and their rollback lines.
// It imports only types from plan.ts, so plan.ts can import it without a cycle.

import type { RepoKey } from '../project/repo-order.ts';
import type { ReleaseMechanism, ReleaseStrategy } from '#core/types.ts';
import type { ReleasePackage, ReleaseStep } from './plan.ts';

const ROOT_LABEL = '(root)';
export const labelOf = (repo: RepoKey): string => repo ?? ROOT_LABEL;

/** What stepsFor needs to know about one repo. */
export interface RepoInput {
  repo: RepoKey;
  dir: string;
  base: string;
  remote: string;
  strategy: ReleaseStrategy & { mechanism: ReleaseMechanism };
  manifest: { name: string; version: string } | { reason: string } | null;
}

/** The mechanism table (spec "Steps per mechanism"), as data. */
export function stepsFor(r: RepoInput): ReleaseStep[] {
  const label = labelOf(r.repo);
  const { mechanism } = r.strategy;
  const registry = r.strategy.registry ?? null;
  const steps: ReleaseStep[] = [];
  const add = (kind: string, title: string, rest: Partial<ReleaseStep>): void => {
    steps.push({ id: `${label}/${kind}`, repo: r.repo, kind, title, argv: null, shell: null, manual: null, publish: false, check: null, ...rest });
  };
  const noCheck = r.manifest && 'reason' in r.manifest ? `no registry check: ${r.manifest.reason}; check by hand` : null;
  const registryCheck = (): Partial<ReleaseStep> => (noCheck ? { check: null, note: noCheck } : { check: 'registry' });
  add('preflight', `Check that the clone is on ${r.base}, clean, and level with ${r.remote}/${r.base}`, { check: 'ready' });
  const registryPublish = () => {
    if (registry === 'npm') add('publish', 'Publish the package to npm', { argv: ['npm', 'publish'], publish: true, ...registryCheck() });
    else if (registry === 'crates.io') add('publish', 'Publish the crate to crates.io', { argv: ['cargo', 'publish'], publish: true, ...registryCheck() });
  };
  if (mechanism === 'tag') {
    add('release', 'Run release.command, which tags and pushes the release', { shell: String(r.strategy.command ?? ''), publish: true, check: 'tag-pushed' });
    registryPublish();
  } else if (mechanism === 'cargo-release') {
    add('publish', 'Publish the crates with cargo-release', { argv: ['cargo', 'release', 'publish', '--execute', '--no-confirm'], publish: true, ...(registry === 'none' ? {} : registryCheck()) });
    add('tag', 'Tag the release', { argv: ['cargo', 'release', 'tag', '--execute', '--no-confirm'], check: 'tagged' });
    add('push', 'Push the release commit and tags', { argv: ['cargo', 'release', 'push', '--execute', '--no-confirm'], publish: true, check: 'tag-pushed' });
  } else if (mechanism === 'changesets') {
    add('version', 'Apply the changesets: bump versions and changelogs', { argv: ['changeset', 'version'] });
    add('stage', 'Stage the version changes', { argv: ['git', 'add', '--all'] });
    add('commit', 'Commit the version bump', { argv: ['git', 'commit', '--message', 'Version packages'], check: 'clean' });
    add('publish', 'Publish the packages and tag them', { argv: ['changeset', 'publish'], publish: true, check: 'tagged' });
    add('push', `Push the release commit and tags to ${r.remote}/${r.base}`, { argv: ['git', 'push', '--follow-tags', r.remote, `HEAD:refs/heads/${r.base}`], publish: true, check: 'tag-pushed' });
  } else {
    add('merge', "Merge the release PR", { manual: `Merge ${label}'s open release-please PR on GitHub; its workflow tags the release.`, publish: true, check: 'remote-tagged' });
    add('sync', `Fast-forward ${r.base} to ${r.remote}/${r.base}`, { argv: ['git', 'merge', '--ff-only', `${r.remote}/${r.base}`], check: 'at-remote' });
    registryPublish();
  }
  return steps;
}

export function rollbackFor(r: RepoInput, steps: ReleaseStep[], pkg: ReleasePackage | null): string[] {
  const name = pkg?.name ?? '<name>';
  const tag = `\`git push ${r.remote} --delete refs/tags/<tag>\`, then \`git tag --delete <tag>\`, and delete its GitHub Release if one was made: \`gh release delete <tag>\``;
  const lines = (s: ReleaseStep): string[] => {
    const m = r.strategy.mechanism;
    if (m === 'tag' && s.kind === 'release') return [`Delete the pushed tag: ${tag}`];
    if (m === 'cargo-release' && s.kind === 'push') return [`Delete the pushed tag: ${tag}`];
    if (m === 'changesets' && s.kind === 'push')
      return [`Delete the pushed tag: ${tag}`, `Revert the version commit once pushed: \`git revert --no-edit <release commit>\`, then \`git push ${r.remote} HEAD:refs/heads/${r.base}\``];
    if (m === 'release-please' && s.kind === 'merge') return [`Delete the tag the workflow pushed: ${tag}`, `revert the release PR's merge commit on ${r.base} in a new PR`];
    if (s.kind !== 'publish') return [];
    const npm = m === 'changesets' || (s.argv?.[0] === 'npm');
    if (npm) return [`\`npm deprecate ${name}@<version> "<reason>"\`; \`npm unpublish ${name}@<version>\` only works within 72 hours of publishing and when no other public package depends on it`];
    return [`\`cargo yank --version <version> ${name}\`; crates.io never deletes a version; a yank stops new lockfiles from picking it`];
  };
  return [...steps].reverse().flatMap(lines);
}
