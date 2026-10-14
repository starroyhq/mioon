// Test-only pre-destination recorder. Explicit 3 s capacity; output stays silent.
// No worklet or capture allocation is shipped in the production audition graph.
class SoundAuditionCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const frames = options.processorOptions.frames;
    if (!Number.isSafeInteger(frames) || frames < 1 || frames > 144000) throw Error('Capture capacity exceeded');
    this.left = new Float32Array(frames); this.right = new Float32Array(frames);
    this.frames = 0; this.startFrame = null; this.overflow = false;
    this.port.onmessage = event => {
      if (event.data !== 'capture') return;
      this.port.postMessage({ frames: this.frames, startFrame: this.startFrame, overflow: this.overflow, left: this.left, right: this.right }, [this.left.buffer, this.right.buffer]);
      this.left = null; this.right = null;
    };
  }
  process(inputs, outputs) {
    if (!this.left) return false;
    if (this.startFrame === null) this.startFrame = currentFrame;
    const count = outputs[0][0].length;
    if (this.frames + count > this.left.length) { this.overflow = true; return true; }
    const input = inputs[0];
    for (let index = 0; index < count; index++) {
      this.left[this.frames + index] = input[0]?.[index] ?? 0;
      this.right[this.frames + index] = input[1]?.[index] ?? 0;
    }
    this.frames += count;
    return true; // Outputs remain zero: downstream physical output is muted.
  }
}
registerProcessor('sound-audition-capture', SoundAuditionCapture);
