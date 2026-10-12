import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { Annotation, ChangeSet, Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { keymap, lineNumbers, EditorView } from '@codemirror/view';
import { CommandMessage, EditorSettings, HostMessage, SourceChange, StatusMessage, isCommandMessage, isHostMessage, isStatusMessage } from '../protocol';
import { liveRendering } from './liveRendering';
import { CompositionGate } from './composition';
import { documentByteSize, shouldOpenInSourceMode, shouldReduceRendering, shouldUseMarkdownLanguage, sourceChangesByteSize } from './documentMetrics';
import { linkTarget } from './references';
import { markdownBackspaceEdit, markdownEnterEdit } from './listEditing';
import { renderingWhenVisible } from './renderingVisibility';
import { changeSetToSourceChanges, changesOverlap, composeChangeSets, diffChangeSet, sourceChangesToSet } from '../rebase';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; setState(state: unknown): void; getState(): unknown };
const vscode = acquireVsCodeApi();
const sessionId = document.documentElement.dataset.sessionId ?? '';
const cspNonce = document.querySelector<HTMLMetaElement>('meta[name="live-markdown-nonce"]')?.content ?? '';
type PersistedWebviewState = { recoveryId?: string; pendingDraft?: string; anchor?: number; head?: number; scrollTop?: number; sourceMode?: boolean };
const savedWebviewState = vscode.getState() as PersistedWebviewState | undefined;
let recoveryId = savedWebviewState?.recoveryId && /^[a-f0-9-]{16,64}$/i.test(savedWebviewState.recoveryId) ? savedWebviewState.recoveryId : crypto.randomUUID();
let persistedDraft = savedWebviewState?.pendingDraft;
const editorRoot = document.querySelector<HTMLElement>('#editor')!;
const status = document.createElement('div');
status.className = 'lm-status';
status.setAttribute('role', 'status');
status.setAttribute('aria-live', 'polite');
editorRoot.append(status);
const sourceModeCompartment = new Compartment();
const markdownLanguageCompartment = new Compartment();
const lineNumberCompartment = new Compartment();
let settings: EditorSettings = {
  syntaxVisibility: 'activeLine', readingPreset: 'default', fontFamily: 'inherit', fontSize: null, lineHeight: null,
  contentWidth: null, showLineNumbers: false, renderImages: true, renderTables: true, allowRemoteImages: false,
  isTrusted: false, screenReaderMode: false, lineNumberStart: 1,
};
let sourceMode = false;
let largeDocumentSource = false;
let panelVisible = true;
let renderingVisible = true;
let sessionReady = false;
let hostVersion = 0;
let eol: '\n' | '\r\n' = '\n';
let view: EditorView | undefined;
const compositionGate = new CompositionGate();
let configurationRefreshPending = false;
type PendingEdit = { changes: SourceChange[]; bytes: number; draftSequence: number; clientRevision: number; changeSet: ChangeSet };
let inFlight: PendingEdit & { operationId: string; baseVersion: number } | undefined;
let queue: PendingEdit[] = [];
let pendingHostActions: Array<'undo' | 'redo' | 'save' | 'openInTextEditor'> = [];
let pendingSourceToggles = 0;
const maxPendingHostActions = 128;
let conflict = false;
let customStyle: HTMLStyleElement | undefined;
let appearanceStyle: HTMLStyleElement | undefined;
let resourceWaiters = new Map<string, (uri?: string, error?: string) => void>();

const excludedDefaultKeys = defaultKeymap.filter(binding => !['Mod-z', 'Mod-y', 'Ctrl-y', 'Mod-Shift-z'].includes(binding.key ?? ''));
const readOnlyCompartment = new Compartment();
let documentReadonly = false;
let ackTimer: number | undefined;
let pendingDraftSize = 0;
let draftSequence = 0;
let clientRevision = 0;

