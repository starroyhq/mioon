import {component as originalComponent,nodes as originalNodes,textOf} from '../fixtures/export-range-ui-harness.ts';
import type {ElementTree,ElementNode} from './strict-timeline-audio-harness-types.ts';
export const component=originalComponent as (file:string)=>{default:(props:Record<string,unknown>)=>ElementTree};
export const nodes=originalNodes as (tree:unknown)=>ElementNode[];
export {textOf};
