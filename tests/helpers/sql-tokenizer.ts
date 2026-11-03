// Pure SQL lexer shared by schema-source validation and the trigger graph guard.
export interface SqlToken {
  readonly kind: 'word' | 'quoted' | 'string' | 'number' | 'punct';
  readonly text: string;
  /** Identifier or string content without quotes; equals `text` for other kinds. */
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

const WORD_START = /[A-Za-z_\u0080-\uffff]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-\uffff]/;

export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (sql.startsWith('--', i)) { const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end + 1; continue; }
    if (sql.startsWith('/*', i)) { const end = sql.indexOf('*/', i + 2); i = end < 0 ? sql.length : end + 2; continue; }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1, value = '';
      for (;;) {
        const k = sql.indexOf(close, j);
        if (k < 0) throw new Error(`Unterminated ${c} at offset ${i}`);
        value += sql.slice(j, k);
        if (close !== ']' && sql[k + 1] === close) { value += close; j = k + 2; continue; }
        j = k + 1;
        break;
      }
      tokens.push({kind: c === "'" ? 'string' : 'quoted', text: sql.slice(i, j), value, start: i, end: j});
      i = j;
      continue;
    }
    if (WORD_START.test(c) || /[0-9]/.test(c)) {
      const word = WORD_START.test(c);
      let j = i + 1;
      while (j < sql.length && (word ? WORD_PART : /[0-9A-Za-z_.]/).test(sql[j]!)) j++;
      const text = sql.slice(i, j);
      tokens.push({kind: word ? 'word' : 'number', text, value: text, start: i, end: j});
      i = j;
      continue;
    }
    tokens.push({kind: 'punct', text: c, value: c, start: i, end: i + 1});
    i++;
  }
  return tokens;
}