function requestResource(src: string, signal?: AbortSignal): Promise<string | undefined> {
  if (signal?.aborted) return Promise.resolve(undefined);
  const requestId = crypto.randomUUID();
  return new Promise(resolve => {
    const cancel = () => vscode.postMessage({ type: 'cancelResource', sessionId, requestId });
    const finish = (uri?: string) => {
      window.clearTimeout(timeout);
      resourceWaiters.delete(requestId);
      signal?.removeEventListener('abort', abort);
      resolve(uri);
    };
    const timeout = window.setTimeout(() => { cancel(); finish(); }, 10000);
    const abort = () => { cancel(); finish(); };
    signal?.addEventListener('abort', abort, { once: true });
    resourceWaiters.set(requestId, uri => finish(uri));
    if (signal?.aborted) { finish(); return; }
    vscode.postMessage({ type: 'resource', sessionId, requestId, src });
  });
}
const renderingFailureMessage = 'Live rendering failed. Markdown source remains editable.';
function makeRendering() {
  return liveRendering(() => settings, () => sourceMode, requestResource, position => {
    view?.dispatch({ selection: { anchor: position } });
    view?.focus();
  }, error => {
    if (error) showStatus(renderingFailureMessage);
    else if (status.textContent === renderingFailureMessage) showStatus(largeDocumentSource ? 'Large document opened in source mode. You can keep editing and saving Markdown normally.' : '');
  }, () => !documentReadonly && !conflict, preserveCaretViewportWhile, () => compositionGate.isActive(), target => {
    vscode.postMessage({ type: 'followLink', sessionId, target });
  });
}

function preserveViewportWhile(update: () => void): void {
  if (!view) return;
  const y = Math.max(40, Math.min(window.innerHeight * 0.4, window.innerHeight - 40));
  const bounds = view.dom.getBoundingClientRect();
  const position = view.posAtCoords({ x: bounds.left + bounds.width / 2, y }) ?? view.state.selection.main.head;
  const before = view.coordsAtPos(position)?.top;
  update();
  requestAnimationFrame(() => {
    if (!view || before === undefined) return;
    const after = view.coordsAtPos(Math.min(position, view.state.doc.length))?.top;
    if (after !== undefined && Number.isFinite(after)) window.scrollBy(0, after - before);
  });
}

function preserveCaretViewportWhile(update: () => void): void {
  if (!view) return update();
  const editor = view;
  const position = editor.state.selection.main.head;
  const before = editor.coordsAtPos(position)?.top;
  update();
  requestAnimationFrame(() => {
    if (view !== editor || before === undefined) return;
    const after = editor.coordsAtPos(Math.min(position, editor.state.doc.length))?.top;
    if (after !== undefined && Number.isFinite(after)) window.scrollBy(0, after - before);
  });
}

function reconfigureRenderingPreservingViewport(configurationChanged = false): void {
  if (!view || !renderingVisible) return;
  if (compositionGate.isActive()) {
    configurationRefreshPending ||= configurationChanged;
    compositionGate.requestRefresh();
    return;
  }
  const refreshConfiguration = configurationChanged || configurationRefreshPending;
  configurationRefreshPending = false;
  if (!compositionGate.requestRefresh()) return;
  preserveViewportWhile(() => {
    const effects = [
      sourceModeCompartment.reconfigure(makeRendering()),
      markdownLanguageCompartment.reconfigure(shouldUseMarkdownLanguage(largeDocumentSource, sourceMode) ? markdown({ extensions: GFM }) : []),
    ];
    if (refreshConfiguration) effects.push(lineNumberCompartment.reconfigure(settings.showLineNumbers ? lineNumbers({ formatNumber: n => String(n + settings.lineNumberStart - 1) }) : []));
    view?.dispatch({ effects });
    if (refreshConfiguration) updateAppearance();
  });
}

function showStatus(message = ''): void { status.textContent = message; status.hidden = !message; }
function updateAppearance(): void {
  if (!view) return;
  const presets = {
    default: { size: 16, height: 1.6, width: '80ch' },
    compact: { size: 14, height: 1.45, width: '100ch' },
    comfortable: { size: 18, height: 1.75, width: '72ch' },
  } as const;
  const preset = presets[settings.readingPreset];
  const width = settings.contentWidth === 'full' ? '100%' : typeof settings.contentWidth === 'number' ? `${settings.contentWidth}ch` : settings.contentWidth ?? preset.width;
  if (!appearanceStyle) {
    appearanceStyle = document.createElement('style');
    appearanceStyle.setAttribute('nonce', cspNonce);
    appearanceStyle.dataset.liveMarkdownAppearance = 'true';
  }
  if (customStyle?.parentNode === document.head) document.head.insertBefore(appearanceStyle, customStyle);
  else document.head.append(appearanceStyle);
  const sheet = appearanceStyle.sheet;
  if (sheet) {
    while (sheet.cssRules.length) sheet.deleteRule(0);
    sheet.insertRule('.cm-editor {}');
    const editorRule = (sheet.cssRules[0] as CSSStyleRule).style;
    editorRule.setProperty('--lm-font-size', `${settings.fontSize ?? preset.size}px`);
    editorRule.setProperty('--lm-line-height', String(settings.lineHeight ?? preset.height));
    editorRule.setProperty('--lm-content-width', width);
    editorRule.setProperty('--lm-font-family', settings.fontFamily === 'inherit' ? 'var(--vscode-font-family, sans-serif)' : settings.fontFamily);
  }
  view.dom.classList.toggle('lm-full-width', settings.contentWidth === 'full');
  view.dom.classList.toggle('lm-has-line-numbers', settings.showLineNumbers);
  if (customStyle) customStyle.remove();
  if (currentCustomCss) {
    customStyle = document.createElement('style');
    customStyle.setAttribute('nonce', document.querySelector('meta[name="live-markdown-nonce"]')?.getAttribute('content') ?? '');
    customStyle.dataset.liveMarkdownCustom = 'true';
    customStyle.textContent = currentCustomCss;
    document.head.append(customStyle);
  }
}
let currentCustomCss = '';

