type TitleDocument = Pick<Document, 'title'>;
interface TitleState {
  application: string;
  project: { title: string } | null;
}
const titles = new WeakMap<TitleDocument, TitleState>();

function stateFor(document: TitleDocument): TitleState {
  let state = titles.get(document);
  if (!state) { state = { application: document.title, project: null }; titles.set(document, state); }
  return state;
}
function apply(document: TitleDocument, state: TitleState): void {
  const title = state.project?.title ?? state.application;
  if (document.title !== title) document.title = title;
}

/** The locale owns the fallback, while a mounted project keeps precedence. */
export function setApplicationDocumentTitle(document: TitleDocument, title: string): void {
  const state = stateFor(document);
  state.application = title;
  apply(document, state);
}

export function claimProjectDocumentTitle(document: TitleDocument, projectName: string): () => void {
  const state = stateFor(document), owner = { title: `${projectName} · Mioon` };
  state.project = owner;
  apply(document, state);
  return () => {
    // An older effect must not release a newer project, even with the same name.
    if (state.project !== owner) return;
    state.project = null;
    apply(document, state);
  };
}
