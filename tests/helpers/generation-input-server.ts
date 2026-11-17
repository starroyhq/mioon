import assert from 'node:assert/strict';
import {createTestSecretCodec} from './secret-codec.ts';
import {startServer} from './test-server.ts';

const dataDir = process.env.MIOON_DATA_DIR;
const token = process.env.MIOON_TOKEN;
assert.ok(dataDir && token);
const server = await startServer({dataDir, token, port: 0, videoSecretCodec: createTestSecretCodec()});
process.once('SIGTERM', () => void server.close().catch(() => {process.exitCode = 1;}));
console.log(`Mioon ready at ${server.url}`);