function persistState(pendingDraft?: string): void {
  if (pendingDraft !== undefined) persistedDraft = pendingDraft;
  if (!view) { vscode.setState({ recoveryId, version: hostVersion, pendingDraft: persistedDraft }); return; }
  const selection = view.state.selection.main;
  vscode.setState({ recoveryId, version: hostVersion, pendingDraft: persistedDraft, anchor: selection.anchor, head: selection.head, scrollTop: window.scrollY, sourceMode });
}

function currentText(): string { return view?.state.doc.toString() ?? ''; }
function sendNext(): void {
  if (!sessionReady || conflict || inFlight) return;
  if (queue.length === 0) {
    if (pendingSourceToggles % 2 === 1) toggleSourceMode();
    pendingSourceToggles = 0;
    if (draftSequence > 0) {
      vscode.postMessage({ type: 'clearDraft', sessionId });
      draftSequence = 0;
      persistedDraft = undefined;
    }
    persistState();
    for (const action of pendingHostActions.splice(0)) vscode.postMessage({ type: 'action', sessionId, action });
    return;
  }
  const queued = queue.splice(0);
  const changeSet = composeChangeSets(committedText.length, queued.map(edit => edit.changeSet));
  const changes = changeSetToSourceChanges(changeSet);
  const next: PendingEdit = {
    changes,
    bytes: queued.reduce((total, edit) => total + edit.bytes, 0),
    draftSequence: queued[queued.length - 1].draftSequence,
    clientRevision: queued[queued.length - 1].clientRevision,
    changeSet,
  };
  if (changes.length === 0) {
    pendingDraftSize = Math.max(0, pendingDraftSize - next.bytes);
    sendNext();
    return;
  }
  const operationId = crypto.randomUUID();
  inFlight = { operationId, baseVersion: hostVersion, ...next };
  vscode.postMessage({ type: 'edit', sessionId, operationId, baseVersion: hostVersion, draftSequence: next.draftSequence, clientRevision: next.clientRevision, changes: next.changes });
  ackTimer = window.setTimeout(() => {
    if (inFlight?.operationId === operationId) enterConflict('The edit acknowledgement timed out. Your local draft is preserved while the document state is checked.');
  }, 30000);
}

function focusRenderedWidget(editor: EditorView, direction: 1 | -1): boolean {
  const candidates: Array<{ position: number; target: HTMLElement }> = [];
  for (const widget of Array.from(editor.dom.querySelectorAll<HTMLElement>('.lm-task-widget, .lm-table-widget, .lm-image-widget'))) {
    const target = widget.querySelector<HTMLElement>('input, th, td') ?? widget;
    if (target instanceof HTMLInputElement && target.disabled) continue;
    const position = Number(widget.dataset.lmPosition);
    if (Number.isInteger(position)) candidates.push({ position, target });
    else {
      try { candidates.push({ position: editor.posAtDOM(widget), target }); }
      catch { /* A widget outside the current document view cannot receive focus. */ }
    }
  }
  candidates.sort((a, b) => a.position - b.position);
  const cursor = editor.state.selection.main.head;
  const candidate = direction > 0
    ? candidates.find(item => item.position >= cursor)
    : [...candidates].reverse().find(item => item.position < cursor);
  if (candidate) {
    candidate.target.focus();
    return true;
  }
  const nextPosition = nextWidgetPosition(editor, direction, cursor);
  if (nextPosition === undefined) return false;
  editor.dispatch({ effects: EditorView.scrollIntoView(nextPosition, { y: 'nearest' }) });
  let attempts = 0;
  const focusAfterScroll = () => {
    if (view !== editor || !editor.dom.isConnected) return;
    const widget = Array.from(editor.dom.querySelectorAll<HTMLElement>('.lm-task-widget, .lm-table-widget, .lm-image-widget'))
      .find(item => Number(item.dataset.lmPosition) === nextPosition);
    if (widget) {
      const target = widget.querySelector<HTMLElement>('input, th, td') ?? widget;
      if (!(target instanceof HTMLInputElement) || !target.disabled) {
        target.focus();
        return;
      }
    }
    if (++attempts < 2) requestAnimationFrame(focusAfterScroll);
    else {
      editor.dispatch({ selection: { anchor: nextPosition }, scrollIntoView: true });
      editor.focus();
    }
  };
  requestAnimationFrame(focusAfterScroll);
  return true;
}

