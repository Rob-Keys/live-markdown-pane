import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { HeadingChoice } from '../protocol';
import { unescapeMarkdown } from './references';

export type DocumentHeading = HeadingChoice & { from: number };

export function slugHeading(value: string): string {
  return value.toLowerCase().replace(/[*_`~]/g, '').trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
}

/** Build on demand, never on the typing path. Do not offer a partial outline. */
export function documentHeadings(state: EditorState): DocumentHeading[] | undefined {
  const tree = ensureSyntaxTree(state, state.doc.length, 250);
  if (!tree) return undefined;
  const headings: DocumentHeading[] = [];
  const used = new Set<string>();
  tree.iterate({ enter: node => {
    const match = /^(?:ATXHeading|SetextHeading)([1-6])$/.exec(node.name);
    if (!match) return;
    let label = '';
    const append = (from: number, to: number) => {
      if (from < to) label += state.sliceDoc(from, to);
    };
    let position = node.from;
    // Keep the displayed heading text while dropping syntax and destinations.
    tree.iterate({ from: node.from, to: node.to, enter: child => {
      if (child.name === 'URL' && !['Link', 'Image'].includes(child.node.parent?.name ?? '')) return;
      if (/^(HeaderMark|EmphasisMark|CodeMark|StrikethroughMark|LinkMark|URL|LinkLabel|LinkTitle|LinkDestination)$/.test(child.name)) {
        append(position, child.from);
        position = child.to;
        return false;
      }
    }});
    append(position, node.to);
    label = unescapeMarkdown(label).trim().replace(/\s+/g, ' ');
    const base = slugHeading(label);
    let slug = base;
    for (let suffix = 1; used.has(slug); suffix++) slug = `${base}-${suffix}`;
    used.add(slug);
    headings.push({ label, slug, level: Number(match[1]), from: node.from });
    return false;
  }});
  return headings;
}
