import { writeFileSync } from 'node:fs';

const [mode, ...args] = process.argv.slice(2);
switch (mode) {
  case 'argv': process.stdout.write(JSON.stringify(args)); break;
  case 'keys': process.stdout.write(JSON.stringify(Object.fromEntries(args.map(key => [key, Object.hasOwn(process.env, key)])))); break;
  case 'stdout': process.stdout.write(args[0]); break;
  case 'flood': {
    const stream = args[0] === 'stderr' ? process.stderr : process.stdout;
    stream.write(Buffer.alloc(Number(args[1]), 120));
    setInterval(() => {}, 1000);
    break;
  }
  case 'fail': process.stderr.write('synthetic-private-asset-and-secret'); process.exitCode = 9; break;
  case 'wait':
    if (args[1] === 'ignore-term') process.on('SIGTERM', () => {});
    if (args[0]) writeFileSync(args[0], 'ready');
    setInterval(() => {}, 1000);
    break;
  default: throw Error('Unknown synthetic media fixture mode');
}
