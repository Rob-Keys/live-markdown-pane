import { EditorState } from '@codemirror/state';

export type MarkdownInputEdit = { from: number; to: number; insert: string; cursor: number };

/** Return the source edit for Enter when the cursor is inside a list or quote. */
export function markdownEnterEdit(state: EditorState): MarkdownInputEdit | undefined {
  const selection = state.selection.main;
  if (!selection.empty) return undefined;
  const line = state.doc.lineAt(selection.head);
  const quote = /^(\s*(?:>\s?)+)(.*)$/.exec(line.text);
  if (quote) {
    const prefix = quote[1];
    const nestedItem = /^(\s*)([-+*]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(quote[2]);
    if (nestedItem) {
      const [, indent, marker, checked, body] = nestedItem;
      const bodyFrom = line.from + prefix.length + quote[2].length - body.length;
      if (selection.head < bodyFrom) return undefined;
      if (selection.head === line.to && !body.trim()) {
        const exitIndent = indent.slice(0, Math.max(0, indent.length - 2));
        const insert = `${prefix.trimEnd()}\n${prefix}${exitIndent}`;
        return { from: line.from, to: line.to, insert, cursor: line.from + insert.length };
      }
      const nextMarker = /^\d/.test(marker) ? String(Number.parseInt(marker, 10) + 1) + marker.slice(-1) : marker;
      const task = checked === undefined ? '' : ' [ ]';
      const insert = `\n${prefix}${indent}${nextMarker}${task} `;
      return { from: selection.head, to: selection.head, insert, cursor: selection.head + insert.length };
    }
    const bodyFrom = line.from + prefix.length;
    if (selection.head < bodyFrom) return undefined;
    if (selection.head === line.to && !quote[2].trim()) {
      const insert = `${prefix.trimEnd()}\n`;
      return { from: line.from, to: line.to, insert, cursor: line.from + insert.length };
    }
    const insert = `\n${prefix}`;
    return { from: selection.head, to: selection.head, insert, cursor: selection.head + insert.length };
  }

  const item = /^(\s*)([-+*]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line.text);
  if (!item) return undefined;
  const [, indent, marker, checked, body] = item;
  const bodyFrom = line.from + line.text.length - body.length;
  if (selection.head < bodyFrom) return undefined;
  if (selection.head === line.to && !body.trim()) {
    const exitIndent = indent.slice(0, Math.max(0, indent.length - 2));
    const insert = `${exitIndent}\n${exitIndent}`;
    return { from: line.from, to: line.to, insert, cursor: line.from + exitIndent.length + 1 };
  }
  const nextMarker = /^\d/.test(marker) ? String(Number.parseInt(marker, 10) + 1) + marker.slice(-1) : marker;
  const task = checked === undefined ? '' : ' [ ]';
  const insert = `\n${indent}${nextMarker}${task} `;
  return { from: selection.head, to: selection.head, insert, cursor: selection.head + insert.length };
}

/** Return the source edit for Backspace at an empty list/quote prefix. */
export function markdownBackspaceEdit(state: EditorState): MarkdownInputEdit | undefined {
  const selection = state.selection.main;
  if (!selection.empty) return undefined;
  const line = state.doc.lineAt(selection.head);
  const item = /^(\s*)([-+*]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line.text);
  if (item) {
    const [, indent, , , body] = item;
    const prefix = line.text.length - body.length;
    if (selection.head === line.from + prefix) {
      const remove = indent.length ? (indent.startsWith('\t') ? 1 : Math.min(2, indent.length)) : prefix;
      return { from: line.from, to: line.from + remove, insert: '', cursor: selection.head - remove };
    }
  }
  const quote = /^(\s*(?:>\s?)+)(.*)$/.exec(line.text);
  if (quote) {
    const prefix = quote[1];
    const nestedItem = /^(\s*)([-+*]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(quote[2]);
    if (nestedItem) {
      const [, indent, , , body] = nestedItem;
      const bodyFrom = line.from + prefix.length + quote[2].length - body.length;
      if (selection.head === bodyFrom) {
        const nestedFrom = line.from + prefix.length;
        const nestedPrefixLength = quote[2].length - body.length;
        const remove = indent.length ? (indent.startsWith('\t') ? 1 : Math.min(2, indent.length)) : nestedPrefixLength;
        return { from: nestedFrom, to: nestedFrom + remove, insert: '', cursor: nestedFrom };
      }
    }
    const tail = />\s*$/.exec(prefix);
    if (tail && selection.head === line.from + prefix.length) {
      const from = line.from + prefix.length - tail[0].length;
      return { from, to: line.from + prefix.length, insert: '', cursor: selection.head - tail[0].length };
    }
  }
  return undefined;
}
