/** Expected metadata for an already verified content mutation. The kernel
 * promises monotonic content sequence and synchronized companions, not a fixed
 * number of sequence increments per public operation. Business rows remain the
 * caller's exact oracle; only the verified sequence/token pair may change. */
import assert from 'node:assert/strict';
type Rows=Readonly<Record<string,readonly unknown[]>>;
export function expectedContentMetadata(before:Rows,after:Rows):Record<string,Record<string,unknown>[]> {
  assert.equal(before.project_file.length,1,'one original portable project metadata row');
  assert.equal(after.project_file.length,1,'one actual portable project metadata row');
  const record=(row:unknown):Record<string,unknown>=>{
    assert.ok(row!==null&&typeof row==='object'&&!Array.isArray(row),'metadata rows are records');return row as Record<string,unknown>;
  };
  const file=record(after.project_file[0]),priorFile=record(before.project_file[0]);
  const sequence=file.contentSequence,previous=priorFile.contentSequence,token=file.contentToken,priorToken=priorFile.contentToken;
  assert.ok(typeof sequence==='number'||typeof sequence==='bigint','actual SQLite sequence has its native numeric type');
  assert.equal(typeof sequence,typeof previous,'readBigInts mode is stable across snapshots');
  assert.ok(typeof previous==='number'||typeof previous==='bigint');
  assert.ok(Number.isSafeInteger(Number(sequence))&&Number.isSafeInteger(Number(previous)),'actual content sequences are safe integers');
  assert.ok(sequence>=0&&previous>=0,'actual content sequences are nonnegative');
  assert.ok(sequence>previous,'a verified content mutation advances the portable sequence');
  for(const value of [priorToken,token]){assert.equal(typeof value,'string');assert.match(String(value),/^[a-f0-9]{32}$/u,'content tokens have the exact kernel representation');}
  assert.notEqual(token,priorToken,'a verified content mutation replaces its token');
  assert.equal(typeof priorFile.projectId,'string');assert.notEqual(priorFile.projectId,'');
  assert.equal(file.projectId,priorFile.projectId,'content mutation cannot change project identity');
  const tables=['project_file','history_state',...(Object.hasOwn(before,'local_project_link')?['local_project_link']:[])];
  assert.equal(Object.hasOwn(after,'local_project_link'),Object.hasOwn(before,'local_project_link'),'no new companion metadata table appears');
  assert.equal(before.history_state.length,1,'one original history metadata row');
  assert.equal(after.history_state.length,1,'one actual history metadata row');
  return Object.fromEntries(tables.map(table=>{
    assert.equal(after[table].length,before[table].length,`${table} retains its complete row set`);
    return [table,before[table].map((value,index)=>{
      const row=record(value),actual=record(after[table][index]);
      assert.equal(row.projectId,priorFile.projectId,`${table} originally belongs to the same project`);
      if(table!=='project_file'){
        assert.equal(row.seenContentSequence,previous,`${table} baseline seen sequence matches its project`);
        assert.equal(row.seenContentToken,priorToken,`${table} baseline seen token matches its project`);
        assert.equal(actual.seenContentSequence,sequence,`${table} committed seen sequence matches its project`);
        assert.equal(actual.seenContentToken,token,`${table} committed seen token matches its project`);
      }
      const fields=table==='project_file'?{contentSequence:sequence,contentToken:token}:{seenContentSequence:sequence,seenContentToken:token};
      const expected=Object.assign(Object.create(Object.getPrototypeOf(row)),row,fields);
      assert.deepEqual(actual,expected,`${table} changes only its verified pair; identity and every other field stay exact`);
      return expected;
    })];
  }));
}
