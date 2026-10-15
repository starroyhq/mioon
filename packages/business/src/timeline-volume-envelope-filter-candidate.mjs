/** Dormant candidate only: no package export or production consumer.
 * Requires an already bounded ordinary data clip, not an adversarial proxy.
 * This compiler establishes neither source eligibility nor installed DSP support.
 */
import {volumeEnvelopeFieldsAfterEdit} from '../../contracts/src/timeline-volume-envelope.mjs';

export const VOLUME_ENVELOPE_FILTER_BYTE_CAP = 4096;
const fail = message => { throw Object.assign(new Error(message), {code:'INVALID_VOLUME_ENVELOPE_FILTER'}); };
const sampleInteger = (value, min, max) => Number.isSafeInteger(value) && !Object.is(value,-0) && value>=min && value<=max;

/** Return one graph-level escaped aeval stage, or exactly '' for absent/null.
 * offsetSamples is the original clip-local position of this fresh filter's n=0.
 * sampleCount describes its half-open input range; both are integer 48k samples.
 * Caller must eventually enforce rate/layout, count and format fences separately.
 */
export function compileVolumeEnvelopeFilterCandidate(clip, offsetSamples, sampleCount) {
  // The existing pure helper validates and detaches the envelope, preserving
  // absence/null. No caller-owned strings, labels or fragments enter the output.
  const fields = volumeEnvelopeFieldsAfterEdit(clip, {});
  const durationSamples = clip.durationFrames * 1600;
  if (!sampleInteger(offsetSamples,0,durationSamples-1) ||
      !sampleInteger(sampleCount,1,durationSamples-offsetSamples)) fail('Invalid local sample range.');
  if (!Object.hasOwn(fields,'volumeEnvelope') || fields.volumeEnvelope===null) return '';
  const points = fields.volumeEnvelope.points;
  const x = `(n+${offsetSamples})`;
  let expression = String(points.at(-1).multiplier);
  for (let i=points.length-2;i>=0;i--) {
    const left=points[i], right=points[i+1];
    const a=left.frame*1600, b=right.frame*1600;
    // Strict < selects the next interval at an exact anchor. Its zero fraction
    // returns the exact left multiplier; the final anchor selects the hold.
    expression = `if(lt(${x},${b}),${left.multiplier}+(${right.multiplier}-${left.multiplier})*((${x}-${a})/${b-a}),${expression})`;
  }
  const first=points[0];
  expression = `if(lte(${x},${first.frame*1600}),${first.multiplier},${expression})`;
  // Escape expression commas for the filtergraph parser. The emitted grammar
  // contains no colon, semicolon, quote, bracket, backslash or caller text.
  const filter = `aeval=exprs=val(ch)*(${expression.replaceAll(',', '\\,')}):c=same`;
  if (Buffer.byteLength(filter,'utf8')>VOLUME_ENVELOPE_FILTER_BYTE_CAP) fail('Envelope expression exceeds its byte cap.');
  return filter;
}
