# API / compatibility lens

**Focus:** the contract other code depends on.

Check:
- Public functions, types, endpoints, CLI flags, config keys, file formats, wire protocols: anything removed, renamed or changed in meaning?
- Breaking changes are intentional, called out in the PR, versioned (semver/changelog) and migrated.
- New public surface is minimal, consistently named, documented, and hard to misuse.
- Errors are typed/structured and documented; defaults are safe.
- Client/server or cross-language counterparts were updated together.
