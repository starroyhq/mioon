import type {DatabaseSync} from 'node:sqlite';

const families = [
  ['timelines',['data']], ['timeline_history',['beforeSnapshot','afterSnapshot']],
  ['timeline_requests',['response']], ['edit_tasks',['input']], ['exports',['data']],
  ['workspace_restore_timeline_history',['beforeSnapshot','afterSnapshot']],
  ['agent_edit_proposals',['definition']],
] as const;

/** Negative evidence only. A newer ordinary marker must never silently adopt
 * opacity values that belong to the separately registered candidate branch. */
export function assertNoRippleWorkspaceOpacity(db: DatabaseSync): void {
  for (const [table, columns] of families) {
    if (!db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name=?").get(table)) continue;
    for (const column of columns) {
      const text = `"${column}"`;
      const row = db.prepare(`SELECT 1 FROM main."${table}" WHERE
        typeof(${text})='text' AND length(CAST(${text} AS BLOB))<=4194304 AND
        EXISTS(SELECT 1 FROM json_tree(CASE WHEN json_valid(${text}) THEN ${text} ELSE '{}' END) AS item
          WHERE item.key IN ('opacityEnvelope','opacityEnvelopeProfile','opacityEnvelopeProcessingProfile','opacityEnvelopeSha256','opacityPlan')
          OR item.key='profileId' AND item.value='mioon-clip-linear-opacity-v1') LIMIT 1`).get();
      if (row) throw Object.assign(new Error('Opacity evidence requires its explicit candidate profile.'), {code:'RESTORE_SCHEMA_UNSUPPORTED'});
    }
  }
}
