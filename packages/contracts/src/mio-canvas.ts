import {z} from 'zod';
import {projectIdSchema} from './project-file.ts';

export const MIO_CANVAS_SELECTION_LIMIT=100;
const selected=<Kind extends 'shot'|'node'|'edge'>(kind:z.ZodType<Kind>)=>z.array(z.object({kind,id:projectIdSchema}).strict())
 .min(1).max(MIO_CANVAS_SELECTION_LIMIT).refine(targets=>new Set(targets.map(({kind,id})=>`${kind}:${id}`)).size===targets.length);
const archiveTargets=selected(z.enum(['shot','node','edge']));

/** Model-only inputs. Identity, live revisions and the edit receipt belong to the host. */
export const mioCanvasSchemas=Object.freeze({
 'canvas.layout':z.object({targets:selected(z.enum(['shot','node'])).optional()}).strict(),
 'canvas.archive':z.object({targets:archiveTargets}).strict(),
 'canvas.restore':z.object({targets:archiveTargets}).strict(),
});
export type MioCanvasOperation=keyof typeof mioCanvasSchemas;
export const mioCanvasOperations=Object.freeze(Object.keys(mioCanvasSchemas) as MioCanvasOperation[]);
export function isMioCanvasOperation(operation:string):operation is MioCanvasOperation {
 return Object.hasOwn(mioCanvasSchemas,operation);
}
export const mioCanvasToolName=(operation:MioCanvasOperation):string=>`mioon_${operation.replace('.','_')}`;
export const mioCanvasOperationForTool=(name:string):MioCanvasOperation|undefined=>mioCanvasOperations.find(operation=>mioCanvasToolName(operation)===name);
