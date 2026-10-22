// A dev server for test/integration/server/environment.test.ts: on its first run in a directory it prints `boom` and
// exits 1 (a crash), and on every later run it serves on the port in argv[2] until killed.
import fs from 'node:fs';
import http from 'node:http';

const marker = '.dev-crashed-once';
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, '');
  console.log('starting');
  console.log('boom');
  process.exit(1);
}
http.createServer((_req, res) => res.end('ok')).listen(Number(process.argv[2]), '127.0.0.1', () => console.log('serving'));
