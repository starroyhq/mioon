import {createHash} from 'node:crypto';
import {closeSync, fsyncSync, openSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {publishRulesFile} from '../../packages/business/src/agent/mio-rules-file.ts';

const [projectDir, crashPhase, candidateName, backupName] = process.argv.slice(2);
if (!projectDir || !crashPhase || !candidateName || !backupName) throw new Error('Missing fixture arguments');
publishRulesFile(projectDir, {expectedExists: true,
  expectedHash: createHash('sha256').update(crashPhase === 'backup_restored' ? 'different' : 'before').digest('hex'), text: 'after\r\n', candidateName, backupName,
  checkpoint: evidence => {
    const file = path.join(path.dirname(projectDir), 'evidence.json');
    writeFileSync(file, JSON.stringify(evidence));
    const fd = openSync(file, 'r'); try {fsyncSync(fd);} finally {closeSync(fd);}
  },
  onPhase: phase => {if (phase === crashPhase) process.kill(process.pid, 'SIGKILL');},
  afterEffect: effect => {if (effect === crashPhase) process.kill(process.pid, 'SIGKILL');}});