function nextWidgetPosition(editor: EditorView, direction: 1 | -1, cursor: number): number | undefined {
  if (sourceMode || settings.syntaxVisibility === 'always') return undefined;
  const state = editor.state;
  const simplifyWidgets = shouldReduceRendering(state);
  const positions = new Set<number>();
  syntaxTree(state).iterate({ enter: node => {
    let position: number | undefined;
    if ((node.name === 'Task' || node.name === 'TaskMarker') && !documentReadonly && !conflict) {
      const raw = state.sliceDoc(node.from, node.to);
      if (/^\[[ xX]\]$/.test(raw)) position = node.from;
    } else if (node.name === 'Table' && settings.renderTables && !simplifyWidgets) position = node.from;
    else if (node.name === 'Image' && settings.renderImages && !simplifyWidgets) position = node.from;
    if (position !== undefined) {
      const containsCursor = state.selection.ranges.some(range => range.empty
        ? range.head >= node.from && range.head <= node.to
        : range.from < node.to && range.to > node.from);
      const onActiveLine = state.doc.lineAt(node.from).number <= state.doc.lineAt(cursor).number
        && state.doc.lineAt(node.to).number >= state.doc.lineAt(cursor).number;
      if (!containsCursor && !onActiveLine && (direction > 0 ? position >= cursor : position < cursor)) positions.add(position);
    }
  }});
  const sorted = [...positions].sort((a, b) => a - b);
  return direction > 0 ? sorted[0] : sorted[sorted.length - 1];
}

function createEditor(text: string, readOnly: boolean): void {
  const extensions = [
    markdownLanguageCompartment.of(shouldUseMarkdownLanguage(largeDocumentSource, sourceMode) ? markdown({ extensions: GFM }) : []),
    search(),
    documentByteSize,
    EditorView.cspNonce.of(cspNonce),
    sourceModeCompartment.of(renderingWhenVisible(renderingVisible, makeRendering)),
    lineNumberCompartment.of(settings.showLineNumbers ? lineNumbers({ formatNumber: number => String(number + settings.lineNumberStart - 1) }) : []),
    readOnlyCompartment.of(EditorView.editable.of(!readOnly)),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ 'aria-label': 'Live Markdown document', spellcheck: 'false' }),
    EditorView.updateListener.of(update => {
      if (update.selectionSet || update.viewportChanged) persistState();
      if (!update.docChanged || !sessionReady || conflict || update.transactions.some(transaction => transaction.annotation(externalUpdate))) return;
      const changes: SourceChange[] = [];
      update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        changes.push({ from: fromA, to: toA, insert: inserted.toString() });
      });
      if (changes.length) {
        const bytes = sourceChangesByteSize(changes, (from, to) => update.startState.sliceDoc(from, to));
        if (queue.length >= 128 || pendingDraftSize + bytes > 1024 * 1024) {
          enterConflict('Synchronization is behind. Your local draft is preserved; copy it or reload the committed document before continuing.');
          return;
        }
        pendingDraftSize += bytes;
        const sequence = ++draftSequence;
        const revision = ++clientRevision;
        vscode.postMessage({ type: 'draft', sessionId, sequence, changes });
        queue.push({ changes, bytes, draftSequence: sequence, clientRevision: revision, changeSet: update.changes });
        // The host recovery journal stores source patches. Mirroring this whole
        // document into WebviewState on every keystroke makes large files costly.
        persistState();
        sendNext();
      }
    }),
    keymap.of([
      { key: 'Enter', run: continueMarkdown },
      { key: 'Backspace', run: handleMarkdownBackspace },
      { key: 'Mod-z', run: () => { requestHistory('undo'); return true; } },
      { key: 'Mod-y', run: () => { requestHistory('redo'); return true; } },
      { key: 'Shift-Mod-z', run: () => { requestHistory('redo'); return true; } },
      { key: 'Mod-s', run: () => { requestHostAction('save'); return true; } },
      { key: 'Tab', run: editor => focusRenderedWidget(editor, 1) || Boolean(indentWithTab.run?.(editor)) },
      { key: 'Shift-Tab', run: editor => focusRenderedWidget(editor, -1) },
      ...searchKeymap, ...excludedDefaultKeys,
    ]),
    EditorView.domEventHandlers({
      click: (event, editor) => followMarkdownLink(event, editor),
      compositionstart: () => {
        compositionGate.start();
        return false;
      },
      compositionend: (_event, editor) => {
        // Rebuild even when no setting changed: inline decorations intentionally
        // stay mapped, rather than recomputed, while composition is active.
        compositionGate.finish();
        requestAnimationFrame(() => {
          if (view === editor) reconfigureRenderingPreservingViewport(configurationRefreshPending);
        });
        return false;
      },
    }),
    EditorView.theme({ '&': { minHeight: '100%' } }),
  ];
  view = new EditorView({ state: EditorState.create({ doc: text.replace(/\r\n/g, '\n'), extensions }), parent: editorRoot });
  updateAppearance();
}

