import React, {memo} from 'react';
import type {ReactElement, ReactNode} from 'react';

const inlineTokens = /\\[!()*+\-.\[\]#_`\\~]|`+|\*+|_+|<[^<>]*>|(?<image>!)?\[(?<label>[^\[\]]+)\]\((?<url>(?:[^()\s]|\([^()\s]*\))+)\)/gu;
const whitespace = /\s/u;
const word = /[\p{L}\p{N}]/u;
const maxNesting = 12;

type Emphasis = {marker: string; start: number; children: ReactNode[]};

function inline(text: string): ReactNode[] {
  const codeEnds = new Map<number, number>(), nextCodeRun = new Map<number, number>();
  const codeRuns = [...text.matchAll(/`+/gu)];
  for (let index = codeRuns.length - 1; index >= 0; index--) {
    const {0: run, index: start} = codeRuns[index]!;
    const end = nextCodeRun.get(run.length);
    if (end !== undefined) codeEnds.set(start, end);
    nextCodeRun.set(run.length, start);
  }

  const result: ReactNode[] = [], open: Emphasis[] = [];
  const append = (node: ReactNode): void => {(open.at(-1)?.children ?? result).push(node);};
  let cursor = 0;
  for (const match of text.matchAll(inlineTokens)) {
    const {0: token, index: start, groups} = match;
    if (start < cursor) continue;
    if (start > cursor) append(text.slice(cursor, start));
    cursor = start + token.length;
    if (token.startsWith('\\')) {
      append(token.slice(1));
    } else if (token.startsWith('`')) {
      const end = codeEnds.get(start);
      if (end === undefined) append(token);
      else {
        append(<code key={start}>{text.slice(cursor, end)}</code>);
        cursor = end + token.length;
      }
    } else if (groups?.label !== undefined && !groups.image) {
      append(<React.Fragment key={start}>{inline(groups.label)} ({groups.url})</React.Fragment>);
    } else if ((token.startsWith('*') || token.startsWith('_')) && token.length <= 3) {
      const marker = token[0]!, before = text[start - 1], after = text[cursor];
      const withinWord = marker === '_' && before !== undefined && after !== undefined && word.test(before) && word.test(after);
      let remaining = token.length;
      if (!withinWord && before !== undefined && !whitespace.test(before)) {
        while (open.length) {
          const top = open.at(-1)!;
          if (top.marker[0] !== marker || top.marker.length > remaining) break;
          open.pop();
          append(top.marker.length === 2 ? <strong key={top.start}>{top.children}</strong> : <em key={top.start}>{top.children}</em>);
          remaining -= top.marker.length;
        }
      }
      if (remaining && !withinWord && after !== undefined && !whitespace.test(after) && open.length + 2 <= maxNesting) {
        const widths = remaining === 3 ? [1, 2] : [remaining];
        let offset = cursor - remaining;
        for (const width of widths) {
          open.push({marker: marker.repeat(width), start: offset, children: []});
          offset += width;
        }
      } else if (remaining) append(marker.repeat(remaining));
    } else append(token);
  }
  if (cursor < text.length) append(text.slice(cursor));
  // Unclosed markup stays visible as entered. Closing it only restyles this span.
  while (open.length) {
    const pending = open.pop()!;
    append(pending.marker);
    for (const child of pending.children) append(child);
  }
  return result;
}

function listItem(line: string) {
  const match = /^(?<indent>[ \t]*)(?:[-+*]|(?<number>[0-9]{1,9})[.)])[ \t]+(?<text>\S.*)$/u.exec(line)?.groups;
  if (match === undefined) return null;
  return {indent: match.indent!.replace(/\t/g, '    ').length, number: match.number, text: match.text!};
}

function list(lines: readonly string[], start: number, first: NonNullable<ReturnType<typeof listItem>>, depth = 0): {node: ReactElement; end: number} {
  const ordered = first.number !== undefined;
  let end = start, item: ReturnType<typeof listItem> = first;
  const items: ReactElement[] = [];
  while (item && item.indent === first.indent && (item.number !== undefined) === ordered) {
    const key = end, contents = inline(item.text);
    item = listItem(lines[++end] ?? '');
    while (item && item.indent > first.indent && depth + 1 < maxNesting) {
      const nested = list(lines, end, item, depth + 1);
      contents.push(nested.node);
      end = nested.end;
      item = listItem(lines[end] ?? '');
    }
    items.push(<li key={key}>{contents}</li>);
  }
  return {node: ordered ? <ol key={start} start={Number(first.number)}>{items}</ol> : <ul key={start}>{items}</ul>, end};
}

function fence(line: string) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  if (!match || (match[1]!.startsWith('`') && match[2]!.includes('`'))) return null;
  return match[1]!;
}

function heading(line: string): string | undefined {
  return /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*$/u.exec(line)?.[1]?.replace(/[ \t]+#+$/u, '');
}

export default memo(function MioMarkdown({children}: {children: string}) {
  const lines = children.split(/\r\n?|\n/u), output: ReactElement[] = [];
  let index = 0;
  while (index < lines.length) {
    const start = index, line = lines[index++]!;
    if (!line.trim()) continue;
    const delimiter = index < lines.length && fence(line);
    if (delimiter) {
      const codeStart = index;
      while (index < lines.length) {
        const closing = lines[index]!.trim();
        if (closing.length >= delimiter.length && closing === delimiter[0]!.repeat(closing.length)) break;
        index++;
      }
      output.push(<pre key={start} tabIndex={0}><code>{lines.slice(codeStart, index).join('\n')}</code></pre>);
      if (index < lines.length) index++;
      continue;
    }
    const title = heading(line);
    if (title !== undefined) {
      output.push(<p key={start}><strong>{inline(title)}</strong></p>);
      continue;
    }
    const item = listItem(line);
    if (item) {
      const group = list(lines, start, item);
      output.push(group.node);
      index = group.end;
      continue;
    }
    const paragraph = [<React.Fragment key={start}>{inline(line)}</React.Fragment>];
    while (index < lines.length) {
      const next = lines[index]!;
      if (!next.trim() || (index + 1 < lines.length && fence(next)) || heading(next) !== undefined || listItem(next)) break;
      paragraph.push(<React.Fragment key={index}>{'\n'}{inline(next)}</React.Fragment>);
      index++;
    }
    output.push(<p key={start}>{paragraph}</p>);
  }
  return <>{output}</>;
});
