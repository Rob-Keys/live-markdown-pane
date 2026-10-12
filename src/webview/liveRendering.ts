import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { EditorState, Range, StateEffect, StateField, Transaction } from '@codemirror/state';
import { SyntaxNode } from '@lezer/common';
import { EditorSettings, isPermittedImageSource } from '../protocol';
import { ImageWidget, ListMarker, TableAlignment, TableTextRun, TableWidget, TaskCheckbox, TextWidget } from './widgets';
import { changesMayAffectReferenceDefinitions, normalizeReferenceLabel, referenceDefinitions, unescapeMarkdown } from './references';
import { shouldReduceRendering } from './documentMetrics';
import { effectiveSyntaxVisibility, shouldRenderTableWidget } from './renderingVisibility';

const empty = Decoration.none;
const tableViewportMargin = 2000;
const maxTableWidgetCharacters = 16_000;
const maxTableWidgetLines = 200;
const maxVisibleImageWidgets = 16;
export type TableViewportRange = { from: number; to: number };

const setTableRanges = StateEffect.define<TableViewportRange[]>({
  map: (ranges, changes) => ranges.map(range => ({ from: changes.mapPos(range.from, -1), to: changes.mapPos(range.to, 1) })),
});

const tableRanges = StateField.define<TableViewportRange[]>({
  create: state => normalizeTableRanges([{ from: state.selection.main.head - tableViewportMargin, to: state.selection.main.head + tableViewportMargin }], state.doc.length),
  update: (ranges, transaction) => {
    let next = transaction.docChanged
      ? ranges.map(range => ({ from: transaction.changes.mapPos(range.from, -1), to: transaction.changes.mapPos(range.to, 1) }))
      : ranges;
    for (const effect of transaction.effects) if (effect.is(setTableRanges)) next = effect.value;
    return normalizeTableRanges(next, transaction.newDoc.length);
  },
});

function normalizeTableRanges(ranges: readonly TableViewportRange[], documentLength: number): TableViewportRange[] {
  const sorted = ranges.map(range => ({
    from: Math.max(0, Math.min(documentLength, range.from)),
    to: Math.max(0, Math.min(documentLength, range.to)),
  })).filter(range => range.from <= range.to).sort((a, b) => a.from - b.from);
  const merged: TableViewportRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && previous.to >= range.from) previous.to = Math.max(previous.to, range.to);
    else merged.push(range);
  }
  return merged;
}

/** Find only table syntax nodes intersecting the current visible ranges and margin. */
export function visibleTableNodes(state: EditorState, ranges: readonly TableViewportRange[]): SyntaxNode[] {
  const tree = syntaxTree(state);
  const tables = new Map<string, SyntaxNode>();
  for (const range of normalizeTableRanges(ranges, state.doc.length)) {
    tree.iterate({ from: range.from, to: range.to, enter: node => {
      if (node.name === 'Table') {
        let table = tree.resolveInner(Math.min(node.to, node.from + 1));
        while (table.name !== 'Table' && table.parent) table = table.parent;
        if (table.name === 'Table') tables.set(`${table.from}:${table.to}`, table);
        return false;
      }
    }});
  }
  return [...tables.values()].sort((a, b) => a.from - b.from);
}

export function isTableWidgetEligible(node: Pick<SyntaxNode, 'from' | 'to'>, lineCount: number): boolean {
  return node.to - node.from <= maxTableWidgetCharacters && lineCount <= maxTableWidgetLines;
}

/** A table requires pipe syntax; include adjacent lines because a newline edit can join or split rows. */
export function changesMayAffectTableSyntax(transaction: Transaction): boolean {
  const rangeContainsPipe = (state: EditorState, from: number, to: number): boolean => {
    const startLine = state.doc.lineAt(Math.min(from, state.doc.length)).number;
    const endLine = state.doc.lineAt(Math.min(to, state.doc.length)).number;
    for (let number = Math.max(1, startLine - 1); number <= Math.min(state.doc.lines, endLine + 1); number++) {
      if (state.doc.line(number).text.includes('|')) return true;
    }
    return false;
  };

  let mayAffect = false;
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (rangeContainsPipe(transaction.startState, fromA, toA) || rangeContainsPipe(transaction.state, fromB, toB)) mayAffect = true;
  });
  return mayAffect;
}

