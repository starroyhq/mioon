/** Expected metadata for an already verified content mutation. The kernel
 * promises monotonic content sequence and synchronized companions, not a fixed
 * number of sequence increments per public operation. Business rows remain the
 * caller's exact oracle; this only names those three kernel-owned fields. */
import assert from 'node:assert/strict';
type Rows=Readonly<Record<string,readonly unknown[]>>;
export function expectedContentMetadata(before:Rows,after:Rows):Record<string,Record<string,unknown>[]> {
  assert.equal(after.project_file.length,1,'one actual portable project metadata row');
  const sequence=(after.project_file[0] as Record<string,unknown>).contentSequence,previous=(before.project_file[0] as Record<string,unknown>).contentSequence;
  assert.ok(typeof sequence==='number'||typeof sequence==='bigint','actual SQLite sequence has its native numeric type');
  assert.equal(typeof sequence,typeof previous,'readBigInts mode is stable across snapshots');
  assert.ok(typeof previous==='number'||typeof previous==='bigint');
  assert.ok(Number.isSafeInteger(Number(sequence))&&Number.isSafeInteger(Number(previous)),'actual content sequences are safe integers');
  assert.ok(sequence>previous,'a verified content mutation advances the portable sequence');
  const tables=['project_file','history_state',...(Object.hasOwn(before,'local_project_link')?['local_project_link']:[])];
  assert.equal(Object.hasOwn(after,'local_project_link'),Object.hasOwn(before,'local_project_link'),'no new companion metadata table appears');
  return Object.fromEntries(tables.map(table=>[table,before[table]!.map(row=>Object.assign(Object.create(Object.getPrototypeOf(row)),row,{
    [table==='project_file'?'contentSequence':'seenContentSequence']:sequence}))]));
}
