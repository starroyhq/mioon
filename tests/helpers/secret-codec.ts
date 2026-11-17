import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto';
import {createAgentSettings} from '../../packages/business/src/agent/settings.ts';
import type {ServerOptions} from '../../apps/server/src/index.ts';

// Deliberately synthetic key. It lives in the test harness only, so fixtures
// can reopen their own ciphertext without consulting the host keychain.
const key = createHash('sha256').update('mioon synthetic settings fixture').digest();
export const testSecretStorage = () => ({persistentAvailable: true, reasonCode: null});

export function createTestSecretCodec() {
  return {
    storage: testSecretStorage,
    refreshStorage: async () => testSecretStorage(),
    async encrypt(plaintext: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
    },
    async decrypt(ciphertext: string) {
      const data = Buffer.from(ciphertext, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

export function createTestAgentSettings(options: Parameters<typeof createAgentSettings>[0]) {
  const secretCodec = createTestSecretCodec();
  return createAgentSettings({secretCodec, storage: testSecretStorage, ...options});
}

export function testServerSecretCodecs(): Pick<ServerOptions, 'agentSecretCodecFactory' | 'imageSecretCodec' | 'videoSecretCodec'> {
  return {
    agentSecretCodecFactory: async () => ({secretCodec: createTestSecretCodec(), storage: testSecretStorage, close() {}}),
    imageSecretCodec: createTestSecretCodec(),
    videoSecretCodec: createTestSecretCodec(),
  };
}