export function liveRendering(settings: () => EditorSettings, sourceMode: () => boolean, requestResource: (src: string, signal?: AbortSignal) => Promise<string | undefined>, enterTable: (position: number) => void, onFailure: (error?: unknown) => void = () => {}, editable: () => boolean = () => true, preserveViewport: (update: () => void) => void = update => update(), composing: () => boolean = () => false, followLink: (target: string) => void = () => {}) {
  const failedLayers = new Set<string>();
  const reportFailure = (layer: string, error?: unknown) => {
    if (error !== undefined) {
      const shouldNotify = failedLayers.size === 0;
      failedLayers.add(layer);
      if (shouldNotify) onFailure(error);
    } else if (failedLayers.delete(layer) && failedLayers.size === 0) onFailure();
  };
  let tableFailed = false;
  let lastTableSelection = '';
  let tableReferenceDoc: EditorState['doc'] | undefined;
  let tableReferenceTargets: Map<string, string> | undefined;
  const referenceTargetsForTables = (state: EditorState): Map<string, string> => {
    if (tableReferenceDoc !== state.doc || !tableReferenceTargets) {
      tableReferenceDoc = state.doc;
      tableReferenceTargets = referenceDefinitions(state);
    }
    return tableReferenceTargets;
  };
  const tableDecorations = StateField.define<DecorationSet>({
    create: state => {
      lastTableSelection = tableSelectionKey(state);
      return safeBuildTableDecorations(state);
    },
    update: (decorations, transaction) => {
      try {
        if (composing()) {
          if (transaction.selection) lastTableSelection = tableSelectionKey(transaction.state);
          return transaction.docChanged ? decorations.map(transaction.changes) : decorations;
        }
        const rangesChanged = transaction.effects.some(effect => effect.is(setTableRanges));
        if (transaction.docChanged || rangesChanged) {
          if (transaction.docChanged && !rangesChanged && decorations === empty && !changesMayAffectTableSyntax(transaction)) return empty;
          lastTableSelection = tableSelectionKey(transaction.state);
          return safeBuildTableDecorations(transaction.state);
        }
        if (transaction.selection) {
          const selectionKey = tableSelectionKey(transaction.state);
          if (selectionKey !== lastTableSelection) {
            lastTableSelection = selectionKey;
            return safeBuildTableDecorations(transaction.state);
          }
        }
        return decorations;
      } catch (error) {
        if (!tableFailed) {
          tableFailed = true;
          console.error('Live Markdown table rendering failed');
          reportFailure('tables', error);
        }
        return empty;
      }
    },
    provide: field => EditorView.decorations.from(field),
  });

  function safeBuildTableDecorations(state: EditorState): DecorationSet {
    try {
      const result = buildTableDecorations(state);
      if (tableFailed) {
        tableFailed = false;
        reportFailure('tables');
      }
      return result;
    } catch (error) {
      if (!tableFailed) {
        tableFailed = true;
        console.error('Live Markdown table rendering failed');
        reportFailure('tables', error);
      }
      return empty;
    }
  }

  function buildTableDecorations(state: EditorState): DecorationSet {
    if (document.hidden || !settings().renderTables || sourceMode() || shouldReduceRendering(state)) return empty;
    const values: Range<Decoration>[] = [];
    const active = state.selection.main;
    const currentSettings = settings();
    let totalSize = 0;
    let tableCount = 0;
    const ranges = state.field(tableRanges);
    for (const node of visibleTableNodes(state, ranges)) {
      const inActive = active.head >= node.from && active.head <= node.to;
      const selected = state.selection.ranges.some(range => range.empty
        ? range.head >= node.from && range.head <= node.to
        : range.from < node.to && range.to > node.from);
      if (!shouldRenderTableWidget(sourceMode(), currentSettings.screenReaderMode, currentSettings.syntaxVisibility, inActive, selected)) continue;
      const raw = state.doc.sliceString(node.from, node.to);
      const lines = raw.split('\n');
      totalSize += raw.length;
      tableCount++;
      if (!isTableWidgetEligible(node, lines.length) || totalSize > 250000 || tableCount > 100) continue;
      // At a node's start position Lezer may resolve to its preceding sibling
      // or parent. Resolve one character inside the table so the replacement
      // cannot accidentally span the containing document.
      let table = tableNodeAt(state, node.from);
      if (!table) continue;
      const starts: number[] = [];
    const rows: TableTextRun[][][] = [];
      let alignments: TableAlignment[] = [];
      for (let row = table.firstChild; row; row = row.nextSibling) {
        if (row.name === 'TableDelimiter') {
          const separator = state.sliceDoc(row.from, row.to).trim().replace(/^\|/, '').replace(/\|$/, '');
          const columns = separator.split('|').map(cell => cell.trim());
          if (columns.length > 1 && columns.every(cell => /^:?-+:?$/.test(cell))) {
            alignments = columns.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : undefined);
          }
          continue;
        }
        if (row.name !== 'TableHeader' && row.name !== 'TableRow') continue;
        const cells: TableTextRun[][] = [];
        for (let cell = row.firstChild; cell; cell = cell.nextSibling) {
          if (cell.name === 'TableCell') cells.push(tableCellRuns(state, cell, referenceTargetsForTables(state)));
        }
        rows.push(cells);
        starts.push(state.doc.lineAt(row.from).from);
      }
      values.push(Decoration.replace({ widget: new TableWidget(table.from, table.to, rows, starts, alignments, enterTable, followLink), block: true }).range(table.from, table.to));
    }
    return Decoration.set(values, true);
  }

  const tableViewportPlugin = ViewPlugin.fromClass(class {
    private frame: number | undefined;
    private rangeSignature = '';
    private destroyed = false;

    constructor(readonly view: EditorView) { this.schedule(view); }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || update.geometryChanged) this.schedule(update.view);
    }

    destroy(): void {
      this.destroyed = true;
      if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    }

    private schedule(view: EditorView): void {
      if (this.frame !== undefined) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = undefined;
        if (this.destroyed || document.hidden) return;
        const ranges = normalizeTableRanges(view.visibleRanges.map(range => ({
          from: range.from - tableViewportMargin,
          to: range.to + tableViewportMargin,
        })), view.state.doc.length);
        const signature = ranges.map(range => `${range.from}:${range.to}`).join(',');
        if (signature === this.rangeSignature) return;
        this.rangeSignature = signature;
        view.dispatch({ effects: setTableRanges.of(ranges) });
      });
    }
  });

  const renderingPlugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet = empty;
    private failed = false;
    private referenceDoc?: EditorState['doc'];
    private referenceDefinitions?: Map<string, string>;
    constructor(readonly view: EditorView) { this.decorations = this.build(view); }
    update(update: ViewUpdate): void {
      if (update.view.composing || composing()) {
        if (update.docChanged) this.decorations = this.decorations.map(update.changes);
        return;
      }
      if (update.docChanged && this.referenceDoc === update.startState.doc && this.referenceDefinitions) {
        if (changesMayAffectReferenceDefinitions(update.startState.doc, update.state.doc, update.changes)) {
          this.referenceDoc = undefined;
          this.referenceDefinitions = undefined;
        } else {
          this.referenceDoc = update.state.doc;
        }
      }
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged) this.decorations = this.build(update.view);
    }
    build(view: EditorView): DecorationSet {
      try {
        const result = this.buildDecorations(view);
        if (this.failed) {
          this.failed = false;
          reportFailure('inline', undefined);
        }
        return result;
      } catch (error) {
        if (!this.failed) {
          this.failed = true;
          console.error('Live Markdown rendering failed');
          reportFailure('inline', error);
        }
        return empty;
      }
    }
    private buildDecorations(view: EditorView): DecorationSet {
      if (document.hidden) return empty;
      const values: Range<Decoration>[] = [];
      const tree = syntaxTree(view.state);
      const references = (): Map<string, string> => {
        if (this.referenceDoc === view.state.doc && this.referenceDefinitions) return this.referenceDefinitions;
        const definitions = referenceDefinitions(view.state);
        this.referenceDoc = view.state.doc;
        this.referenceDefinitions = definitions;
        return definitions;
      };
      const active = view.state.selection.main;
      const mode = effectiveSyntaxVisibility(sourceMode(), settings().screenReaderMode, settings().syntaxVisibility);
      const simplifyWidgets = shouldReduceRendering(view.state);
      let visibleImageWidgets = 0;
      const ranges = view.visibleRanges.map(range => ({ from: Math.max(0, range.from - 2000), to: Math.min(view.state.doc.length, range.to + 2000) })).sort((a, b) => a.from - b.from);
      for (let index = ranges.length - 1; index > 0; index--) {
        if (ranges[index - 1].to >= ranges[index].from) {
          ranges[index - 1].to = Math.max(ranges[index - 1].to, ranges[index].to);
          ranges.splice(index, 1);
        }
      }
      if (!ranges.length) return empty;
      const blocks: { from: number; to: number; name: string }[] = [];
      for (const range of ranges) tree.iterate({ from: range.from, to: range.to, enter: node => {
        if (/^(ATXHeading[1-6]|SetextHeading[12]|Paragraph|FencedCode|CodeBlock|Blockquote|BulletList|OrderedList|ListItem|Table)$/.test(node.name)) blocks.push({ from: node.from, to: node.to, name: node.name });
      }});
      // Restrict cursor-containment checks to blocks which contain the cursor.
      // Scanning every visible block for every syntax node makes dense documents
      // pay O(nodes × blocks) on ordinary edits.
      const activeBlocks = blocks.filter(block => active.head >= block.from && active.head <= block.to
        && (mode === 'activeBlock' || block.name === 'FencedCode' || block.name === 'CodeBlock'));
      const activeTables = blocks.filter(block => block.name === 'Table' && active.head >= block.from && active.head <= block.to);
      const lineAt = (position: number) => view.state.doc.lineAt(Math.min(position, view.state.doc.length));
      const addVisibleLines = (className: string, first: number, last: number, attributes?: Record<string, string>) => {
        for (let number = first; number <= last; number++) {
          const line = view.state.doc.line(number);
          if (ranges.some(range => range.from <= line.to && range.to >= line.from)) values.push(Decoration.line({ class: className, attributes }).range(line.from));
        }
      };
      const selected = (from: number, to: number) => view.state.selection.ranges.some(range => range.empty ? range.head >= from && range.head <= to : range.from < to && range.to > from);
      const visited = new Set<string>();
      const decorate = (node: SyntaxNode) => {
        const id = `${node.name}:${node.from}:${node.to}`;
        if (visited.has(id)) return;
        visited.add(id);
        const name = node.name;
        const isLinkTarget = name === 'URL' || name === 'LinkLabel';
        let linkContext = isLinkTarget ? tree.resolveInner(node.from) : undefined;
        while (linkContext && !['Link', 'Image', 'Autolink'].includes(linkContext.name) && linkContext.parent) linkContext = linkContext.parent;
        const fromLine = lineAt(node.from);
        const toLine = lineAt(node.to);
        const inActive = active.head >= fromLine.from && active.head <= toLine.to;
        const inActiveTable = name === 'TableDelimiter' && activeTables.some(block => node.from >= block.from && node.to <= block.to);
        const inBlock = activeBlocks.some(block => node.from >= block.from && node.to <= block.to);
        const reveal = mode === 'always' || inActive || inActiveTable || inBlock || selected(node.from, node.to);
        const hideLinkTarget = isLinkTarget && linkContext?.name === 'Link' && !reveal;
        const heading = /^ATXHeading([1-6])$/.exec(name);
        if (name === 'Entity') {
          const source = view.state.sliceDoc(node.from, node.to);
          const decoded = unescapeMarkdown(source);
          if (!reveal && decoded !== source) values.push(Decoration.replace({ widget: new TextWidget(decoded) }).range(node.from, node.to));
        } else if (heading) {
          addVisibleLines(`lm-heading lm-heading-${heading[1]}`, fromLine.number, toLine.number, { role: 'heading', 'aria-level': heading[1] });
        } else if (name === 'SetextHeading1' || name === 'SetextHeading2') {
          const level = name.endsWith('1') ? '1' : '2';
          values.push(Decoration.line({ class: `lm-heading lm-heading-${level}`, attributes: { role: 'heading', 'aria-level': level } }).range(fromLine.from));
        } else if (name === 'StrongEmphasis') {
          values.push(Decoration.mark({ class: 'lm-strong' }).range(node.from, node.to));
        } else if (name === 'Emphasis') {
          values.push(Decoration.mark({ class: 'lm-emphasis' }).range(node.from, node.to));
        } else if (name === 'InlineCode') {
          values.push(Decoration.mark({ class: 'lm-inline-code' }).range(node.from, node.to));
        } else if (name === 'Strikethrough') {
          values.push(Decoration.mark({ class: 'lm-strike' }).range(node.from, node.to));
        } else if (name === 'Link') {
          const label = linkLabelRange(view.state, node);
          if (label && label.from < label.to) values.push(Decoration.mark({ class: 'lm-link' }).range(label.from, label.to));
        } else if (name === 'Autolink') {
          const label = linkLabelRange(view.state, node);
          if (label && label.from < label.to) values.push(Decoration.mark({ class: 'lm-link' }).range(label.from, label.to));
        } else if (name === 'URL' && !['Link', 'Image', 'Autolink'].includes(linkContext?.name ?? '')) {
          values.push(Decoration.mark({ class: 'lm-link' }).range(node.from, node.to));
        } else if (name === 'Image') {
          const imageNode = tree.resolveInner(Math.min(node.to, node.from + 2));
          const image = imageNode.name === 'Image' ? readImage(view.state, imageNode) : undefined;
          const source = image?.source ?? (image?.reference !== undefined ? references().get(normalizeReferenceLabel(image.reference || image.alt)) : undefined);
          const remoteAllowed = isPermittedImageSource(source, settings().isTrusted, settings().allowRemoteImages);
          if (settings().renderImages && !simplifyWidgets && !reveal && image && visibleImageWidgets < maxVisibleImageWidgets) {
            visibleImageWidgets++;
            values.push(Decoration.replace({ widget: new ImageWidget(node.from, node.to, image.alt, source ?? '', remoteAllowed, requestResource, position => { view.dispatch({ selection: { anchor: position } }); view.focus(); }, preserveViewport) }).range(node.from, node.to));
          } else {
            values.push(Decoration.mark({ class: 'lm-image-source' }).range(node.from, node.to));
          }
          return false;
        } else if (name === 'Table' && settings().renderTables && !reveal
          && (node.to - node.from > maxTableWidgetCharacters || view.state.doc.lineAt(node.to).number - view.state.doc.lineAt(node.from).number + 1 > maxTableWidgetLines)) {
          // A single large table can be more expensive than the rest of a 100 KiB
          // document. Keep its source visible instead of rebuilding a huge widget
          // after every nearby edit.
          return false;
        } else if (name === 'Table' && settings().renderTables && !reveal && !simplifyWidgets) {
          // Multi-line replacements are supplied by the state field above. View
          // plugins may not replace ranges containing line breaks.
          return false;
        } else if (name === 'FencedCode' || name === 'CodeBlock') {
          addVisibleLines('lm-code-line', fromLine.number, toLine.number);
        } else if (name === 'Blockquote') {
          addVisibleLines('lm-blockquote', fromLine.number, toLine.number);
        } else if (name === 'ListMark' && !reveal) {
          const line = lineAt(node.from);
          const afterMarker = view.state.doc.sliceString(node.to, line.to);
          const task = /^\s+\[[ xX]\]/.test(afterMarker);
          const marker = view.state.doc.sliceString(node.from, node.to);
          const rendered = task ? undefined : /^\d/.test(marker) ? `${marker} ` : '•';
          values.push(Decoration.replace(rendered ? { widget: new ListMarker(rendered) } : {}).range(node.from, node.to));
        } else if (hideLinkTarget || /^(HeaderMark|EmphasisMark|CodeMark|StrikethroughMark|QuoteMark|LinkMark|LinkTitle|LinkDestination)$/.test(name) && !reveal || name === 'TableDelimiter' && settings().renderTables && !simplifyWidgets && !reveal) {
          values.push(Decoration.replace({}).range(node.from, node.to));
        } else if (/^(TaskMarker|Task)$/.test(name) && !reveal) {
          const source = view.state.doc.sliceString(node.from, node.to);
          if (/^\[[ xX]\]$/.test(source)) {
            const line = lineAt(node.from);
            const description = /^\s*(?:[-+*]|\d+[.)])\s+\[[ xX]\]\s+(.*)$/.exec(line.text)?.[1].trim() ?? '';
            values.push(Decoration.replace({ widget: new TaskCheckbox(node.from, node.to, source.toLowerCase() === '[x]', description, editable(), (from, to, insert) => {
              view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
              view.focus();
            }, position => enterTable(position)) }).range(node.from, node.to));
          }
        }
      };
      for (const range of ranges) tree.iterate({ from: range.from, to: range.to, enter: decorate });
      return Decoration.set(values, true);
    }
  }, { decorations: value => value.decorations });
  return [tableRanges, tableDecorations, tableViewportPlugin, renderingPlugin];
}

