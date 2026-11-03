/** Current S1 content overlay. The historical format-72 schema and its digest
 * remain frozen; only the current asset target-revision predicate changes. */
const value = (data: string, key: string): string => `json_extract(${data},'$.${key}')`;
const type = (data: string, key: string): string => `json_type(${data},'$.${key}')`;
const hex = (expression: string): string => `(typeof(${expression})='text' AND length(${expression})=64 AND length(CAST(${expression} AS BLOB))=64 AND ${expression} NOT GLOB '*[^0-9a-f]*')`;
const parts = (expression: string): string => `('['||replace(json_quote(replace(${expression},char(92),'/')),'/','","')||']')`;

function validReference(data: string): string {
  const path = value(data, 'reference.path'), pathForm = value(data, 'reference.pathForm'), volume = value(data, 'reference.volume');
  const absoluteRest = `(CASE WHEN substr(${path},1,2)=char(92)||char(92) THEN substr(${path},3)
    WHEN substr(${path},1,1) GLOB '[A-Za-z]' AND substr(${path},2,1)=':' AND substr(${path},3,1) IN ('/',char(92)) THEN substr(${path},4)
    WHEN substr(${path},1,1)='/' THEN substr(${path},2) END)`;
  const unc = `substr(${path},1,2)=char(92)||char(92)`;
  return `(${type(data, 'reference')}='object'
    AND (SELECT count(*) FROM json_each(${data},'$.reference'))=7
    AND ${type(data, 'reference.pathForm')}='text' AND ${type(data, 'reference.path')}='text'
    AND length(${path}) BETWEEN 1 AND 4096 AND instr(${path},char(0))=0
    AND (${pathForm}='relative' AND ${type(data, 'reference.volume')}='null'
      AND instr(${path},char(92))=0 AND substr(${path},1,1)<>'/'
      AND NOT(substr(${path},1,1) GLOB '[A-Za-z]' AND substr(${path},2,1)=':')
      AND NOT EXISTS(SELECT 1 FROM json_each(${parts(path)}) a WHERE a.value IN ('','.') OR
        (a.value='..' AND EXISTS(SELECT 1 FROM json_each(${parts(path)}) b WHERE b.key<a.key AND b.value<>'..')))
      OR ${pathForm}='absolute' AND (${type(data, 'reference.volume')}='null' OR ${type(data, 'reference.volume')}='text' AND length(${volume}) BETWEEN 1 AND 255)
      AND ${absoluteRest} IS NOT NULL AND (${absoluteRest}='' AND NOT(${unc}) OR ${absoluteRest}<>''
        AND NOT EXISTS(SELECT 1 FROM json_each(${parts(absoluteRest)}) a WHERE a.value IN ('','.','..'))
        AND (NOT(${unc}) OR (SELECT count(*) FROM json_each(${parts(absoluteRest)}))>=2 AND (SELECT value FROM json_each(${parts(absoluteRest)}) WHERE key=0)<>'?')))
    AND ${type(data, 'reference.sizeBytes')}='integer' AND ${value(data, 'reference.sizeBytes')} BETWEEN 0 AND 9007199254740991
    AND ${type(data, 'reference.mtimeMs')} IN ('integer','real') AND ${value(data, 'reference.mtimeMs')} BETWEEN 0 AND 1.7976931348623157e308
    AND ${hex(value(data, 'reference.sampledSha256'))}
    AND (${type(data, 'reference.fullSha256')}='null' OR ${hex(value(data, 'reference.fullSha256'))}))`;
}

const derivedHashOnly = `(coalesce(CASE WHEN json_valid(OLD.data) AND json_valid(NEW.data) THEN
  NEW.id IS OLD.id AND NEW.projectId IS OLD.projectId
  AND json_type(OLD.data)='object' AND json_type(NEW.data)='object'
  AND ${validReference('OLD.data')} AND ${validReference('NEW.data')}
  AND ${value('OLD.data', 'id')} IS OLD.id AND ${value('NEW.data', 'id')} IS NEW.id
  AND ${value('OLD.data', 'projectId')} IS OLD.projectId AND ${value('NEW.data', 'projectId')} IS NEW.projectId
  AND ${type('OLD.data', 'referenceRevision')}='integer' AND ${value('OLD.data', 'referenceRevision')} BETWEEN 1 AND 9007199254740991
  AND ${type('NEW.data', 'referenceRevision')}='integer' AND ${value('NEW.data', 'referenceRevision')} IS ${value('OLD.data', 'referenceRevision')}
  AND ${type('OLD.data', 'sizeBytes')}='integer' AND ${value('OLD.data', 'sizeBytes')} IS ${value('OLD.data', 'reference.sizeBytes')}
  AND ${type('NEW.data', 'sizeBytes')}='integer' AND ${value('NEW.data', 'sizeBytes')} IS ${value('NEW.data', 'reference.sizeBytes')}
  AND ${type('OLD.data', 'relativePath')} IS NULL AND ${type('NEW.data', 'relativePath')} IS NULL
  AND (SELECT count(*) FROM json_each(OLD.data) WHERE key IN ('id','projectId','sha256','reference','referenceRevision','sizeBytes'))=6
  AND (SELECT count(*) FROM json_each(NEW.data) WHERE key IN ('id','projectId','sha256','reference','referenceRevision','sizeBytes'))=6
  AND (${type('OLD.data', 'sha256')}='null' OR ${value('OLD.data', 'sha256')} IS ${value('NEW.data', 'sha256')})
  AND ${value('OLD.data', 'reference.fullSha256')} IS ${value('OLD.data', 'sha256')}
  AND ${hex(value('NEW.data', 'sha256'))} AND ${value('NEW.data', 'reference.fullSha256')} IS ${value('NEW.data', 'sha256')}
  AND json_remove(OLD.data,'$.sha256','$.reference.fullSha256','$.reference.mtimeMs') IS json_remove(NEW.data,'$.sha256','$.reference.fullSha256','$.reference.mtimeMs')
  ELSE 0 END,0))`;

export function currentContentStatements(historical: readonly string[]): readonly string[] {
  let count = 0;
  const result = historical.map(statement => {
    if (!statement.startsWith('CREATE TRIGGER agent_target_assets_update_v2 ')) return statement;
    count++;
    const when = '(NEW."id" IS NOT OLD."id" OR NEW."projectId" IS NOT OLD."projectId" OR NEW."data" IS NOT OLD."data")';
    if (!statement.includes(`WHEN ${when} BEGIN`)) throw new Error('The S1 content overlay requires the exact historical asset update trigger');
    return statement.replace(`WHEN ${when} BEGIN`, `WHEN ${when} AND NOT ${derivedHashOnly} BEGIN`);
  });
  if (count !== 1) throw new Error('The S1 content overlay requires exactly one asset update trigger');
  return result;
}
