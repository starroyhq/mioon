import type {ProjectStore} from '../../packages/business/src/project-file/store.ts';

/** Fixture access always uses the exact live kernel connection. */
export function clipDraftEntries(store:Pick<ProjectStore,'db'|'tx'>): Record<string,unknown>[] {
  return store.db.prepare('SELECT data FROM main.local_clip_drafts ORDER BY ordinal').all()
    .map(row=>JSON.parse(String(row.data)) as Record<string,unknown>);
}

export function clipDraftSnapshot(store:Pick<ProjectStore,'db'|'tx'>):string {
  return JSON.stringify({states:store.db.prepare('SELECT * FROM main.local_draft_states ORDER BY kind').all(),
    rows:store.db.prepare('SELECT * FROM main.local_clip_drafts ORDER BY ordinal').all()});
}

export function seedClipDraftEntries(store:Pick<ProjectStore,'db'|'tx'>,workspaceScope:string,entries:readonly {projectId:string;timelineId:string;clipId:string;revision:number;draft:unknown}[]):void {
  store.tx(()=>{
    if(!store.db.prepare("SELECT 1 FROM main.local_draft_states WHERE kind='clip'").get())
      store.db.prepare('INSERT INTO main.local_draft_states(kind,workspaceScope) VALUES(?,?)').run('clip',workspaceScope);
    store.db.exec('DELETE FROM main.local_clip_drafts');
    entries.forEach((row,index)=>store.db.prepare('INSERT INTO main.local_clip_drafts(projectId,timelineId,clipId,revision,ordinal,data) VALUES(?,?,?,?,?,?)')
      .run(row.projectId,row.timelineId,row.clipId,row.revision,index+1,JSON.stringify(row)));
  });
}