export function tableCellRuns(state: EditorState, cell: SyntaxNode, referenceTargets = referenceDefinitions(state)): TableTextRun[] {
  return collectTableRuns(state, cell, cell.from, cell.to, [], referenceTargets);
}

/** Resolve the Table node rather than the parent selected at its start boundary. */
export function tableNodeAt(state: EditorState, from: number): SyntaxNode | undefined {
  const tree = syntaxTree(state);
  let node = tree.resolveInner(Math.min(from + 1, state.doc.length));
  while (node.name !== 'Table' && node.parent) node = node.parent;
  return node.name === 'Table' ? node : undefined;
}

function collectTableRuns(state: EditorState, parent: SyntaxNode, from: number, to: number, marks: TableTextRun['marks'], referenceTargets: Map<string, string>, linkTarget?: string): TableTextRun[] {
  const runs: TableTextRun[] = [];
  const append = (text: string, activeMarks = marks, activeLinkTarget = linkTarget) => {
    if (text) runs.push({ text, marks: [...activeMarks], ...(activeLinkTarget ? { linkTarget: activeLinkTarget } : {}) });
  };
  const structural = new Set(['EmphasisMark', 'CodeMark', 'StrikethroughMark', 'LinkMark']);
  let position = from;
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.to <= from || child.from >= to) continue;
    const start = Math.max(from, child.from);
    const end = Math.min(to, child.to);
    if (start > position) append(state.sliceDoc(position, start));
    if (structural.has(child.name)) {
      position = Math.max(position, end);
      continue;
    }
    if (child.name === 'Escape') {
      append(unescapeMarkdown(state.sliceDoc(start, end)));
    } else if (child.name === 'Entity') {
      append(unescapeMarkdown(state.sliceDoc(start, end)));
    } else if (child.name === 'StrongEmphasis' || child.name === 'Emphasis' || child.name === 'Strikethrough') {
      const delimiters = child.name === 'Strikethrough' ? ['StrikethroughMark'] : ['EmphasisMark'];
      const markers: SyntaxNode[] = [];
      for (let part = child.firstChild; part; part = part.nextSibling) if (delimiters.includes(part.name)) markers.push(part);
      const innerFrom = markers.length ? markers[0].to : child.from;
      const innerTo = markers.length ? markers[markers.length - 1].from : child.to;
      const mark: TableTextRun['marks'][number] = child.name === 'StrongEmphasis' ? 'strong' : child.name === 'Emphasis' ? 'emphasis' : 'strike';
      runs.push(...collectTableRuns(state, child, Math.max(start, innerFrom), Math.min(end, innerTo), [...marks, mark], referenceTargets, linkTarget));
    } else if (child.name === 'InlineCode') {
      const delimiters: SyntaxNode[] = [];
      for (let part = child.firstChild; part; part = part.nextSibling) if (part.name === 'CodeMark') delimiters.push(part);
      const innerFrom = delimiters.length ? delimiters[0].to : child.from;
      const innerTo = delimiters.length ? delimiters[delimiters.length - 1].from : child.to;
      append(state.sliceDoc(Math.max(start, innerFrom), Math.min(end, innerTo)), [...marks, 'code']);
    } else if (child.name === 'Link' || child.name === 'Autolink') {
      const label = linkLabelRange(state, child);
      const target = tableLinkTarget(state, child, referenceTargets);
      if (label) runs.push(...collectTableRuns(state, child, Math.max(start, label.from), Math.min(end, label.to), [...marks, 'link'], referenceTargets, target));
    } else if (child.name === 'Image') {
      const image = readImage(state, child);
      if (image) append(image.alt || image.source || 'Image', marks);
    } else if (child.name === 'URL') {
      const target = unescapeMarkdown(state.sliceDoc(start, end));
      append(state.sliceDoc(start, end), marks.includes('link') ? marks : [...marks, 'link'], target);
    } else if (child.firstChild) {
      runs.push(...collectTableRuns(state, child, start, end, marks, referenceTargets, linkTarget));
    } else {
      append(state.sliceDoc(start, end));
    }
    position = Math.max(position, end);
  }
  if (position < to) append(state.sliceDoc(position, to));
  return runs;
}

