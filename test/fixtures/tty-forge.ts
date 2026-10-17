// The forge CLI as bin/forge runs it, with stdin claiming to be a terminal: a test can't allocate a
// pty, and `forge job interim publish --confirm` refuses without one.
Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
const { main, reportError } = await import('../../lib/cli.ts');
const argv = process.argv.slice(2);
main(argv).catch((err) => process.exit(reportError(err, argv)));
