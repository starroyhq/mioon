/** Current S1 cache overlay. The format-72 constructors and historical
 * derivation remain frozen; only the generated current cache uses this DDL. */
export function currentCacheStatements(historical: readonly string[]): string[] {
  let waveforms = 0, thumbnails = 0;
  const statements = historical.map(sql => {
    if (sql.startsWith('CREATE TABLE waveform_cache(')) {
      waveforms++;
      return sql.replaceAll('sourceSha256', 'sourceFingerprint');
    }
    if (sql.startsWith('CREATE TABLE previs_thumbnails(')) {
      thumbnails++;
      return sql.replace(' sceneRevision INTEGER', " sourceFingerprintDigest TEXT NOT NULL CHECK(length(CAST(sourceFingerprintDigest AS BLOB))=64),\n sceneRevision INTEGER");
    }
    return sql;
  });
  if (waveforms !== 1 || thumbnails !== 1) throw new Error('The S1 cache overlay requires the exact historical cache tables');
  return statements;
}
