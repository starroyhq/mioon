/** Headless-Chromium entry for the SP-M cross-runtime equality gate. The page
 * computes the same integer tables and stable hash as the Node test; no
 * application, project store or RPC participates. */
import {buildCrossRuntimePayload, crossRuntimeHash} from '../../helpers/timeline-time-map-vectors.ts';

interface FixtureApi {
  readonly ready: true;
  readonly run: () => {readonly payload: unknown; readonly hash: string};
}

const payload = buildCrossRuntimePayload();
const hash = crossRuntimeHash(payload);
(window as Window & {__timeMapFixture?: FixtureApi}).__timeMapFixture = {ready: true, run: () => ({payload, hash})};
document.body.setAttribute('data-fixture-ready', 'true');