function tableLinkTarget(state: EditorState, link: SyntaxNode, referenceTargets: Map<string, string>): string | undefined {
  for (let child = link.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'URL') continue;
    let target = state.sliceDoc(child.from, child.to);
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    return unescapeMarkdown(target);
  }
  const reference = /^\[([\s\S]*?)\](?:\[([^\]]*)\])?$/.exec(state.sliceDoc(link.from, link.to));
  if (!reference) return undefined;
  return referenceTargets.get(normalizeReferenceLabel(reference[2] || reference[1]));
}

export function readImage(state: EditorState, image: SyntaxNode): { alt: string; source?: string; reference?: string } | undefined {
  let closingLabel: number | undefined;
  let url: string | undefined;
  let reference: string | undefined;
  for (let child = image.firstChild; child; child = child.nextSibling) {
    if (child.name === 'LinkMark' && child.from > image.from && state.sliceDoc(child.from, child.to) === ']') closingLabel = child.from;
    else if (child.name === 'URL') url = state.sliceDoc(child.from, child.to);
    else if (child.name === 'LinkLabel') reference = state.sliceDoc(child.from, child.to).slice(1, -1);
  }
  if (closingLabel === undefined) return undefined;
  const rawAlt = state.sliceDoc(image.from + 2, closingLabel);
  const alt = unescapeMarkdown(rawAlt);
  let source = url;
  if (source?.startsWith('<') && source.endsWith('>')) source = source.slice(1, -1);
  if (source) source = unescapeMarkdown(source);
  return { alt, source: source || undefined, reference };
}

