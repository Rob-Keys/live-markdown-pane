import { EditorState } from '@codemirror/state';
import { SyntaxNode } from '@lezer/common';

/** Copy code text without fences or containing list/quote markers. */
export function fencedCodeText(state: EditorState, node: SyntaxNode): string {
  const first = state.doc.lineAt(node.from);
  const closing = node.lastChild?.name === 'CodeMark' && node.lastChild.from > first.to ? node.lastChild : undefined;
  const end = closing ? state.doc.lineAt(closing.from).from : node.to;
  if (first.to >= end) return '';
  const prefix = state.sliceDoc(first.from, node.from);
  const indent = prefix.replace(/[^\s>]/g, ' ');
  let content = state.sliceDoc(first.to + 1, end);
  // Container prefixes are source syntax, not part of the copied code.
  if (indent) content = content.split('\n').map(line => {
    let offset = 0;
    for (const char of indent) {
      if (offset >= line.length) break;
      if (char === '>' ? line[offset] === '>' : /[ \t]/.test(line[offset])) offset++;
      else break;
    }
    return line.slice(offset);
  }).join('\n');
  return content;
}
