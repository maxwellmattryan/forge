# Security lens

**Focus:** can this change be abused, leak data, or widen access?

Check:
- Untrusted input reaching queries, shells, file paths, templates, deserializers, regexes (ReDoS), URLs (SSRF).
- AuthN/AuthZ: new endpoints or actions have the same checks as their neighbours; no IDOR.
- Secrets: nothing committed, logged, or sent to the client; env vars documented, not hard-coded.
- Output encoding / XSS in any rendered HTML; CSRF on state-changing routes.
- New dependencies: necessary, maintained, pinned, no install scripts you didn't expect.
- File, process and network access is the minimum needed; temp files are safe.
- Error messages don't leak internals.

Severity guide: exploitable → blocker; defence-in-depth gap → major.
Always flag for human escalation (say so in Summary): auth, crypto, payment, PII handling.
