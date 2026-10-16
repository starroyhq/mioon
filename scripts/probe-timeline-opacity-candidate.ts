/** Run only after the separately authorized candidate qualification review.
 * This command prints metadata, never raw media stdout or child stderr. */
import {runTimelineOpacityPixelProbeCandidate} from '../packages/business/src/timeline-opacity-pixel-probe-candidate.ts';

if (process.argv.length !== 2) throw new Error('The synthetic opacity probe accepts no arguments.');
const report = await runTimelineOpacityPixelProbeCandidate();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.complete) process.exitCode = 1;
