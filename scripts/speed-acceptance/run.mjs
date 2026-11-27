
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {scenarios as transports} from './transports.mjs';
import {scenarios as media} from './media.mjs';
import {scenarios as faults} from './faults.mjs';

const entry = fileURLToPath(import.meta.url);
const maxOutputBytes = 16 * 1024 ** 2;
const runLimit = 12 * 60_000;
const cases = [...transports, ...media, ...faults];
const byId = new Map(cases.map(item => [item.id, item]));
if (byId.size !== cases.length) throw new Error('Duplicate acceptance scenario ID');
const help = [
  'Usage: node scripts/speed-acceptance/run.mjs --repo <integration checkout> [--case <id>] [--allow-blocked]',
  '       node scripts/speed-acceptance/run.mjs --list',
  'Use --case more than once to select several scenarios, or --keep-work to retain private temporary evidence.',
].join('\n');

class Blocked extends Error {}
class CommandError extends Error {
  constructor(message, stdout, stderr) {
    super(message);
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

function execute(args, {cwd, env, timeoutMs, ownGroup = false}) {
  return new Promise((resolve, reject) => {
    const group = ownGroup && process.platform !== 'win32';
    const child = spawn(process.execPath, args, {cwd, env, detached: group, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    const output = {stdout: '', stderr: ''};
    let bytes = 0;
    let stopReason = null;
    const stop = reason => {
      if (stopReason) return;
      stopReason = reason;
      if (!child.pid) return;
      try {
        if (group) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') reject(error);
      }
    };
    const timer = setTimeout(() => stop('Process timed out after ' + timeoutMs + ' ms'), timeoutMs);
    const interrupt = () => stop('Interrupted');
    if (ownGroup) {
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', interrupt);
    }
    function finish() {
      clearTimeout(timer);
      if (ownGroup) {
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
      }
    }
    for (const name of ['stdout', 'stderr']) {
      child[name].setEncoding('utf8');
      child[name].on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxOutputBytes) stop('Process exceeded captured output limit');
        else output[name] += chunk;
      });
    }
    child.once('error', error => {finish(); reject(error);});
    child.once('close', (status, signal) => {
      finish();
      if (status === 0 && !stopReason) resolve(output);
      else reject(new CommandError(stopReason ?? 'Process exited with ' + (signal ?? status), output.stdout, output.stderr));
    });
  });
}

const passedEnv = [
  'PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'TZ',
  'MIOON_FFMPEG_PATH', 'MIOON_FFPROBE_PATH', 'MIOON_RUBBERBAND_PATH',
];

function isolatedEnv(scratch) {
  const env = Object.fromEntries(passedEnv.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const home = path.join(scratch, 'home');
  const tmp = path.join(scratch, 'tmp');
  return {...env, HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_DATA_HOME: path.join(home, 'data'), XDG_STATE_HOME: path.join(home, 'state'),
    MIOON_CHANNEL: 'development', MIOON_FORMAT6_DEV: '1'};
}

function fromRoot(repo, relative) {
  const full = path.resolve(repo, relative);
  const child = path.relative(repo, full);
  if (!child || child === '..' || child.startsWith('..' + path.sep) || path.isAbsolute(child)) {
    throw new Error('Expected a path inside the source checkout');
  }
  return full;
}

function privacy(repo, scratch) {
  const realHome = process.env.HOME ?? process.env.USERPROFILE;
  const labels = [[scratch, '<scratch>'], [repo, '<source>'], [realHome, '<home>']].filter(([value]) => value)
    .flatMap(([value, label]) => [[value, label], [value.replaceAll('\\', '\\\\'), label],
      [encodeURI(value), label]]);
  return raw => labels.reduce((value, [name, label]) => value.replaceAll(name, label), String(raw));
}

async function worker(repo, scratch, id) {
  const runNode = (args, config = {}) => execute(args, {
    cwd: repo, env: {...process.env, ...config.env}, timeoutMs: config.timeoutMs ?? 120_000,
  });
  const ctx = {
    repo, scratch, runNode,
    load: relative => import(pathToFileURL(fromRoot(repo, relative)).href),
    blocked(reason) {throw new Blocked(reason);},
    async runTest(relative, config = {}) {
      const {stdout} = await runNode(['--test', '--test-reporter=tap', '--test-timeout=600000',
        ...(config.name ? ['--test-name-pattern=' + config.name] : []), fromRoot(repo, relative)], config);
      const count = Number(/^# pass (\d+)$/m.exec(stdout)?.[1] ?? '0');
      if (count < 1) throw new Error('No executable test matched in ' + relative);
      return {file: relative, passed: count};
    },
  };
  let result;
  try {
    const evidence = await byId.get(id).run(ctx);
    result = {id, status: 'passed', evidence};
  } catch (error) {
    result = error instanceof Blocked ? {id, status: 'blocked', reason: error.message}
      : {id, status: 'failed', reason: error.message ?? String(error),
        ...(error.code && {code: error.code}),
        ...(error instanceof CommandError && {diagnostic: (error.stdout + '\n' + error.stderr).trim().slice(-6000)})};
  }
  await writeFile(path.join(scratch, 'result.json'), JSON.stringify(result) + '\n', {flag: 'wx', mode: 0o600});
}

async function run() {
  if (process.argv[2] === '--worker') {
    const [repo, scratch, id] = process.argv.slice(3);
    if (!repo || !scratch || !byId.has(id) || process.env.MIOON_SPQ_WORKER_SCRATCH !== scratch) {
      throw new Error('Invalid worker invocation');
    }
    return worker(repo, scratch, id);
  }
  const {values} = parseArgs({options: {
    repo: {type: 'string'}, case: {type: 'string', multiple: true},
    list: {type: 'boolean'}, help: {type: 'boolean'}, 'allow-blocked': {type: 'boolean'},
    'keep-work': {type: 'boolean'},
  }});
  if (values.help) {console.log(help); return;}
  if (values.list) {for (const {id} of cases) console.log(id); return;}
  if (!values.repo) throw new Error(help);
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or later is required');
  const repo = await realpath(values.repo);
  const pkg = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8'));
  if (pkg.name !== 'mioon') throw new Error('Expected a Mioon source checkout in --repo');
  const requested = values.case ? [...new Set(values.case)] : [...byId.keys()];
  for (const id of requested) if (!byId.has(id)) throw new Error('Unknown scenario ' + id);
  const scratch = await mkdtemp(path.join(await realpath(process.platform === 'darwin' ? '/private/tmp' : tmpdir()), 'mioon-sp-q-'));
  const redact = privacy(repo, scratch);
  const results = [];
  try {
    for (const id of requested) {
      const directory = await mkdtemp(path.join(scratch, 'case-'));
      const env = {...isolatedEnv(directory), MIOON_SPQ_WORKER_SCRATCH: directory};
      await mkdir(env.HOME, {mode: 0o700});
      await mkdir(env.TMPDIR, {mode: 0o700});
      const file = path.join(directory, 'result.json');
      try {
        await execute([entry, '--worker', repo, directory, id], {cwd: repo, env, timeoutMs: runLimit, ownGroup: true});
        results.push(JSON.parse(await readFile(file, 'utf8')));
      } catch (error) {
        if (error instanceof CommandError && error.message === 'Interrupted') {process.exitCode = 130; return;}
        results.push({id, status: 'failed', reason: error.message,
          ...(error instanceof CommandError && {diagnostic: (error.stdout + '\n' + error.stderr).trim().slice(-6000)})});
      }
    }
    const counts = {passed: 0, blocked: 0, failed: 0};
    for (const result of results) counts[result.status]++;
    console.log(redact(JSON.stringify({counts, results, ...(values['keep-work'] && {workDirectory: path.basename(scratch)})}, null, 2)));
    if (counts.failed) process.exitCode = 1;
    else if (counts.blocked && !values['allow-blocked']) process.exitCode = 2;
  } finally {
    if (!values['keep-work']) await rm(scratch, {recursive: true, force: true});
  }
}

run().catch(error => {
  // Errors before isolation can include an arbitrary user-supplied path.
  const safe = error.code === 'ENOENT' ? 'The source checkout or a required file was not found' : error.message;
  console.error(privacy(process.cwd(), '\u0000')(safe));
  process.exitCode = 2;
});
