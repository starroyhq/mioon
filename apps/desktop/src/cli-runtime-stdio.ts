import {Readable} from 'node:stream';

function runtimeStdin(): Readable {
  const port = process.parentPort;
  if (!port) throw Error('The command must run in a desktop utility process.');
  let pendingAck = false;
  const acknowledge = () => port.postMessage({type: 'stdin-ack'});
  const stdin = new Readable({
    read() {
      if (!pendingAck) return;
      pendingAck = false;
      acknowledge();
    },
  });
  // The CLI's JSON input and private key input both use the normal stdin.
  Object.defineProperty(process, 'stdin', {value: stdin, configurable: true});
  const receive = ({data}: {data: unknown}): void => {
    if (!data || typeof data !== 'object' || !('type' in data)) return;
    if (data.type === 'stdin-eof') {
      port.off('message', receive);
      stdin.push(null);
    } else if (data.type === 'stdin' && 'data' in data && data.data instanceof Uint8Array && !pendingAck) {
      const bytes = data.data;
      // The host sends one frame at a time. Once the stream fills, leave that
      // frame unacknowledged until the consumer requests more bytes.
      pendingAck = !stdin.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      if (!pendingAck) acknowledge();
    }
  };
  port.on('message', receive);
  port.postMessage({type: 'ready'});
  return stdin;
}

/** The Electron parent port survives EOF and keeps the utility alive. Wait
 * for both output streams' queued writes before explicitly exiting. */
export function runInCliUtility(command: (stdin: Readable) => Promise<void>, startupFailure: string): void {
  void (async () => {
    try {
      await command(runtimeStdin());
    } catch {
      process.exitCode = 1;
      process.stderr.write(startupFailure + '\n');
    } finally {
      await Promise.allSettled([process.stdout, process.stderr].map(stream =>
        new Promise<void>(resolve => {stream.write('', () => resolve());})));
      process.exit();
    }
  })();
}
