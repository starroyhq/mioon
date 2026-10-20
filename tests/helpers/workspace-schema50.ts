import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {initializeWorkspaceSchemaThrough24} from '../../packages/business/src/workspace-fixed-schema.ts';
import {initializeWorkspaceSchema26} from '../../packages/business/src/workspace-schema-v26.ts';
import {initializeWorkspaceSchema28} from '../../packages/business/src/workspace-schema-v28.ts';
import {initializeWorkspaceSchema30} from '../../packages/business/src/workspace-schema-v30.ts';
import {initializeWorkspaceSchema32} from '../../packages/business/src/workspace-schema-v32.ts';
import {initializeWorkspaceSchema34} from '../../packages/business/src/workspace-schema-v34.ts';
import {initializeWorkspaceSchema36} from '../../packages/business/src/workspace-schema-v36.ts';
import {initializeWorkspaceSchema38} from '../../packages/business/src/workspace-schema-v38.ts';
import {initializeWorkspaceSchema40} from '../../packages/business/src/workspace-schema-v40.ts';
import {initializeWorkspaceSchema44} from '../../packages/business/src/workspace-schema-v44.ts';
import {initializeWorkspaceSchema48} from '../../packages/business/src/workspace-schema-v48.ts';
import {initializeWorkspaceSchema50} from '../../packages/business/src/workspace-schema-v50.ts';

/** Construct the real frozen remote50 catalog, never the current openStore
 * catalog with markers removed. Used by migration and archive compatibility. */
export function createSource50Database(root?:string):DatabaseSync {
 if(root){mkdirSync(root,{recursive:true,mode:0o700});mkdirSync(join(root,'media'),{mode:0o700});}
 const db=new DatabaseSync(root?join(root,'workbench.sqlite'):':memory:');
 try{
  db.exec('PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF;');
  for(const initialize of [initializeWorkspaceSchemaThrough24,initializeWorkspaceSchema26,initializeWorkspaceSchema28,initializeWorkspaceSchema30,initializeWorkspaceSchema32,initializeWorkspaceSchema34,initializeWorkspaceSchema36,initializeWorkspaceSchema38,initializeWorkspaceSchema40])initialize(db);
  initializeWorkspaceSchema44(db,initializeWorkspaceSchemaThrough24);initializeWorkspaceSchema48(db,initializeWorkspaceSchemaThrough24);initializeWorkspaceSchema50(db,initializeWorkspaceSchemaThrough24);
  if(root)chmodSync(join(root,'workbench.sqlite'),0o600);return db;
 }catch(error){db.close();throw error;}
}