function followMarkdownLink(event: MouseEvent, editor: EditorView): boolean {
  if (event.button !== 0 || (!event.ctrlKey && !event.metaKey)) return false;
  const position = editor.posAtCoords({ x: event.clientX, y: event.clientY });
  if (position === null) return false;
  const tree = syntaxTree(editor.state);
  let node = tree.resolveInner(position);
  while (!['Link', 'Autolink', 'URL'].includes(node.name) && node.parent) node = node.parent;
  let target: string | undefined;
  if (node.name === 'Link') target = linkTarget(editor.state, node.from, node.to);
  else {
    let url = node;
    if (node.name === 'Autolink') {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === 'URL') { url = child; break; }
      }
    }
    if (url.name !== 'URL') return false;
    let context = url.parent;
    while (context && !['Image', 'Link', 'Autolink'].includes(context.name) && context.parent) context = context.parent;
    if (context?.name === 'Image') return false;
    target = editor.state.sliceDoc(url.from, url.to);
    if (!/^https?:\/\//i.test(target)) return false;
  }
  if (!target) return false;
  if (target.startsWith('#')) {
    let slug: string;
    try { slug = decodeURIComponent(target.slice(1)); } catch { return false; }
    const headings: Array<{ from: number; slug: string }> = [];
    const usedSlugs = new Set<string>();
    syntaxTree(editor.state).iterate({ enter: heading => {
      if (!/^(ATXHeading[1-6]|SetextHeading[12])$/.test(heading.name)) return;
      const text = editor.state.sliceDoc(heading.from, heading.to).split('\n')[0].replace(/^#+\s*/, '');
      const base = slugHeading(text);
      let slug = base;
      for (let suffix = 1; usedSlugs.has(slug); suffix++) slug = `${base}-${suffix}`;
      usedSlugs.add(slug);
      headings.push({ from: heading.from, slug });
    }});
    const wanted = slugHeading(slug);
    const found = headings.find(heading => heading.slug === wanted);
    if (found) { editor.dispatch({ selection: EditorSelection.cursor(found.from) }); editor.focus(); }
    event.preventDefault();
    return true;
  }
  vscode.postMessage({ type: 'followLink', sessionId, target });
  event.preventDefault();
  return true;
}

