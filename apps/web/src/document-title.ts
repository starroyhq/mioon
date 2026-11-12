type TitleDocument = Pick<Document, 'title'>;
interface TitleState {
  application: string;
  owner: { title: string } | null;
}
const titles = new WeakMap<TitleDocument, TitleState>();

function stateFor(document: TitleDocument): TitleState {
  let state = titles.get(document);
  if (!state) { state = { application: document.title, owner: null }; titles.set(document, state); }
  return state;
}
function apply(document: TitleDocument, state: TitleState): void {
  const title = state.owner?.title ?? state.application;
  if (document.title !== title) document.title = title;
}

/** A mounted native window can override the localized fallback. */
export function setApplicationDocumentTitle(document: TitleDocument, title: string): void {
  const state = stateFor(document);
  state.application = title;
  apply(document, state);
}

function claimWindowDocumentTitle(document: TitleDocument, title: string): () => void {
  const state = stateFor(document), owner = { title };
  state.owner = owner;
  apply(document, state);
  return () => {
    // A newer claim keeps ownership even when the title text matches.
    if (state.owner !== owner) return;
    state.owner = null;
    apply(document, state);
  };
}

export function claimProjectDocumentTitle(document: TitleDocument, projectName: string): () => void {
  return claimWindowDocumentTitle(document, `${projectName} · Mioon`);
}

export function claimLauncherDocumentTitle(document: TitleDocument): () => void {
  return claimWindowDocumentTitle(document, 'Mioon');
}
