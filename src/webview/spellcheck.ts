import { Extension } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';

/** Browser dictionaries check prose; code and link destinations remain literal. */
export function proseSpellcheck(enabled: boolean): Extension {
  return [
    EditorView.contentAttributes.of({ spellcheck: String(enabled) }),
    enabled ? ViewPlugin.fromClass(class {
      decorations: DecorationSet;
      constructor(view: EditorView) { this.decorations = this.build(view); }
      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) this.decorations = this.build(update.view);
      }
      build(view: EditorView): DecorationSet {
        const ranges: ReturnType<Decoration['range']>[] = [];
        for (const range of view.visibleRanges) syntaxTree(view.state).iterate({ from: range.from, to: range.to, enter: node => {
          if (/^(FencedCode|CodeBlock|InlineCode|URL|Autolink|LinkDestination|LinkTitle|LinkLabel)$/.test(node.name)) {
            if (node.to > node.from) ranges.push(Decoration.mark({ attributes: { spellcheck: 'false' } }).range(node.from, node.to));
            return false;
          }
        }});
        return Decoration.set(ranges, true);
      }
    }, { decorations: plugin => plugin.decorations }) : [],
  ];
}
