# Infrastructure lens

**Focus:** changes to deploy, CI/CD, cloud resources, containers or runtime config.

Check:
- Changes are declarative (IaC) and reviewed, not ad-hoc console steps hidden in code.
- Plans are reversible: rollback path stated; destructive changes (drops, deletes, replacements) called out.
- Least privilege for new roles/keys; secrets come from the secret store, never the repo.
- Environment parity: dev/staging/prod differences are explicit.
- CI changes don't skip tests, widen token permissions, or run untrusted code with secrets.
- If humans must perform steps, `runbook.md` exists and is complete (commands, order, verification, rollback).

Any infrastructure change escalates to a human; say so in Summary.
