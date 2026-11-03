// Bound JSON extraction used by the current receipt read boundary.
export const TIMELINE_RECEIPT_PROJECT_EXPRESSION = `CASE WHEN typeof(response)='text' AND length(CAST(response AS BLOB)) BETWEEN 1 AND 4194304
 THEN CASE WHEN json_valid(response) THEN CASE WHEN json_type(response,'$.projectId')='text' AND length(CAST(json_extract(response,'$.projectId') AS BLOB))=36
 THEN json_extract(response,'$.projectId') END END END`;
