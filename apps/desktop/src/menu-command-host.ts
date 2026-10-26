import {freezeMenuCommandState, isMenuCommandId, isMenuCommandRequest, sameMenuDocument} from './menu-command-protocol.ts';
import type {MenuCommandId, MenuCommandIntent, MenuCommandState, MenuDocumentIdentity} from './menu-command-protocol.ts';

export interface MenuCommandDocument extends MenuDocumentIdentity {
  readonly frame: unknown;
  isCurrent(): boolean;
}
export interface MenuCommandIPCEvent<Contents> {readonly sender: Contents; readonly senderFrame: unknown}
interface Options<Contents, Document extends MenuCommandDocument> {
  getDocument(contents: Contents): Document | null;
  isAllowed(document: Document, command: MenuCommandId): boolean;
  send(document: Document, intent: MenuCommandIntent): void;
  onChanged?(): void;
}
interface Report<Document> {readonly document: Document; readonly state: MenuCommandState}
const rejected = () => new Error('Native menu commands are unavailable.');
const identity = (value: MenuDocumentIdentity): MenuDocumentIdentity => Object.freeze({version: 1,
  windowId: value.windowId, backendId: value.backendId, contextId: value.contextId, role: value.role});

/** Every lookup captures the current committed document again. A renderer's
 * availability report can never transfer an intent across windows or reloads. */
export function createMenuCommandHost<Contents, Document extends MenuCommandDocument>(options: Options<Contents, Document>) {
  const reports = new Map<Contents, Report<Document>>();
  let active = true, sequence = 0;
  function current(contents: Contents): Document | null {
    if (!active) return null;
    try {
      const document = options.getDocument(contents);
      return document && document.frame !== null && typeof document.frame === 'object' && document.isCurrent() ? document : null;
    }
    catch { return null; }
  }
  function reportFor(contents: Contents): Report<Document> | null {
    const document = current(contents), report = reports.get(contents);
    if (!document || !report || report.document.frame !== document.frame || !sameMenuDocument(report.document, document)) {
      reports.delete(contents); return null;
    }
    return {document, state: report.state};
  }
  function dispatch(event: MenuCommandIPCEvent<Contents>, request: unknown): MenuDocumentIdentity | boolean {
    if (!isMenuCommandRequest(request)) throw rejected();
    const document = current(event.sender);
    if (!document || event.senderFrame !== document.frame) throw rejected();
    if (request.action === 'describe') return identity(document);
    if (request.contextId !== document.contextId) throw rejected();
    const previous = reportFor(event.sender);
    if (previous && request.state.reportVersion <= previous.state.reportVersion) return false;
    reports.set(event.sender, {document, state: freezeMenuCommandState(request.state)});
    options.onChanged?.();
    return true;
  }
  function stateFor(contents: Contents): MenuCommandState | null { return reportFor(contents)?.state ?? null; }
  function canDispatch(contents: Contents, command: MenuCommandId): boolean {
    if (!isMenuCommandId(command)) return false;
    const report = reportFor(contents);
    if (!report || !report.state.commands[command]) return false;
    try { return options.isAllowed(report.document, command) === true && report.document.isCurrent(); }
    catch { return false; }
  }
  function send(contents: Contents, command: MenuCommandId): boolean {
    if (!canDispatch(contents, command)) return false;
    const report = reportFor(contents);
    if (!report || !report.state.commands[command] || sequence >= Number.MAX_SAFE_INTEGER) return false;
    // Check policy against this exact second capture, not a snapshot obtained
    // before a synchronous native callback changed the current window.
    try {
      if (!options.isAllowed(report.document, command) || !report.document.isCurrent()) return false;
      const intent: MenuCommandIntent = Object.freeze({...identity(report.document), command, sequence: ++sequence, reportVersion: report.state.reportVersion});
      options.send(report.document, intent);
      return true;
    } catch { return false; /* Dispatch uncertainty is never an automatic retry. */ }
  }
  function forget(contents: Contents): void { if (reports.delete(contents)) options.onChanged?.(); }
  function dispose(): void { if (active) { active = false; reports.clear(); options.onChanged?.(); } }
  return Object.freeze({dispatch, stateFor, canDispatch, send, forget, dispose});
}
