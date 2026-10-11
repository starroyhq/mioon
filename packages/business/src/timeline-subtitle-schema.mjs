// Schema22 changes only the fixed operation CHECK. Retain the original DDL and
// raw columns, including future-independent user indexes and triggers. A marker
// retry on an already-expanded table does not needlessly rebuild anything.
const additions=['timeline.subtitle.add','timeline.subtitle.update','timeline.subtitle.remove'];
const legacy=['timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.update','timeline.clip.replaceSource','timeline.clip.remove','timeline.clip.split','timeline.seed','timeline.undo','timeline.redo','reference.attach','reference.detach','subject.create','subject.version.add','subject.binding.set','timeline.format.set'];
const columns='position,id,projectId,operation,input,requestId,digest,lane,origin,status,revision,acknowledged,claim,claimInstance,receiptDigest,errorCode,createdAt,updatedAt,bytes';
export function migrateTimelineSubtitleEditTasks(db){
 if(!db.isTransaction)throw new Error('Timeline subtitle task migration requires a transaction');
 if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='edit_tasks_subtitles'").get())throw new Error('Timeline subtitle task migration staging table already exists');
 const sql=db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='edit_tasks'").get()?.sql;
 const match=sql?.match(/CHECK\(operation IN \(([^)]+)\)\)/);
 if(!match)throw new Error('Edit task operation constraint is unavailable');
 const operations=match[1].split(',').map(value=>value.trim().match(/^'([^']+)'$/)?.[1]);
 const full=[...legacy,...additions],known=operations.length===legacy.length?legacy:operations.length===full.length?full:null;
 if(!known||new Set(operations).size!==known.length||known.some(value=>!operations.includes(value)))throw new Error('Edit task operation constraint is inconsistent');
 if(known===full)return;
 const sequence=db.prepare("SELECT rowid AS rowid,seq FROM sqlite_sequence WHERE name='edit_tasks'").get();
 const maximum=db.prepare('SELECT MAX(position) AS value FROM edit_tasks').get().value;
 if(sequence&&(!Number.isSafeInteger(sequence.seq)||sequence.seq<0||(maximum!==null&&sequence.seq<maximum))||!sequence&&maximum!==null)
  throw new Error('Edit task sequence is inconsistent');
 const protections=db.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name='edit_tasks' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name").all();
 const expanded=sql.replace(match[0],`CHECK(operation IN (${match[1]},${additions.map(value=>`'${value}'`).join(',')}))`);
 const staging=expanded.replace(/^(CREATE TABLE(?: IF NOT EXISTS)?\s+)(?:"edit_tasks"|`edit_tasks`|\[edit_tasks\]|edit_tasks)(?=\s*\()/i,'$1"edit_tasks_subtitles"');
 if(staging===expanded)throw new Error('Edit task table definition is inconsistent');
 db.exec(staging);
 db.exec(`INSERT INTO edit_tasks_subtitles(${columns}) SELECT ${columns} FROM edit_tasks;
 DROP TABLE edit_tasks;
 ALTER TABLE edit_tasks_subtitles RENAME TO edit_tasks;`);
 for(const item of protections)db.exec(item.sql);
 db.prepare("DELETE FROM sqlite_sequence WHERE name='edit_tasks'").run();
 if(sequence)db.prepare("INSERT INTO sqlite_sequence(rowid,name,seq) VALUES(?,'edit_tasks',?)").run(sequence.rowid,sequence.seq);
}
