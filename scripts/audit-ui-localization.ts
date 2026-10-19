import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface UILiteralRecord {
  readonly file: string;
  readonly line: number;
  readonly category: string;
  readonly hash: string;
  readonly text: string;
}
export interface UILedgerRow {
  readonly file: string;
  readonly category: string;
  readonly hash: string;
  readonly reason: string;
  readonly owner: string;
}
interface UILedgerShape { readonly version: 1; readonly exceptions: UILedgerRow[] }

const root = fileURLToPath(new URL('../', import.meta.url));
const scanRoots = ['apps/web/src', 'apps/desktop/src', 'packages/ui/src'];
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const words = /\p{Letter}/u;
const visibleAttributes = new Set(['title', 'placeholder', 'alt', 'aria-label', 'aria-description']);
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
type TextualNode = ts.Node & {readonly text: string};
export function visibleTemplateFragment(node: ts.Node, source: ts.SourceFile): boolean {
  if (!ts.isTemplateHead(node) && !ts.isTemplateMiddle(node) && !ts.isTemplateTail(node)) return false;
  let child: ts.Node = node;
  for (let parent: ts.Node | undefined = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression)) {
      const name = parent.expression.text;
      const keyIndex = ['t', 'nt', 'nativeText', 'message', 'msg', 'localizedMessage'].includes(name) ? 0 : name === 'translate' ? 1 : -1;
      if (keyIndex >= 0 && parent.arguments[keyIndex] === child) return false;
    }
    if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent) || ts.isFunctionDeclaration(parent)) return false;
    if (ts.isJsxExpression(parent)) return !ts.isJsxAttribute(parent.parent) || visibleAttributes.has(parent.parent.name.getText(source));
  }
  return false;
}

function files(directory: string): string[] {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const relative = `${directory}/${entry.name}`;
    return entry.isDirectory() ? files(relative) : /\.(?:[cm]?js|jsx|tsx?)$/u.test(entry.name) ? [relative] : [];
  });
}
/** This is a regression guard, not semantic translation acceptance. It catches
 * new CJK source literals and static visible JSX copy. Dynamic display mappings
 * and source-English strings in helpers still require module/native review. */
export function inspectUILiterals(): UILiteralRecord[] {
  const records: UILiteralRecord[] = [];
  for (const file of scanRoots.flatMap(files).sort()) {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node): void {
      const literal = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
      const jsxText = ts.isJsxText(node);
      if (literal || jsxText) {
        const textual = node as TextualNode;
        const text = textual.text.trim();
        const attribute = literal && ts.isJsxAttribute(textual.parent) && visibleAttributes.has(textual.parent.name.getText(source));
        const expression = literal && ts.isJsxExpression(textual.parent) && textual.parent.expression === node;
        const category = cjk.test(text) ? 'cjk-source' : words.test(text) && (jsxText || attribute || expression || visibleTemplateFragment(node, source)) ? 'visible-jsx' : null;
        if (category) records.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          category, hash: digest(`${ts.SyntaxKind[node.kind]}\0${text}`), text });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return records;
}

function identity(row: Pick<UILedgerRow, 'file' | 'category' | 'hash'>): string {
  return `${String(row.file)}\0${String(row.category)}\0${String(row.hash)}`;
}
export function compareUILedger(records: readonly UILiteralRecord[], ledger: unknown): {unreviewed: UILiteralRecord[]; stale: UILedgerRow[]} {
  const parsed = recordOf(ledger);
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.exceptions)) throw new Error('Invalid UI localization ledger.');
  const present = new Set(records.map(identity)), allowed = new Map<string, UILedgerRow>();
  for (const candidate of parsed.exceptions) {
    const row = recordOf(candidate);
    if (typeof row?.reason !== 'string' || !row.reason.trim() || typeof row.owner !== 'string' || !row.owner.trim()) throw new Error('Unexplained UI localization exception.');
    const exception = row as unknown as UILedgerRow;
    if (allowed.has(identity(exception))) throw new Error(`Duplicate UI localization exception: ${String(exception.file)}`);
    allowed.set(identity(exception), exception);
  }
  return { unreviewed: records.filter(row => !allowed.has(identity(row))), stale: [...allowed.values()].filter(row => !present.has(identity(row))) };
}

export function readUILedger(): UILedgerShape {
  const fragments = ['foundation', 'shell', 'creation', 'timeline', 'delivery', 'delivery-clients'];
  const exceptions: UILedgerRow[] = fragments.flatMap(name => {
    const fragment = recordOf(JSON.parse(fs.readFileSync(path.join(root, `docs/i18n-ui-exceptions-${name}.json`), 'utf8')));
    if (!fragment || fragment.version !== 1 || !Array.isArray(fragment.exceptions)) throw new Error(`Invalid UI localization fragment: ${name}`);
    return fragment.exceptions as UILedgerRow[];
  });
  return { version: 1, exceptions };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const records = inspectUILiterals();
  if (process.argv.includes('--inventory')) console.log(JSON.stringify(records, null, 2));
  else {
    const ledger = readUILedger();
    const result = compareUILedger(records, ledger);
    console.log(JSON.stringify({ ...result, reviewedLiteralCount: records.length }, null, 2));
    if (result.unreviewed.length || result.stale.length) process.exitCode = 1;
  }
}
