import { ChangeSet, EditorState, Text } from '@codemirror/state';
import { DocInput, syntaxTree } from '@codemirror/language';
import { ChangedRange, Tree, TreeFragment } from '@lezer/common';
import { GFM, parser } from '@lezer/markdown';

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
  return referenceDefinitions(state).get(normalizeReferenceLabel(label));
}

export function normalizeLinkDestination(value: string): string {
  const target = value.startsWith('<') && value.endsWith('>') ? value.slice(1, -1) : value;
  return unescapeMarkdown(target);
}

/** Resolve inline and reference links from a range that starts at the `[` boundary. */
export function linkTarget(state: EditorState, from: number, to: number): string | undefined {
  const source = state.sliceDoc(from, to);
  let node = syntaxTree(state).resolveInner(Math.min(from + 1, state.doc.length));
  while (node.name !== 'Link' && node.parent) node = node.parent;
  if (node.name === 'Link') {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === 'URL') return normalizeLinkDestination(state.sliceDoc(child.from, child.to));
    }
  }

  const reference = /^\[([\s\S]*?)\](?:\[([^\]]*)\])?$/.exec(source);
  if (!reference) return undefined;
  const label = reference[2] || reference[1];
  return label ? referenceTarget(state, label) : undefined;
}

/** Resolve the destination under a pointer, whether the link is in a paragraph or heading. */
export function linkTargetAt(state: EditorState, position: number): string | undefined {
  let node = syntaxTree(state).resolveInner(Math.min(Math.max(position, 0), state.doc.length));
  while (!['Link', 'Autolink', 'URL'].includes(node.name) && node.parent) node = node.parent;
  if (node.name === 'Link') return linkTarget(state, node.from, node.to);

  let url = node;
  if (node.name === 'Autolink') {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === 'URL') { url = child; break; }
    }
  }
  if (url.name !== 'URL') return undefined;
  let context = url.parent;
  while (context && !['Image', 'Link', 'Autolink'].includes(context.name) && context.parent) context = context.parent;
  if (context?.name === 'Image') return undefined;
  if (context?.name === 'Link') return linkTarget(state, context.from, context.to);
  const target = state.sliceDoc(url.from, url.to);
  return /^https?:\/\//i.test(target) ? target : undefined;
}

export function referenceDefinitions(state: EditorState): Map<string, string> {
  return referenceIndex(state.doc).targets;
}

// Reference definitions depend on block structure. Avoid repeating inline
// formatting work, especially when typing into a long unbroken paragraph.
const referenceParser = parser.configure([GFM, {
  remove: ['Escape', 'Entity', 'InlineCode', 'HTMLTag', 'Emphasis', 'HardBreak', 'Link', 'Image', 'LinkEnd', 'Strikethrough', 'Autolink'],
}]);
type ReferenceIndex = { tree: Tree; targets: Map<string, string> };
const referenceIndexes = new WeakMap<Text, ReferenceIndex>();

/** Parse the entire document so offscreen definitions have their block context. */
function referenceIndex(doc: Text, fragments: readonly TreeFragment[] = []): ReferenceIndex {
  const cached = referenceIndexes.get(doc);
  if (cached) return cached;
  const tree = referenceParser.parse(new DocInput(doc), fragments);
  const targets = new Map<string, string>();
  tree.iterate({ enter: node => {
    if (node.name === 'LinkReference') {
      const label = node.node.getChild('LinkLabel');
      const url = node.node.getChild('URL');
      if (label && url) {
        const key = normalizeReferenceLabel(doc.sliceString(label.from + 1, label.to - 1));
        if (!targets.has(key)) targets.set(key, normalizeLinkDestination(doc.sliceString(url.from, url.to)));
      }
    }
    // Definitions can nest in lists and quotes, but never in code, HTML, or
    // inline content. Skip those subtrees when collecting the index.
    return /^(Document|Blockquote|BulletList|OrderedList|ListItem)$/.test(node.name) ? undefined : false;
  }});
  const index = { tree, targets };
  referenceIndexes.set(doc, index);
  return index;
}

/** Incrementally parse edits, including changes to distant fences and HTML blocks. */
export function changesMayAffectReferenceDefinitions(before: Text, after: Text, changes: ChangeSet): boolean {
  const previous = referenceIndex(before);
  const ranges: ChangedRange[] = [];
  changes.iterChangedRanges((fromA, toA, fromB, toB) => ranges.push({ fromA, toA, fromB, toB }));
  const fragments = TreeFragment.applyChanges(TreeFragment.addTree(previous.tree), ranges);
  const next = referenceIndex(after, fragments);
  return previous.targets.size !== next.targets.size
    || [...previous.targets].some(([label, target]) => next.targets.get(label) !== target);
}
