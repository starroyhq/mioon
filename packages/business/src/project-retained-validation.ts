import type {ProjectStore} from './project-file/store.ts';
import {assertProjectStore} from './store-runtime.ts';
import {validateTimelineOpacityRows} from './timeline-retained-opacity.ts';
/** Exact kernel admission for retained timeline/intent/receipt/source evidence.
 * Component scanners remain independently fuzzable; this entry never accepts
 * a copied object, closed connection or a marker-only database as authority. */
export function validateProjectRetainedRows(store:ProjectStore):void {
 assertProjectStore(store);validateTimelineOpacityRows(store.db);
}
