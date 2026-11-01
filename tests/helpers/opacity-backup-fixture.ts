import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';

export const opacityBackupStamp = '2026-10-16T00:00:00.000Z';
export const hash = (value: Buffer|Uint8Array|string): string => createHash('sha256').update(value).digest('hex');
export const canonical = (value: unknown): string => JSON.stringify(value, (_key: string, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
export const raw = (value: unknown): string => ' \n' + JSON.stringify(value, null, '\t').replaceAll('界', '\\u754c') + '\n ';
const quote = (name: string): string => '"' + name.replaceAll('"', '""') + '"';
export function tree(root: string): [string, Record<string, unknown>][] {
  const visit = (relative: string): [string, Record<string, unknown>][] => {
    const file = path.join(root, relative), info = fs.lstatSync(file);
    if (info.isSymbolicLink()) return [[relative, {mode: info.mode, link: fs.readlinkSync(file)}]];
    if (info.isDirectory()) return [[relative, {mode: info.mode}], ...fs.readdirSync(file).sort().flatMap(name => visit(path.join(relative, name)))];
    return [[relative, {mode: info.mode, bytes: info.size, sha256: hash(fs.readFileSync(file))}]];
  };
  return visit('');
}
export function logicalTables(db: DatabaseSync): Record<string, {fields: unknown; rows: unknown[]}> {
  return Object.fromEntries((db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' ORDER BY name").all() as {name: string}[]).map(({name}) => {
    const fields = (db.prepare(`PRAGMA main.table_info(${quote(name)})`).all() as {name: string}[]).map((row: {name: string}) => row.name);
    const statement = db.prepare(`SELECT rowid AS originalRowid,${fields.map(quote).join(',')} FROM main.${quote(name)} ORDER BY rowid`);
    statement.setReadBigInts(true);
    return [name, {fields, rows: statement.all()}];
  }));
}
export function originalRows(db: DatabaseSync, table: string, fields: readonly string[], where = ''): unknown[] {
  const statement = db.prepare(`SELECT rowid AS originalRowid,${fields.map(quote).join(',')} FROM main.${quote(table)} ${where} ORDER BY rowid`);
  statement.setReadBigInts(true); return statement.all();
}

