import {deriveFilmChains} from '../../../packages/contracts/src/board-sequence.ts';
import type {BoardUiNode} from '../../../apps/web/src/board-ui/projection.ts';
import {projectBoardUi} from '../../../apps/web/src/board-ui/projection.ts';
import type {BoardUiEdge} from '../../../apps/web/src/board-ui/BoardUiStatic.tsx';

export function thumbnail(index: number): string {
  const colors = [['#103840', '#dce8a8'], ['#252b4b', '#edb686'], ['#22143d', '#d74fa8'], ['#8bb8e5', '#f8cf18']];
  const [background, foreground] = colors[index % colors.length]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270"><rect width="480" height="270" fill="${background}"/><ellipse cx="240" cy="135" rx="195" ry="220" fill="none" stroke="${foreground}" stroke-opacity=".35" stroke-width="4"/><circle cx="240" cy="135" r="61" fill="${foreground}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const sampleNodes: readonly BoardUiNode[] = [
  {id:'film',kind:'film',name:'成片',aspectRatio:'9:16'},
  {id:'shot-1',kind:'shot',name:'城市夜景 · 推镜',aspectRatio:'16:9',durationFrames:120,status:'ready',thumbnailUrl:thumbnail(0)},
  {id:'shot-2',kind:'shot',name:'路口俯拍',aspectRatio:'9:16',durationFrames:90,status:'generating',thumbnailUrl:thumbnail(1)},
  {id:'shot-3',kind:'shot',name:'霓虹特写',aspectRatio:'16:9',durationFrames:90,status:'ready',thumbnailUrl:thumbnail(2)},
  {id:'shot-4',kind:'shot',name:'海岸航拍 · 横移',aspectRatio:'16:9',durationFrames:150,status:'pending'},
  {id:'image',kind:'image',name:'参考图 · 街景',thumbnailUrl:thumbnail(3)},
  {id:'subject',kind:'subject',name:'人物 · 合成角色',thumbnailUrl:thumbnail(2)},
  {id:'text',kind:'text',name:'第二幕：由街景过渡到霓虹特写，节奏放慢，保持冷色调。'},
];
const sampleEdges: readonly BoardUiEdge[] = [
  {id:'sequence-1',kind:'sequence',sourceId:'film',targetId:'shot-1'},
  {id:'sequence-2',kind:'sequence',sourceId:'shot-1',targetId:'shot-2'},
  {id:'sequence-3',kind:'sequence',sourceId:'shot-2',targetId:'shot-3'},
  {id:'sequence-4',kind:'sequence',sourceId:'shot-3',targetId:'shot-4'},
  {id:'reference-1',kind:'reference',sourceId:'image',targetId:'shot-3',role:'first_frame'},
  {id:'reference-2',kind:'reference',sourceId:'subject',targetId:'shot-3',role:'subject_reference',sourcePort:'reference-out-top',targetPort:'reference-in-bottom'},
  {id:'reference-3',kind:'reference',sourceId:'subject',targetId:'shot-4',role:'subject_reference',sourcePort:'reference-out-top',targetPort:'reference-in-bottom'},
];
const samplePositions = {
  film:{x:20,y:155},'shot-1':{x:205,y:45},'shot-2':{x:505,y:45},
  'shot-3':{x:315,y:355},'shot-4':{x:595,y:355},
  image:{x:20,y:300},subject:{x:480,y:625},text:{x:20,y:630},
};

export function boardScene(stress = false) {
  const nodes: BoardUiNode[] = stress ? [{id:'film',kind:'film',name:'成片',aspectRatio:'16:9'}] : [...sampleNodes];
  const edges: BoardUiEdge[] = stress ? [] : [...sampleEdges];
  const positions: Record<string,{x:number;y:number}> = stress ? {film:{x:-220,y:120}} : {...samplePositions};
  if (stress) for(let index=0;index<100;index++) {
    const shotId=`stress-shot-${index}`,imageId=`stress-image-${index}`;
    const x=(index%10)*310,y=Math.floor(index/10)*370;
    nodes.push({id:shotId,kind:'shot',name:`Shot ${index+1}`,status:'ready',durationFrames:90,aspectRatio:'16:9',thumbnailUrl:thumbnail(index)});
    nodes.push({id:imageId,kind:'image',name:`Image ${index+1}`,thumbnailUrl:thumbnail(index+1)});
    positions[shotId]={x,y:y+155};positions[imageId]={x:x+100,y};
    edges.push({id:`stress-sequence-${index}`,kind:'sequence',sourceId:index===0?'film':`stress-shot-${index-1}`,targetId:shotId});
    edges.push({id:`stress-reference-${index}`,kind:'reference',sourceId:imageId,targetId:shotId,role:'first_frame'});
  }
  const derivation=deriveFilmChains({nodes,edges:edges.filter(edge=>edge.kind==='sequence').map(edge=>({fromId:edge.sourceId,toId:edge.targetId}))});
  return {nodes,edges,positions,projection:projectBoardUi(derivation,nodes)};
}
