# Dashboard security

The machine dashboard answers loopback Hosts only, signs a browser in with a one-time login link, and lets no request act without the login, a matching Origin and, for a POST, JSON. These parts hold the read guards, the page CSP and escape-first rendering, each route's own checks, plus the support bundle and `--dev`; read the part you need before adding or changing a route.

## Parts
- [Projects](dashboard-security/projects.md): one server for every registered project, the project routes and how a project segment resolves. Holds **One server, many projects**.
- [Login](dashboard-security/login.md): the login link, the cookie exchange, the check order, the login file, the browser opener, and who the login stops. Holds **Login**, **login link**, **Who the login stops**.
- [Request guards](dashboard-security/request-guards.md): the loopback bind and peer check, the read guard, the POST guard and its route list, body limits and constant-time comparison.
- [POST routes](dashboard-security/post-routes.md): the resume lease and shelved-job refusals, `POST /api/shelf`, focus and checkout steps, Run, the editor, the Environment card and its logs, repo proposals, endpoints and the chat routes. Holds **Chats**.
- [Reads and rendering](dashboard-security/reads-and-rendering.md): `GET /api/doctor`, the GitHub and tracker reads, settings, merge and budget writes, escape-first rendering (`md()`), transcripts, `/api/state`, the page CSP, mockups, job files, screenshots and served assets.
- [Support bundle and dev mode](dashboard-security/support-and-dev.md): `GET /api/doctor/bundle` and `forge dash --dev`.
- [Mandate routes](dashboard-security/mandate-routes.md): the milestone draft routes and the Office page's mandate routes.
