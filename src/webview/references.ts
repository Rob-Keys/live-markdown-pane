import { EditorState, Text } from '@codemirror/state';
import { ChangeSet } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

export function normalizeReferenceLabel(value: string): string {
  return unescapeMarkdown(value).trim().replace(/\s+/g, ' ').toLowerCase();
}

let entityDecoder: HTMLTextAreaElement | undefined;
export function unescapeMarkdown(value: string): string {
  const escaped = value.replace(/\\([\\`*_{}\[\]()#+\-.!<>|])/g, '$1');
  return escaped.replace(/&(?:#[0-9]+|#x[\da-f]+|[a-z][\da-z]+);/gi, entity => {
    entityDecoder ??= document.createElement('textarea');
    entityDecoder.innerHTML = entity;
    return entityDecoder.value || entity;
  });
}

export function referenceTarget(state: EditorState, label: string): string | undefined {
  const wanted = normalizeReferenceLabel(label);
  for (let number = 1; number <= state.doc.lines; number++) {
    const definition = parseReferenceDefinition(state.doc.line(number).text);
    if (definition && definition.label === wanted) return definition.target;
  }
  return undefined;
}

/** Resolve inline and reference links from a range that starts at the `[` boundary. */
export function linkTarget(state: EditorState, from: number, to: number): string | undefined {
  const source = state.sliceDoc(from, to);
  let node = syntaxTree(state).resolveInner(Math.min(from + 1, state.doc.length));
  while (node.name !== 'Link' && node.parent) node = node.parent;
  if (node.name === 'Link') {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === 'URL') return state.sliceDoc(child.from, child.to);
    }
  }

  const reference = /^\[([\s\S]*?)\](?:\[([^\]]*)\])?$/.exec(source);
  if (!reference) return undefined;
  const label = normalizeReferenceLabel(reference[2] || reference[1]);
  return label ? referenceTarget(state, label) : undefined;
}

export function referenceDefinitions(state: EditorState): Map<string, string> {
  const definitions = new Map<string, string>();
  for (let number = 1; number <= state.doc.lines; number++) {
    const definition = parseReferenceDefinition(state.doc.line(number).text);
    if (definition && !definitions.has(definition.label)) definitions.set(definition.label, definition.target);
  }
  return definitions;
}

/** Reuse the index after edits that cannot affect a reference definition. */
export function changesMayAffectReferenceDefinitions(before: Text, after: Text, changes: ChangeSet): boolean {
  let affected = false;
  const containsDefinition = (doc: Text, from: number, to: number): boolean => {
    const first = Math.max(1, doc.lineAt(Math.max(0, from)).number - 1);
    const last = Math.min(doc.lines, doc.lineAt(Math.min(doc.length, to)).number + 1);
    for (let number = first; number <= last; number++) {
      if (parseReferenceDefinition(doc.line(number).text)) return true;
    }
    return false;
  };
  changes.iterChangedRanges((from, to, newFrom, newTo) => {
    if (!affected && (containsDefinition(before, from, to) || containsDefinition(after, newFrom, newTo))) affected = true;
  });
  return affected;
}

function parseReferenceDefinition(line: string): { label: string; target: string } | undefined {
  const match = /^\s{0,3}(?:>\s*)*(?:(?:[-+*]|\d+[.)])\s+)?\[((?:\\.|[^\]])+)\]:[ \t]*(?:<([^>]+)>|(\S+))/.exec(line);
  const target = match?.[2] ?? match?.[3];
  if (!match || !target) return undefined;
  return { label: normalizeReferenceLabel(match[1]), target: unescapeMarkdown(target) };
}