function linkLabelRange(state: EditorState, link: SyntaxNode): { from: number; to: number } | undefined {
  let opening: SyntaxNode | undefined;
  for (let child = link.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'LinkMark') continue;
    const marker = state.sliceDoc(child.from, child.to);
    if (!opening && (marker === '[' || marker === '<')) opening = child;
    else if (opening && (marker === ']' || marker === '>')) return { from: opening.to, to: child.from };
  }
  return undefined;
}

/** Identifies only tables whose rendered/source state depends on this selection. */
export function tableSelectionKey(state: EditorState): string {
  const tree = syntaxTree(state);
  const tables = new Set<string>();
  for (const range of state.selection.ranges) {
    if (range.empty) {
      const position = range.head;
      // Resolve inside the table when the cursor is on a block boundary. At
      // table.to, the preceding character is still part of the table.
      const node = tableNodeAt(state, position)
        ?? (position > 1 ? tableNodeAt(state, position - 2) : undefined);
      if (node && position >= node.from && position <= node.to) {
        tables.add(`${node.from}:${node.to}`);
      }
    } else {
      tree.iterate({ from: range.from, to: range.to, enter: node => {
        if (node.name === 'Table' && range.from < node.to && range.to > node.from) tables.add(`${node.from}:${node.to}`);
      }});
    }
  }
  return [...tables].sort().join(',');
}

export function markdownLanguageSupport(state: EditorState): void { void state; }
