import {TIMELINE_RECEIPT_WRAPPER_OPERATIONS} from './timeline-retained-receipts.ts';

const wrapperOperations=TIMELINE_RECEIPT_WRAPPER_OPERATIONS.map(operation=>`'${operation}'`).join(',');
const ownerAt=(path: string)=>`CASE WHEN json_type(response,'${path}')='text' AND length(CAST(json_extract(response,'${path}') AS BLOB))=36
 THEN json_extract(response,'${path}') END`;

// Bound JSON extraction used by format admission and version restore. Legacy
// wrappers have no top-level owner. Scope their nested owner only after binding
// the operation discriminator and embedded request key to the stored row.
export const TIMELINE_RECEIPT_PROJECT_EXPRESSION = `CASE WHEN typeof(response)='text' AND length(CAST(response AS BLOB)) BETWEEN 1 AND 4194304
 THEN CASE WHEN json_valid(response) THEN CASE
  WHEN json_type(response,'$.operation') IS NULL AND json_type(response,'$.timeline') IS NULL
   THEN ${ownerAt('$.projectId')}
  WHEN json_extract(response,'$.operation') IN (${wrapperOperations})
   AND json_type(response,'$.projectId') IS NULL AND json_type(response,'$.mode') IS NULL AND json_type(response,'$.snapshot') IS NULL
   AND json_type(response,'$.timeline')='object' AND json_type(response,'$.requestId')='text' AND json_extract(response,'$.requestId')=requestId
   AND NOT EXISTS (SELECT 1 FROM json_each(response) WHERE key IN ('operation','requestId','timeline') GROUP BY key HAVING count(*)>1)
   AND (SELECT count(*) FROM json_each(response,'$.timeline') WHERE key='projectId')=1
   THEN ${ownerAt('$.timeline.projectId')}
 END END END`;
