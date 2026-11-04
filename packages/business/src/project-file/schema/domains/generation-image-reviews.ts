// Native, additive v6 branch. The existing v1–v5 branches remain unchanged.
// These are closed SQL declarations, evaluated without application callbacks.
const field = (path: string): string => `json_extract(canonicalIntent,'$.${path}')`;
const kind = (path: string): string => `json_type(canonicalIntent,'$.${path}')`;
const closed = (value: string, keys: readonly string[]): string => `json_remove(${value},${keys.map(key => `'$.${key}'`).join(',')}) IS '{}'`;
const uuid = (value: string): string => `length(CAST(${value} AS BLOB)) IS 36
          AND substr(${value},9,1) IS '-' AND substr(${value},14,1) IS '-'
          AND substr(${value},19,1) IS '-' AND substr(${value},24,1) IS '-'
          AND length(replace(${value},'-','')) IS 32 AND replace(${value},'-','') NOT GLOB '*[^a-f0-9]*'`;
const base = field('configuration.baseUrl'), remainder = `substr(${base},9)`;
const host = `(CASE WHEN instr(${remainder},'/')=0 THEN ${remainder} ELSE substr(${remainder},1,instr(${remainder},'/')-1) END)`;
const path = `(CASE WHEN instr(${remainder},'/')=0 THEN '' ELSE substr(${remainder},instr(${remainder},'/')) END)`;
const tld = `substr(${host},length(rtrim(${host},replace(${host},'.','')))+1)`;
const overlongLabel = `*${'[a-z0-9-]'.repeat(64)}*`;

export const GENERATION_IMAGE_REVIEW_V6_SQL = `        (${kind('schemaVersion')} IS 'integer' AND ${field('schemaVersion')} IS 6
          AND ${closed('canonicalIntent', ['schemaVersion','reviewId','input','settingsRevision','destination','policy','connectionId','configurationRevision','configuration'])}
          AND ${kind('reviewId')} IS 'text' AND ${uuid(field('reviewId'))}
          AND ${kind('connectionId')} IS 'text' AND ${uuid(field('connectionId'))}
          AND ${kind('configurationRevision')} IS 'integer'
          AND ${field('configurationRevision')} BETWEEN 1 AND 9007199254740991
          AND ${field('configurationRevision')} IS ${field('settingsRevision')}
          AND json_extract(canonicalInput,'$.providerId') IS 'openai-compatible'
          AND ${closed('canonicalInput', ['projectId','requestId','name','providerId','model','prompt','options','groupId','expectedRevision'])}
          AND json_type(canonicalInput,'$.name') IS 'text'
          AND length(CAST(json_extract(canonicalInput,'$.name') AS BLOB)) BETWEEN 1 AND 480
          AND length(json_extract(canonicalInput,'$.name')) <= 120
          AND (length(trim(json_extract(canonicalInput,'$.name'))) > 0 OR instr(json_extract(canonicalInput,'$.name'),char(0)) > 0)
          AND json_type(canonicalInput,'$.prompt') IS 'text'
          AND length(json_extract(canonicalInput,'$.prompt')) BETWEEN 1 AND 2000
          AND length(CAST(json_extract(canonicalInput,'$.prompt') AS BLOB)) BETWEEN 1 AND 8000
          AND length(trim(json_extract(canonicalInput,'$.prompt'),char(9,10,13,32))) > 0
          AND instr(json_extract(canonicalInput,'$.prompt'),char(0)) IS 0
          AND json_extract(canonicalInput,'$.prompt') NOT GLOB '*['||char(1)||'-'||char(8)||char(11,12,14)||'-'||char(31,127)||']*'
          AND ((json_type(canonicalInput,'$.groupId') IS NULL AND json_type(canonicalInput,'$.expectedRevision') IS NULL)
            OR (json_type(canonicalInput,'$.groupId') IS 'text'
              AND length(CAST(json_extract(canonicalInput,'$.groupId') AS BLOB)) IS 36
              AND json_type(canonicalInput,'$.expectedRevision') IS 'integer'
              AND json_extract(canonicalInput,'$.expectedRevision') BETWEEN 1 AND 9007199254740991))
          AND ${kind('configuration')} IS 'object'
          AND ${closed(field('configuration'), ['enabled','providerId','profileId','baseUrl','model','options'])}
          AND ${kind('configuration.enabled')} IS 'true'
          AND ${field('configuration.providerId')} IS 'openai-compatible'
          AND ${field('configuration.profileId')} IS 'openai-images-json-png-v1'
          AND ${kind('configuration.baseUrl')} IS 'text'
          AND length(${base}) BETWEEN 1 AND 2029 AND instr(${base},char(0)) IS 0
          AND ${base} NOT GLOB '*[^!-~]*' AND substr(${base},1,8) IS 'https://'
          AND length(${host}) BETWEEN 3 AND 253 AND ${host} IS lower(${host})
          AND ${host} NOT GLOB '*[^a-z0-9.-]*' AND instr(${host},'.') > 1
          AND substr(${host},1,1) GLOB '[a-z0-9]' AND substr(${host},-1,1) GLOB '[a-z0-9]'
          AND ${host} NOT GLOB '*..*' AND ${host} NOT GLOB '*.-*' AND ${host} NOT GLOB '*-.*'
          AND ${host} NOT GLOB '${overlongLabel}' AND ${tld} GLOB '*[a-z]*'
          AND (${path} IS '' OR (substr(${path},1,1) IS '/' AND substr(${path},-1,1) IS NOT '/'
            AND ${path} NOT GLOB '*[^A-Za-z0-9._~/-]*' AND ${path} NOT GLOB '*//*'
            AND ${path} NOT GLOB '*/./*' AND ${path} NOT GLOB '*/../*'
            AND substr(${path},-2) IS NOT '/.' AND substr(${path},-3) IS NOT '/..'))
          AND json_type(canonicalInput,'$.model') IS 'text'
          AND length(CAST(json_extract(canonicalInput,'$.model') AS BLOB)) BETWEEN 1 AND 120
          AND instr(json_extract(canonicalInput,'$.model'),char(0)) IS 0
          AND json_extract(canonicalInput,'$.model') NOT GLOB '*[^!-~]*'
          AND ${field('configuration.model')} IS json_extract(canonicalInput,'$.model')
          AND ${kind('configuration.options')} IS 'object'
          AND ${closed(field('configuration.options'), ['size','quality','outputFormat','background','n'])}
          AND ${field('configuration.options')} IS json_extract(canonicalInput,'$.options')
          AND ${field('configuration.options.size')} IS '1024x1024'
          AND ${field('configuration.options.quality')} IS 'low'
          AND ${field('configuration.options.outputFormat')} IS 'png'
          AND ${field('configuration.options.background')} IS 'opaque'
          AND ${kind('configuration.options.n')} IS 'integer' AND ${field('configuration.options.n')} IS 1
          AND ${field('destination')} IS ${base}||'/images/generations'
          AND ${kind('policy')} IS 'object'
          AND ${closed(field('policy'), ['maxPostAttempts','automaticRetry','price','promptStorage'])}
          AND ${kind('policy.maxPostAttempts')} IS 'integer' AND ${field('policy.maxPostAttempts')} IS 1
          AND ${kind('policy.automaticRetry')} IS 'false'
          AND ${field('policy.price')} IS 'usage-based-unknown'
          AND ${field('policy.promptStorage')} IS 'local-plaintext')`;
