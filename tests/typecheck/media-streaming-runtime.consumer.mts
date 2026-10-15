import {createStreamingMediaRuntime} from '../../packages/business/src/media-streaming-runtime.ts';
import type {StreamingMediaDependencies, StreamingMediaOptions, StreamingMediaResult, StreamingMediaRunner} from '../../packages/business/src/media-streaming-runtime.ts';

type IsAny<T> = 0 extends (1 & T) ? true : false;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type CheckedFactory = Expect<Equal<IsAny<ReturnType<typeof createStreamingMediaRuntime>>, false>>;
type CheckedChunk = Expect<Equal<Parameters<StreamingMediaOptions['onStdout']>[0], Buffer>>;
type CheckedFailure = Expect<Equal<Parameters<NonNullable<StreamingMediaOptions['onFailure']>>[0], unknown>>;
type CheckedResult = Expect<Equal<Awaited<ReturnType<StreamingMediaRunner>>, StreamingMediaResult>>;
type CheckedChild = Expect<Equal<IsAny<ReturnType<StreamingMediaDependencies['spawnMedia']>>, false>>;

declare const dependencies: StreamingMediaDependencies;
const run = createStreamingMediaRuntime(dependencies);
const result: Promise<StreamingMediaResult> = run('ffmpeg', ['-version'], {
  async onStdout(chunk) {const bytes: number = chunk.byteLength; void bytes;},
  onFailure(error) {
    // @ts-expect-error Failure observers must narrow an unknown thrown value.
    error.code;
  },
});
// @ts-expect-error Awaited output requires an explicit consumer.
run('ffmpeg', []);
// @ts-expect-error Argv entries remain strings.
run('ffmpeg', [123], {onStdout() {}});
// @ts-expect-error A text-only callback cannot consume binary stdout.
run('ffmpeg', [], {onStdout(chunk: string) {void chunk;}});
// @ts-expect-error Consumers complete without returning an arbitrary result.
run('ffmpeg', [], {onStdout() {return 123;}});
// @ts-expect-error The result reports counted bytes, not retained PCM.
const retained: Promise<{stdout: Buffer}> = result;
// @ts-expect-error The configured byte limits are read-only dependencies.
dependencies.limits.stderrBytes = 1;
// @ts-expect-error Process ownership cannot be replaced with a PID-only object.
const processOwner: ReturnType<StreamingMediaDependencies['spawnMedia']> = {pid: 123};
void [result, retained, processOwner];
