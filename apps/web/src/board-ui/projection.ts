import type {ChainNodeKind, FilmChainDerivation, BoardSequenceIssue} from '../../../../packages/contracts/src/board-sequence.ts';

export type BoardGenerationStatus = 'ready' | 'generating' | 'pending';

/** Presentation data, independent of the project's stored node shape. */
export interface BoardUiNode {
  readonly id: string;
  readonly kind: ChainNodeKind;
  readonly name: string;
  readonly aspectRatio?: string | null;
  readonly durationFrames?: number | null;
  readonly status?: BoardGenerationStatus;
  readonly thumbnailUrl?: string | null;
  /** Video thumbnails must render through `<video>`; a video file in `<img>`
   * shows the browser's broken-image glyph even though the media is readable. */
  readonly thumbnailKind?: 'image' | 'video';
  /** SB-b: the retained subject row behind a `subject` card. */
  readonly subjectId?: string;
  readonly subjectKind?: 'character' | 'product' | 'location' | 'look';
}

export interface BoardFilmItem {
  readonly nodeId: string;
  readonly kind: ChainNodeKind;
  readonly name: string;
  readonly durationFrames: number | null;
  readonly status: BoardGenerationStatus;
  readonly thumbnailUrl: string | null;
  readonly thumbnailKind?: 'image' | 'video';
}

export interface BoardFilmOverview {
  readonly shotCount: number;
  readonly completedCount: number;
  readonly generatingCount: number;
  readonly pendingCount: number;
  readonly floatingCount: number;
  readonly durationFrames: number | null;
}

export interface BoardFilmProjection {
  readonly id: string;
  readonly name: string;
  readonly aspectRatio: string | null;
  readonly durationFrames: number | null;
  readonly shotCount: number;
  readonly items: readonly BoardFilmItem[];
  readonly overview: BoardFilmOverview;
}

export interface BoardUiProjection {
  readonly films: readonly BoardFilmProjection[];
  readonly floatingNodeIds: readonly string[];
  readonly overview: BoardFilmOverview;
  readonly issues: readonly BoardSequenceIssue[];
}

/** Only reference edges belong here; sequence membership comes from SA. */
export interface BoardUiReference {
  readonly sourceId: string;
  readonly targetId: string;
}

function duration(node: BoardUiNode): number | null {
  const frames = node.durationFrames;
  if (frames == null) return null;
  if (!Number.isSafeInteger(frames) || frames <= 0) throw new TypeError('Invalid board presentation duration');
  return frames;
}

function totalDuration(items: readonly BoardFilmItem[]): number | null {
  let frames = 0;
  for (const item of items) {
    if (item.durationFrames === null) return null;
    frames += item.durationFrames;
    if (!Number.isSafeInteger(frames)) throw new TypeError('Board presentation duration exceeds the safe integer range');
  }
  return frames;
}

function overview(items: readonly BoardFilmItem[], floatingCount: number): BoardFilmOverview {
  const shots = items.filter(item => item.kind === 'shot');
  return {
    shotCount: shots.length,
    completedCount: shots.filter(item => item.status === 'ready').length,
    generatingCount: shots.filter(item => item.status === 'generating').length,
    pendingCount: shots.filter(item => item.status === 'pending').length,
    floatingCount,
    durationFrames: totalDuration(items),
  };
}

/** Follow SA's film order, then attach references to the shots reachable from every root. */
export function projectBoardUi(
  derivation: FilmChainDerivation,
  nodes: readonly BoardUiNode[],
  references: readonly BoardUiReference[],
): BoardUiProjection {
  const byId = new Map<string, BoardUiNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) throw new TypeError('Duplicate board presentation node');
    byId.set(node.id, node);
  }
  const requiredNode = (id: string): BoardUiNode => {
    const node = byId.get(id);
    if (!node) throw new TypeError('Board presentation node is missing');
    return node;
  };
  const reachableShotIds = new Set(derivation.chains.flatMap(chain => chain.nodeIds)
    .filter(id => requiredNode(id).kind === 'shot'));
  const referenceSources = new Set(references.filter(edge => reachableShotIds.has(edge.targetId)).map(edge => edge.sourceId));
  const floatingNodeIds = derivation.detachedNodeIds.filter(id => requiredNode(id).kind !== 'film' && !referenceSources.has(id));
  const itemsById = new Map<string, BoardFilmItem>();
  const films = derivation.chains.map(chain => {
    const root = requiredNode(chain.filmId);
    if (root.kind !== 'film') throw new TypeError('Board presentation root is not a film');
    const items = chain.nodeIds.map(id => {
      const existing = itemsById.get(id);
      if (existing) return existing;
      const node = requiredNode(id);
      const item: BoardFilmItem = {
        nodeId: id,
        kind: node.kind,
        name: node.name,
        durationFrames: duration(node),
        status: node.status ?? 'pending',
        thumbnailUrl: node.thumbnailUrl ?? null,
        ...(node.thumbnailKind ? {thumbnailKind: node.thumbnailKind} : {}),
      };
      itemsById.set(id, item);
      return item;
    });
    const summary = overview(items, floatingNodeIds.length);
    return {
      id: root.id,
      name: root.name,
      aspectRatio: root.aspectRatio ?? null,
      durationFrames: summary.durationFrames,
      shotCount: summary.shotCount,
      items,
      overview: summary,
    };
  });
  return {
    films,
    floatingNodeIds,
    overview: overview([...itemsById.values()], floatingNodeIds.length),
    issues: derivation.issues,
  };
}
