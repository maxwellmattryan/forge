# Security policy

Forge runs agents that read text from your tracker, edit code in worktrees and run your repo's commands. This page says how to report a security problem in Forge, what happens after you do, and where Forge draws its trust boundaries.

## Reporting a vulnerability

Report it privately through GitHub private vulnerability reporting: open [the private advisory form](https://github.com/maxwellmattryan/forge/security/advisories/new) (Security tab > Report a vulnerability). Do not use a public issue, pull request or discussion, even when you are unsure whether it is a vulnerability. A private report can be made public later; a public one can't be taken back.

Include:
- the output of `forge version`
- how Forge ran: as a Claude Code plugin, as the CLI from a clone, or under the daemon (`forge dash` with `daemon.enabled: true`)
- the steps to reproduce it, or a proof of concept
- the impact you expect: what an attacker controls, and what they gain

Vulnerabilities in Claude Code, `gh`, git or Node belong with those projects. Report them there, and report them here as well if Forge makes one easier to reach.

## What to expect

- **Acknowledgement** within 5 business days of your report.
- **Assessment** within 14 days: whether the maintainer can confirm the issue, and how severe it is.
- **Fix or mitigation** for a confirmed issue within 90 days of the report, and sooner for a critical one. Please keep the details private until it ships.

The fix ships as a patch release with a GitHub Security Advisory, and a CVE when one is warranted. The advisory credits you unless you decline.

## Supported versions

Only the latest minor release line (the newest `x.y`; see [CHANGELOG.md](CHANGELOG.md)) receives security fixes, as patch releases. Older lines get no backports, so upgrade with `forge update` to pick up a fix. [docs/RELEASES.md](docs/RELEASES.md) has the versioning, support and deprecation policy and how to verify a release.

| Release line | Security fixes |
|---|---|
| latest minor | yes |
| older minors | no |

## Threat model

Forge acts with your git, `gh` and Claude Code permissions, and it reads text written by people outside your session. Each boundary below is a summary; the linked section of the architecture doc has the full design.

- **Tracker and PR text is untrusted.** Issue bodies, comments and reviews reach agents only fenced and labelled as data, and Forge never adopts a PR from a fork. See [Untrusted input](docs/architecture/untrusted-input.md).
- **The dashboard is reachable from loopback only.** Every POST must carry the page's token, a matching Origin and a JSON body. See [Dashboard security](docs/architecture/dashboard-security.md).
- **The daemon runs unattended.** It uses the tools in `daemon.allowedTools` on its own, and any other tool call is refused or waits for a human, unless a human switched that session to Auto. A trust digest of the config stops its sessions when `.forge/config.yml` or a tracker module changes under them. See [Daemon security](docs/architecture/daemon-security.md).
- **Supply chain.** Forge has zero runtime dependencies and its devDependencies are exact-pinned. Installing the plugin runs nothing: no install scripts and no build. [Dependabot](.github/dependabot.yml) proposes toolchain updates as reviewed PRs.

Not vulnerabilities:
- anything that already needs write access to `.forge/config.yml` (including `commands.*`) or `.forge/trackers/`, which are code (see below)
- residual risks that docs/ARCHITECTURE.md already documents
- actions an agent takes with tools a human allowed it to use, unless untrusted tracker or PR text steered it there by crossing one of the boundaries above

## Configuration is code

`.forge/config.yml` is code, and so is every module under `.forge/trackers/`. Verify runs `commands.*` through a shell, `daemon.command` and `daemon.allowedTools` decide what an unattended session may run, and `forge` imports the tracker modules. Review a change to any of them as you would a change to a build script.

In this repository those paths need code-owner review by the maintainer, set in [.github/CODEOWNERS](.github/CODEOWNERS). A repo that uses Forge should list both paths in its own CODEOWNERS and require code-owner review on its default branch.
