import type {DatabaseSync} from 'node:sqlite';
import {assertProjectDatabase} from '../store-runtime.ts';
import {agentTaskRowValidationContext} from './task-row-validation-context.ts';
export interface AgentTaskRowValidationOptions {maxBytes?:number}
export function validateAgentTaskRowsV2(db:DatabaseSync,{maxBytes}:AgentTaskRowValidationOptions={}):void {
 assertProjectDatabase(db);
 const context=agentTaskRowValidationContext(db);
 if(!context)throw new TypeError('Project Agent task row validation requires a live application context');
 context.validateRows({maxBytes});
}