function slugHeading(value: string): string {
  return value.toLowerCase().replace(/[*_`~]/g, '').trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
}

function requestHistory(action: 'undo' | 'redo'): void {
  requestHostAction(action);
}

function requestHostAction(action: 'undo' | 'redo' | 'save' | 'openInTextEditor'): void {
  if (conflict) return;
  if (inFlight || queue.length) {
    if (pendingHostActions.length >= maxPendingHostActions) {
      enterConflict('Too many editor actions accumulated while synchronization was stalled. Your Markdown draft is preserved.');
      return;
    }
    pendingHostActions.push(action);
  }
  else vscode.postMessage({ type: 'action', sessionId, action });
}

function continueMarkdown(editor: EditorView): boolean {
  const edit = markdownEnterEdit(editor.state);
  if (!edit) return false;
  editor.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: EditorSelection.cursor(edit.cursor) });
  return true;
}

function handleMarkdownBackspace(editor: EditorView): boolean {
  const edit = markdownBackspaceEdit(editor.state);
  if (!edit) return false;
  editor.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: EditorSelection.cursor(edit.cursor) });
  return true;
}

const externalUpdate = Annotation.define<boolean>();
function applyHostText(text: string, version: number, nextEol: '\n' | '\r\n', baseVersion?: number, changes?: SourceChange[]): void {
  if (!view) return;
  if (inFlight || queue.length) {
    if (!rebasePendingText(text, version, nextEol, baseVersion, changes)) {
      enterConflict('The document changed in another editor over the same source range. Copy your draft or reload the committed document before continuing.');
    }
    hostVersion = version;
    eol = nextEol;
    return;
  }
  const before = currentText();
  const next = text.replace(/\r\n/g, '\n');
  const external = getExternalChangeSet(before, next, baseVersion, changes);
  const selection = mapSelection(view.state.selection, external);
  view.dispatch({ changes: external, selection, annotations: [externalUpdate.of(true), Transaction.addToHistory.of(false)] });
  committedText = next;
  hostVersion = version;
  eol = nextEol;
}

function getExternalChangeSet(before: string, after: string, baseVersion?: number, changes?: SourceChange[]): ChangeSet {
  if (baseVersion === hostVersion && changes) {
    try {
      const exact = sourceChangesToSet(changes, before.length);
      if (exact.apply(EditorState.create({ doc: before }).doc).toString() === after) return exact;
    } catch { /* Fall back to a conservative whole-text diff. */ }
  }
  return diffChangeSet(before, after);
}

function rebasePendingText(text: string, version: number, nextEol: '\n' | '\r\n', baseVersion?: number, changes?: SourceChange[]): boolean {
  if (!view) return false;
  const base = committedText;
  const next = text.replace(/\r\n/g, '\n');
  let local = ChangeSet.empty(base.length);
  try {
    if (inFlight) local = local.compose(inFlight.changeSet);
    for (const pending of queue) local = local.compose(pending.changeSet);
  } catch {
    return false;
  }
  const remote = getExternalChangeSet(base, next, baseVersion, changes);
  if (changesOverlap(local, remote)) return false;

  const localOverRemote = local.map(remote);
  const remoteOverLocal = remote.map(local, true);
  const journalChanges = changeSetToSourceChanges(remoteOverLocal);
  const editChanges = changeSetToSourceChanges(localOverRemote);
  const journalBytes = sourceChangesByteSize(journalChanges, (from, to) => view!.state.sliceDoc(from, to));
  const editBytes = sourceChangesByteSize(editChanges, (from, to) => next.slice(from, to));
  const nextDraftSequence = journalChanges.length ? draftSequence + 1 : draftSequence;
  const nextClientRevision = Math.max(inFlight?.clientRevision ?? 0, ...queue.map(pending => pending.clientRevision));
  if (journalChanges.length && (nextDraftSequence > 256 || pendingDraftSize + journalBytes > 1024 * 1024)) return false;

  if (ackTimer !== undefined) window.clearTimeout(ackTimer);
  ackTimer = undefined;
  inFlight = undefined;
  queue = [];
  pendingDraftSize = editBytes;
  hostVersion = version;
  committedText = next;
  eol = nextEol;
  if (journalChanges.length) {
    draftSequence = nextDraftSequence;
    vscode.postMessage({ type: 'draft', sessionId, sequence: draftSequence, changes: journalChanges });
  }

  const selection = mapSelection(view.state.selection, remoteOverLocal);
  view.dispatch({ changes: remoteOverLocal, selection, annotations: [externalUpdate.of(true), Transaction.addToHistory.of(false)] });
  if (editChanges.length) {
    queue.push({ changes: editChanges, bytes: editBytes, draftSequence, clientRevision: nextClientRevision, changeSet: localOverRemote });
  } else {
    pendingDraftSize = 0;
  }
  persistState();
  sendNext();
  return true;
}

function mapSelection(selection: EditorSelection, changes: ChangeSet): EditorSelection {
  return EditorSelection.create(selection.ranges.map(range => {
    if (range.empty) {
      const position = changes.mapPos(range.head, -1);
      return EditorSelection.cursor(position);
    }
    return EditorSelection.range(changes.mapPos(range.anchor, -1), changes.mapPos(range.head, 1));
  }), selection.mainIndex);
}

function applySourceChanges(text: string, changes: SourceChange[]): string {
  for (const change of [...changes].sort((a, b) => b.from - a.from || b.to - a.to)) {
    text = text.slice(0, change.from) + change.insert + text.slice(change.to);
  }
  return text;
}

function enterConflict(message: string, draft = currentText()): void {
  conflict = true;
  if (ackTimer !== undefined) window.clearTimeout(ackTimer);
  ackTimer = undefined;
  queue = [];
  pendingDraftSize = 0;
  pendingHostActions = [];
  pendingSourceToggles = 0;
  inFlight = undefined;
  showStatus('');
  const banner = document.createElement('section');
  banner.className = 'lm-recovery';
  banner.setAttribute('role', 'alert');
  const text = document.createElement('span');
  text.textContent = message;
  const copy = document.createElement('button');
  copy.textContent = 'Copy draft';
  const draftSource = document.createElement('textarea');
  draftSource.className = 'lm-recovery-source';
  draftSource.setAttribute('aria-label', 'Recovered Markdown draft');
  draftSource.readOnly = true;
  draftSource.spellcheck = false;
  draftSource.hidden = true;
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(draft); copy.textContent = 'Draft copied'; }
    catch {
      draftSource.value = draft;
      draftSource.hidden = false;
      draftSource.focus();
      draftSource.select();
      showStatus('Clipboard access failed. The draft is selected in the recovery box so you can copy it manually.');
    }
  });
  const reload = document.createElement('button');
  reload.textContent = 'Reload document';
  reload.addEventListener('click', () => {
    vscode.postMessage({ type: 'clearDraft', sessionId });
    draftSequence = 0;
      persistedDraft = undefined;
      banner.remove();
      queue = [];
      inFlight = undefined;
    pendingDraftSize = 0;
    conflict = false;
    if (view) {
      const effects = [readOnlyCompartment.reconfigure(EditorView.editable.of(!documentReadonly))];
      // A configuration-only refresh must wait, but a document reload still
      // synchronizes immediately. Keep its rendering extension until composition ends.
      if (!compositionGate.isActive()) effects.push(sourceModeCompartment.reconfigure(renderingWhenVisible(renderingVisible, makeRendering)));
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: committedText }, annotations: [externalUpdate.of(true), Transaction.addToHistory.of(false)], effects });
      persistState();
    }
  });
  banner.append(text, copy, reload, draftSource);
  editorRoot.prepend(banner);
  view?.dispatch({ effects: readOnlyCompartment.reconfigure(EditorView.editable.of(false)) });
  reconfigureRenderingPreservingViewport();
  view?.focus();
  persistState(draft);
}
let committedText = '';

function format(action: string): void {
  if (!view || conflict) return;
  if (action === 'toggleSource') {
    if (inFlight || queue.length) pendingSourceToggles = 1 - pendingSourceToggles;
    else toggleSourceMode();
    return;
  }
  if (action === 'undo' || action === 'redo') { requestHistory(action); return; }
  if (action === 'save' || action === 'openInTextEditor') { requestHostAction(action); return; }
  if (documentReadonly) return;
  const selection = view.state.selection.main;
  const selected = view.state.sliceDoc(selection.from, selection.to);
  if (action === 'insertLink') {
    const label = selected || 'label';
    const insert = `[${label}](url)`;
    const labelFrom = selection.from + 1;
    const urlFrom = labelFrom + label.length + 2;
    const nextSelection = selected
      ? EditorSelection.range(urlFrom, urlFrom + 3)
      : EditorSelection.range(labelFrom, labelFrom + label.length);
    view.dispatch({ changes: { from: selection.from, to: selection.to, insert }, selection: nextSelection });
    view.focus();
    return;
  }
  const wraps: Record<string, [string, string]> = { bold: ['**', '**'], italic: ['*', '*'], inlineCode: ['`', '`'] };
  const wrap = wraps[action];
  if (!wrap) return;
  const insert = `${wrap[0]}${selected}${wrap[1]}`;
  const cursor = selected ? EditorSelection.cursor(selection.to + wrap[0].length) : EditorSelection.cursor(selection.from + wrap[0].length);
  view.dispatch({ changes: { from: selection.from, to: selection.to, insert }, selection: selected ? EditorSelection.range(selection.from + wrap[0].length, selection.to + wrap[0].length) : cursor });
  view.focus();
}

function toggleSourceMode(): void {
  if (!view || conflict) return;
  sourceMode = !sourceMode;
  reconfigureRenderingPreservingViewport();
  persistState();
}

function handleMessage(message: HostMessage | StatusMessage | CommandMessage): void {
  switch (message.type) {
    case 'initialize':
      if (message.sessionId !== sessionId) return;
      recoveryId = message.recoveryId;
      panelVisible = message.visible;
      renderingVisible = panelVisible && document.visibilityState === 'visible';
      settings = message.settings;
      documentReadonly = message.readonly;
      currentCustomCss = message.customCss ?? '';
      hostVersion = message.version;
      committedText = message.text.replace(/\r\n/g, '\n');
      eol = message.eol;
      if (!view && shouldOpenInSourceMode(message.text)) { sourceMode = true; largeDocumentSource = true; }
      if (!view) createEditor(message.text, message.readonly);
      if (!vscode.getState()) requestAnimationFrame(() => view?.focus());
      if (largeDocumentSource) showStatus('Large document opened in source mode. You can keep editing and saving Markdown normally.');
      sessionReady = true;
      const recovered = vscode.getState() as PersistedWebviewState | undefined;
      if (recovered?.sourceMode) {
        sourceMode = true;
        view?.dispatch({ effects: [
          sourceModeCompartment.reconfigure(renderingWhenVisible(renderingVisible, makeRendering)),
          markdownLanguageCompartment.reconfigure(shouldUseMarkdownLanguage(largeDocumentSource, sourceMode) ? markdown({ extensions: GFM }) : []),
        ] });
      }
      if (view && Number.isInteger(recovered?.anchor) && Number.isInteger(recovered?.head)) {
        const anchor = Math.max(0, Math.min(view.state.doc.length, recovered!.anchor!));
        const head = Math.max(0, Math.min(view.state.doc.length, recovered!.head!));
        view.dispatch({ selection: EditorSelection.range(anchor, head) });
        requestAnimationFrame(() => { if (view && typeof recovered?.scrollTop === 'number') window.scrollTo(0, recovered.scrollTop); });
      }
      const recoveredText = message.recoveredDraft ?? recovered?.pendingDraft;
      if (recoveredText !== undefined && recoveredText !== committedText) {
        draftSequence = 0;
        if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: recoveredText }, annotations: [externalUpdate.of(true), Transaction.addToHistory.of(false)] });
        enterConflict('A local draft was recovered after the editor restarted. Copy it or reload the committed document.', recoveredText);
      } else persistState();
      break;
    case 'ack':
      if (conflict || !inFlight || message.operationId !== inFlight.operationId) return;
      if (message.version >= hostVersion) {
        if (hostVersion === inFlight.baseVersion) committedText = applySourceChanges(committedText, inFlight.changes);
        hostVersion = message.version;
      }
      if (ackTimer !== undefined) window.clearTimeout(ackTimer);
      ackTimer = undefined;
      pendingDraftSize = Math.max(0, pendingDraftSize - inFlight.bytes);
      inFlight = undefined;
      sendNext();
      break;
    case 'external':
      applyHostText(message.text, message.version, message.eol, message.baseVersion, message.changes);
      committedText = message.text.replace(/\r\n/g, '\n');
      break;
    case 'failure':
      if (message.operationId && (!inFlight || message.operationId !== inFlight.operationId)) return;
      if (message.version >= hostVersion) {
        committedText = message.draft.replace(/\r\n/g, '\n');
        hostVersion = message.version;
      }
      if (!conflict) enterConflict(message.message, currentText());
      break;
    case 'configuration':
      settings = message.settings;
      currentCustomCss = message.customCss ?? '';
      reconfigureRenderingPreservingViewport(true);
      break;
    case 'resourceResult': {
      const resolve = resourceWaiters.get(message.requestId);
      if (resolve) { resourceWaiters.delete(message.requestId); resolve(message.uri, message.error); }
      break;
    }
    case 'status':
      showStatus(message.message);
      break;
    case 'command':
      format(message.action);
      break;
    case 'visibility':
      panelVisible = message.visible;
      refreshRenderingVisibility();
      if (message.visible && sessionReady) vscode.postMessage({ type: 'resume', sessionId });
      break;
  }
}

function refreshRenderingVisibility(): void {
  const visible = panelVisible && document.visibilityState === 'visible';
  if (visible === renderingVisible) return;
  renderingVisible = visible;
  if (!view) return;
  if (visible) reconfigureRenderingPreservingViewport(true);
  else view.dispatch({ effects: sourceModeCompartment.reconfigure([]) });
}

window.addEventListener('message', event => {
  const message: unknown = event.data;
  if (isHostMessage(message) || isStatusMessage(message) || isCommandMessage(message)) handleMessage(message);
});
document.addEventListener('visibilitychange', refreshRenderingVisibility);
window.addEventListener('scroll', () => persistState(), { passive: true });
vscode.postMessage({ type: 'ready', sessionId, recoveryId });
