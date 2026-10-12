import * as vscode from 'vscode';
import { createHash, randomBytes } from 'crypto';
import { performance } from 'node:perf_hooks';
import { ChangeSet } from '@codemirror/state';
import { SourceChange, WebviewMessage, isWebviewMessage } from './protocol';
import { isDocumentReadonly } from './documentAccess';
import { changeSetToSourceChanges, sourceChangesToSet } from './rebase';

type Client = { panel: vscode.WebviewPanel; sessionId: string; ready: boolean; recoveryId?: string };
type RecoveryBase = { baseVersion: number; baseText: string };
type RecoverySnapshot = { sequence: number; changes: SourceChange[] };
type RecoveryState = {
  id: string; key: string; sequence: number; persistedSequence: number; bytes: number; text: string; baseText?: string;
  journal?: ChangeSet; tail: Promise<void>; ready: Promise<void>; flushTimer?: ReturnType<typeof setTimeout>; flushPromise?: Promise<void>;
};

const MAX_RECOVERY_PATCHES = 256;
const MAX_RECOVERY_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY_EVENTS = 256;
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;

type HistoryGroup = { owner: string; kind: 'insert' | 'delete'; from: number; to: number; original: string; inserted: string; lastAt: number };
type HistoryEntry = { undo: SourceChange[]; redo: SourceChange[]; bytes: number; group?: HistoryGroup };

/** Coordinates webview mirrors with VS Code's authoritative TextDocument. */
export class DocumentBridge implements vscode.Disposable {
  private clients = new Set<Client>();
  private readonly disposables: vscode.Disposable[];
  private editTail: Promise<void> = Promise.resolve();
  private recoveryIndexTail: Promise<void> = Promise.resolve();
  private ownVersion = -1;
  private expectedOwn?: { owner: string; text: string; version: number; timer: ReturnType<typeof setTimeout> };
  private recoveryStates = new Map<Client, RecoveryState>();
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private historyBytes = 0;
  private historyMove = false;
  private snapshotText: string;
  private snapshotLineStarts: number[];
  private snapshotVersion: number;

  constructor(private readonly document: vscode.TextDocument, private readonly state: vscode.Memento) {
    this.snapshotText = document.getText().replace(/\r\n/g, '\n');
    this.snapshotLineStarts = normalizedLineStarts(this.snapshotText);
    this.snapshotVersion = document.version;
    this.disposables = [
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.uri.toString() !== this.document.uri.toString()) return;
        const beforeVersion = this.snapshotVersion;
        const beforeText = this.snapshotText;
        const beforeLineStarts = this.snapshotLineStarts;
        const nextText = event.document.getText().replace(/\r\n/g, '\n');
        const changes = event.contentChanges.map(change => ({
          from: positionToNormalizedOffset(beforeLineStarts, change.range.start),
          to: positionToNormalizedOffset(beforeLineStarts, change.range.end),
          insert: change.text.replace(/\r\n/g, '\n'),
        })).sort((a, b) => a.from - b.from || a.to - b.to);
        const ownEdit = this.expectedOwn && event.document.version === this.expectedOwn.version && event.document.getText() === this.expectedOwn.text
          ? this.expectedOwn.owner
          : undefined;
        if (!this.historyMove && beforeText !== nextText) this.recordHistory(beforeText, nextText, changes, ownEdit);
        this.snapshotText = nextText;
        this.snapshotLineStarts = updateNormalizedLineStarts(beforeLineStarts, changes);
        this.snapshotVersion = event.document.version;
        if (this.expectedOwn && event.document.version === this.expectedOwn.version && event.document.getText() === this.expectedOwn.text) {
          clearTimeout(this.expectedOwn.timer);
          this.expectedOwn = undefined;
          this.ownVersion = event.document.version;
          return;
        }
        if (this.expectedOwn && event.document.version >= this.expectedOwn.version) {
          clearTimeout(this.expectedOwn.timer);
          this.expectedOwn = undefined;
        }
        if (event.document.version <= this.ownVersion) return;
        for (const client of this.clients) {
          if (client.ready) void client.panel.webview.postMessage({ type: 'external', text: this.document.getText(), version: this.document.version, baseVersion: beforeVersion, changes, eol: this.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n' }).then(undefined, () => undefined);
        }
      }),
    ];
  }

  add(client: Client): void {
    this.clients.add(client);
  }

  remove(client: Client): void {
    this.clients.delete(client);
    const recovery = this.recoveryStates.get(client);
    this.recoveryStates.delete(client);
    // Closing a view can cancel the edit message that would normally flush
    // its debounced journal. Drain any draft already received by the host now.
    if (recovery) void recovery.tail.then(() => this.flushRecovery(recovery)).catch(() => undefined);
  }

  async prepareRecoveryClient(client: Client, requestedId: string): Promise<void> {
    const task = this.recoveryIndexTail.then(async () => {
      const documentKey = createHash('sha256').update(this.document.uri.toString()).digest('hex');
      const indexKey = `liveMarkdown.recovery-index.${documentKey}`;
      const ids = this.state.get<string[]>(indexKey) ?? [];
      const activeIds = new Set([...this.clients].filter(other => other !== client && other.recoveryId).map(other => other.recoveryId!));
      let id = requestedId;
      if (activeIds.has(id)) id = randomBytes(16).toString('hex');
      else if (!ids.includes(id)) {
        const interrupted = ids.find(candidate => !activeIds.has(candidate) && this.state.get<RecoveryBase>(this.recoveryKey(candidate) + '.base'));
        if (interrupted) id = interrupted;
      }
      client.recoveryId = id;
      if (!ids.includes(id)) await this.state.update(indexKey, [...ids, id].slice(-64));
    });
    this.recoveryIndexTail = task.catch(() => undefined);
    await task;
  }

  async receive(client: Client, value: unknown): Promise<void> {
    if (!isWebviewMessage(value) || value.sessionId !== client.sessionId) return;
    const message = value as WebviewMessage;
    if (message.type === 'ready') {
      client.recoveryId ??= message.recoveryId;
      client.ready = true;
      this.recoveryFor(client);
      return;
    }
    if (message.type === 'resume') {
      client.ready = true;
      return;
    }
    if (message.type === 'draft') {
      const recovery = this.recoveryFor(client);
      const task = recovery.tail.then(() => this.persistDraft(client, recovery, message.sequence, message.changes));
      recovery.tail = task.catch(() => undefined);
      try { await task; }
      catch (error) {
        await client.panel.webview.postMessage({ type: 'failure', message: `Draft recovery could not be saved: ${String(error)}`, draft: recovery.text, version: this.document.version });
      }
      return;
    }
    if (message.type === 'clearDraft') {
      const recovery = this.recoveryFor(client);
      const task = recovery.tail.then(async () => {
        await this.clearRecovery(recovery);
      });
      recovery.tail = task.catch(() => undefined);
      await task;
      return;
    }
    if (message.type === 'action') {
      const action = message.action;
      if (action === 'undo' || action === 'redo') {
        const task = this.editTail.then(() => this.moveHistory(client, action));
        this.editTail = task.catch(() => undefined);
        await task;
      }
      return;
    }
    if (message.type !== 'edit') return;
    const task = this.editTail.then(() => this.receiveEdit(client, message));
    this.editTail = task.catch(() => undefined);
    await task;
  }

  async recoveredDraft(client: Client): Promise<string | undefined> {
    const recovery = this.recoveryFor(client);
    await recovery.ready;
    await recovery.tail;
    return recovery.sequence ? recovery.text : undefined;
  }

  async clearStaleRecoveryIfCommitted(client: Client): Promise<void> {
    const recovery = this.recoveryFor(client);
    const draft = await this.recoveredDraft(client);
    if (draft !== undefined && draft === this.document.getText().replace(/\r\n/g, '\n')) {
      await recovery.tail;
      await this.clearRecovery(recovery);
    }
  }

  private recordHistory(before: string, after: string, forward: SourceChange[], owner?: string): void {
    if (applyChanges(before, forward) !== after) return;
    const inverse: SourceChange[] = [];
    let delta = 0;
    for (const change of [...forward].sort((a, b) => a.from - b.from || a.to - b.to)) {
      const from = change.from + delta;
      inverse.push({ from, to: from + change.insert.length, insert: before.slice(change.from, change.to) });
      delta += change.insert.length - (change.to - change.from);
    }
    const timestamp = Date.now();
    const group = this.createHistoryGroup(before, forward, owner, timestamp);
    for (const entry of this.redoStack) this.historyBytes -= entry.bytes;
    this.redoStack = [];
    const previous = this.undoStack[this.undoStack.length - 1];
    if (group && previous?.group && this.mergeHistoryGroup(previous.group, group)) {
      this.historyBytes -= previous.bytes;
      previous.redo = [{ from: previous.group.from, to: previous.group.to, insert: previous.group.inserted }];
      previous.undo = [{ from: previous.group.from, to: previous.group.from + previous.group.inserted.length, insert: previous.group.original }];
      previous.bytes = JSON.stringify(previous.redo).length + JSON.stringify(previous.undo).length;
      this.historyBytes += previous.bytes;
      return;
    }
    const bytes = JSON.stringify(forward).length + JSON.stringify(inverse).length;
    if (bytes > MAX_HISTORY_BYTES) return;
    const entry = { undo: inverse, redo: forward, bytes, group };
    this.undoStack.push(entry);
    this.historyBytes += bytes;
    while (this.undoStack.length > MAX_HISTORY_EVENTS || this.historyBytes > MAX_HISTORY_BYTES) {
      const discarded = this.undoStack.shift();
      if (!discarded) break;
      this.historyBytes -= discarded.bytes;
    }
  }

  private createHistoryGroup(before: string, changes: SourceChange[], owner: string | undefined, timestamp: number): HistoryGroup | undefined {
    if (!owner || changes.length !== 1) return undefined;
    const change = changes[0];
    if (change.insert.length > 2 || /\r|\n/.test(change.insert)) return undefined;
    if (change.from === change.to && change.insert.length > 0) {
      return { owner, kind: 'insert', from: change.from, to: change.from, original: '', inserted: change.insert, lastAt: timestamp };
    }
    if (!change.insert && change.to - change.from === 1) {
      return { owner, kind: 'delete', from: change.from, to: change.to, original: before.slice(change.from, change.to), inserted: '', lastAt: timestamp };
    }
    return undefined;
  }

  private mergeHistoryGroup(previous: HistoryGroup, next: HistoryGroup): boolean {
    if (previous.owner !== next.owner || previous.kind !== next.kind || next.lastAt - previous.lastAt > 750) return false;
    if (previous.kind === 'insert') {
      if (next.from !== previous.from + previous.inserted.length || next.to !== next.from) return false;
      previous.inserted += next.inserted;
    } else if (next.to === previous.from) {
      previous.original = next.original + previous.original;
      previous.from = next.from;
    } else if (next.from === previous.from && next.to === previous.from + 1) {
      previous.original += next.original;
      previous.to++;
    } else {
      return false;
    }
    previous.lastAt = next.lastAt;
    return true;
  }

  private async moveHistory(client: Client, action: 'undo' | 'redo'): Promise<void> {
    if (this.document.isClosed || await isDocumentReadonly(this.document.uri)) return;
    const sourceStack = action === 'undo' ? this.undoStack : this.redoStack;
    const targetStack = action === 'undo' ? this.redoStack : this.undoStack;
    const entry = sourceStack.pop();
    if (!entry) return;
    const changes = action === 'undo' ? entry.undo : entry.redo;
    const source = this.document.getText();
    const normalized = source.replace(/\r\n/g, '\n');
    if (applyChanges(normalized, changes) === undefined) {
      sourceStack.push(entry);
      return;
    }
    const lineStarts = normalizedLineStarts(normalized);
    const edit = new vscode.WorkspaceEdit();
    for (const change of [...changes].sort((a, b) => b.from - a.from || b.to - a.to)) {
      const start = normalizedOffsetToPosition(lineStarts, change.from);
      const end = normalizedOffsetToPosition(lineStarts, change.to);
      const insert = change.insert.replace(/\r?\n/g, this.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
      edit.replace(this.document.uri, new vscode.Range(start, end), insert);
    }
    let accepted = false;
    this.historyMove = true;
    try { accepted = await vscode.workspace.applyEdit(edit); }
    catch { accepted = false; }
    finally { this.historyMove = false; }
    if (accepted) {
      entry.group = undefined;
      targetStack.push(entry);
      const adjacent = this.undoStack[this.undoStack.length - 1];
      if (adjacent) adjacent.group = undefined;
    }
    else sourceStack.push(entry);
  }

  private async receiveEdit(client: Client, message: Extract<WebviewMessage, { type: 'edit' }>): Promise<void> {
    const fail = (reason: string) => client.panel.webview.postMessage({ type: 'failure', operationId: message.operationId, message: reason, draft: this.document.getText(), version: this.document.version });
    if (this.document.isClosed) return;
    const recoveryStarted = performance.now();
    const recovery = this.recoveryFor(client);
    await recovery.ready;
    await recovery.tail;
    const recoveryWaitMs = performance.now() - recoveryStarted;
    if (message.draftSequence > recovery.sequence) {
      await fail('The recovery journal is out of sync. Your local draft is preserved.');
      return;
    }
    try { await this.flushRecovery(recovery, message.draftSequence); }
    catch {
      await fail('The recovery journal could not be saved. Your local draft is preserved.');
      return;
    }
    if (message.baseVersion !== this.document.version) {
      await fail('The document changed elsewhere. Your local draft is preserved; reload or recover it before continuing.');
      return;
    }
    if (await isDocumentReadonly(this.document.uri)) {
      await fail('This document is read-only. Your draft is preserved.');
      return;
    }
    const processingStarted = performance.now();
    const source = this.document.getText();
    const normalizedSource = source.replace(/\r\n/g, '\n');
    const normalizedLength = normalizedSource.length;
    const lineStarts = this.snapshotVersion === this.document.version
      ? this.snapshotLineStarts
      : normalizedLineStarts(normalizedSource);
    const toPosition = (offset: number) => normalizedOffsetToPosition(lineStarts, offset);
    const edit = new vscode.WorkspaceEdit();
    const changes = [...message.changes].sort((a, b) => b.from - a.from);
    let priorFrom = source.length + 1;
    for (const change of changes) {
      if (change.to > normalizedLength || change.to > priorFrom) {
        await fail('The edit ranges do not match the current document. Your draft is preserved.');
        return;
      }
      priorFrom = change.from;
      const start = toPosition(change.from);
      const end = toPosition(change.to);
      const inserted = change.insert.replace(/\r?\n/g, this.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
      edit.replace(this.document.uri, new vscode.Range(start, end), inserted);
    }
    let expected = normalizedSource;
    for (const change of changes) expected = expected.slice(0, change.from) + change.insert + expected.slice(change.to);
    const hostProcessingMs = performance.now() - processingStarted;
    if (this.expectedOwn) clearTimeout(this.expectedOwn.timer);
    const expectedOwn = {
      owner: client.sessionId,
      text: this.document.eol === vscode.EndOfLine.CRLF ? expected.replace(/\n/g, '\r\n') : expected,
      version: this.document.version + 1,
      timer: setTimeout(() => { if (this.expectedOwn === expectedOwn) this.expectedOwn = undefined; }, 30000),
    };
    this.expectedOwn = expectedOwn;
    let accepted = false;
    const workspaceEditStarted = performance.now();
    try {
      accepted = await vscode.workspace.applyEdit(edit);
    } catch {
      accepted = false;
    } finally {
      if (!accepted && this.expectedOwn === expectedOwn) {
        clearTimeout(expectedOwn.timer);
        this.expectedOwn = undefined;
      }
    }
    const workspaceEditMs = performance.now() - workspaceEditStarted;
    if (!accepted) {
      await fail('VS Code rejected the edit. Your draft is preserved.');
      return;
    }
    await client.panel.webview.postMessage({ type: 'ack', operationId: message.operationId, version: expectedOwn.version, clientRevision: message.clientRevision, hostProcessingMs, recoveryWaitMs, workspaceEditMs });
    for (const other of this.clients) {
      if (other !== client && other.ready) void other.panel.webview.postMessage({ type: 'external', text: this.document.getText(), version: this.document.version, baseVersion: message.baseVersion, changes: message.changes, eol: this.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n' }).then(undefined, () => undefined);
    }
  }

  private recoveryFor(client: Client): RecoveryState {
    if (!client.recoveryId) throw new Error('The webview recovery identity is not ready.');
    let recovery = this.recoveryStates.get(client);
    if (recovery) return recovery;
    recovery = {
      id: client.recoveryId, key: this.recoveryKey(client.recoveryId), sequence: 0, persistedSequence: 0,
      bytes: 0, text: '', tail: Promise.resolve(), ready: Promise.resolve(),
    };
    recovery.ready = this.loadRecovery(recovery);
    this.recoveryStates.set(client, recovery);
    return recovery;
  }

  private recoveryKey(id: string): string {
    const documentKey = createHash('sha256').update(this.document.uri.toString()).digest('hex');
    const clientKey = createHash('sha256').update(id).digest('hex');
    return `liveMarkdown.recovery.${documentKey}.${clientKey}`;
  }

  private async loadRecovery(recovery: RecoveryState): Promise<void> {
    const base = this.state.get<RecoveryBase>(`${recovery.key}.base`);
    if (!base || typeof base.baseText !== 'string') return;
    recovery.baseText = base.baseText.replace(/\r\n/g, '\n');
    const snapshot = this.state.get<RecoverySnapshot>(`${recovery.key}.snapshot`);
    if (snapshot && Number.isSafeInteger(snapshot.sequence) && snapshot.sequence > 0 && snapshot.sequence <= MAX_RECOVERY_PATCHES && Array.isArray(snapshot.changes)) {
      const recovered = applyChanges(recovery.baseText, snapshot.changes);
      if (recovered === undefined) { await this.clearRecovery(recovery, MAX_RECOVERY_PATCHES); return; }
      recovery.sequence = snapshot.sequence;
      recovery.persistedSequence = snapshot.sequence;
      recovery.bytes = JSON.stringify(snapshot.changes).length;
      if (recovery.bytes > MAX_RECOVERY_BYTES) { await this.clearRecovery(recovery, MAX_RECOVERY_PATCHES); return; }
      recovery.text = recovered;
      recovery.journal = recoveryChangesToSet(snapshot.changes, recovery.baseText.length);
      return;
    }
    const storedSequence = this.state.get<number>(`${recovery.key}.sequence`) ?? 0;
    let text = recovery.baseText;
    let journal = ChangeSet.empty(text.length);
    let sequence = 0;
    let bytes = 0;
    // Probe one entry beyond the sequence marker to recover a patch if the host
    // stopped between persisting that patch and updating its sequence marker.
    for (let index = 1; index <= Math.min(MAX_RECOVERY_PATCHES, Math.max(storedSequence + 1, 1)); index++) {
      const changes = this.state.get<SourceChange[]>(`${recovery.key}.patch.${index}`);
      if (!changes) break;
      const next = applyChanges(text, changes);
      if (next === undefined) { await this.clearRecovery(recovery, MAX_RECOVERY_PATCHES); return; }
      bytes += JSON.stringify(changes).length;
      if (bytes > MAX_RECOVERY_BYTES) { await this.clearRecovery(recovery, MAX_RECOVERY_PATCHES); return; }
      journal = journal.compose(recoveryChangesToSet(changes, text.length));
      text = next;
      sequence = index;
    }
    recovery.sequence = sequence;
    recovery.persistedSequence = sequence;
    recovery.bytes = bytes;
    recovery.text = text;
    recovery.journal = journal;
  }

  private async persistDraft(client: Client, recovery: RecoveryState, sequence: number, changes: SourceChange[]): Promise<void> {
    await recovery.ready;
    if (sequence <= recovery.sequence) return;
    if (sequence !== recovery.sequence + 1) throw new Error('Recovery sequence gap');
    let base = this.state.get<RecoveryBase>(`${recovery.key}.base`);
    if (!base) {
      base = {
        baseVersion: this.document.version,
        baseText: this.document.getText().replace(/\r\n/g, '\n'),
      };
      await this.state.update(`${recovery.key}.base`, base);
      recovery.baseText = base.baseText;
      recovery.text = base.baseText;
      recovery.journal = ChangeSet.empty(base.baseText.length);
    }
    const currentText = recovery.sequence ? recovery.text : recovery.baseText ?? base.baseText.replace(/\r\n/g, '\n');
    const nextText = applyChanges(currentText, changes);
    if (nextText === undefined || recovery.sequence >= MAX_RECOVERY_PATCHES || recovery.baseText === undefined) {
      await client.panel.webview.postMessage({ type: 'failure', message: 'The durable recovery limit was reached. Copy your draft before reloading.', draft: recovery.sequence ? recovery.text : base.baseText, version: this.document.version });
      throw new Error('Recovery journal limit reached');
    }
    const increment = recoveryChangesToSet(changes, currentText.length);
    const journal = (recovery.journal ?? ChangeSet.empty(recovery.baseText.length)).compose(increment);
    const journalChanges = changeSetToSourceChanges(journal);
    const bytes = JSON.stringify(journalChanges).length;
    if (bytes > MAX_RECOVERY_BYTES) {
      await client.panel.webview.postMessage({ type: 'failure', message: 'The durable recovery limit was reached. Copy your draft before reloading.', draft: recovery.sequence ? recovery.text : base.baseText, version: this.document.version });
      throw new Error('Recovery journal limit reached');
    }
    recovery.text = nextText;
    recovery.sequence = sequence;
    recovery.journal = journal;
    recovery.bytes = bytes;
    this.scheduleRecoveryFlush(recovery);
  }

  private scheduleRecoveryFlush(recovery: RecoveryState): void {
    if (recovery.flushTimer) clearTimeout(recovery.flushTimer);
    recovery.flushTimer = setTimeout(() => {
      recovery.flushTimer = undefined;
      void this.flushRecovery(recovery).catch(() => undefined);
    }, 75);
  }

  private async flushRecovery(recovery: RecoveryState, requiredSequence = recovery.sequence): Promise<void> {
    if (recovery.flushTimer) clearTimeout(recovery.flushTimer);
    recovery.flushTimer = undefined;
    while (recovery.persistedSequence < requiredSequence) {
      if (recovery.flushPromise) {
        await recovery.flushPromise;
        continue;
      }
      if (!recovery.journal) throw new Error('Recovery journal is unavailable.');
      const sequence = recovery.sequence;
      const snapshot: RecoverySnapshot = { sequence, changes: changeSetToSourceChanges(recovery.journal) };
      const task = Promise.resolve(this.state.update(`${recovery.key}.snapshot`, snapshot)).then(() => {
        recovery.persistedSequence = Math.max(recovery.persistedSequence, sequence);
      });
      recovery.flushPromise = task;
      try { await task; }
      finally { if (recovery.flushPromise === task) recovery.flushPromise = undefined; }
    }
  }

  private async clearRecovery(recovery: RecoveryState, maxPatches = recovery.sequence + 1): Promise<void> {
    if (recovery.flushTimer) clearTimeout(recovery.flushTimer);
    recovery.flushTimer = undefined;
    if (recovery.flushPromise) await recovery.flushPromise;
    const count = Math.min(MAX_RECOVERY_PATCHES, maxPatches);
    await Promise.all([
      this.state.update(`${recovery.key}.base`, undefined),
      this.state.update(`${recovery.key}.snapshot`, undefined),
      this.state.update(`${recovery.key}.sequence`, undefined),
      ...Array.from({ length: count }, (_, index) => this.state.update(`${recovery.key}.patch.${index + 1}`, undefined)),
    ]);
    await this.unregisterRecovery(recovery.id);
    recovery.sequence = 0;
    recovery.persistedSequence = 0;
    recovery.bytes = 0;
    recovery.text = '';
    recovery.baseText = undefined;
    recovery.journal = undefined;
  }

  private async unregisterRecovery(id: string): Promise<void> {
    const task = this.recoveryIndexTail.then(async () => {
      const documentKey = createHash('sha256').update(this.document.uri.toString()).digest('hex');
      const indexKey = `liveMarkdown.recovery-index.${documentKey}`;
      const ids = this.state.get<string[]>(indexKey) ?? [];
      await this.state.update(indexKey, ids.filter(candidate => candidate !== id));
    });
    this.recoveryIndexTail = task.catch(() => undefined);
    await task;
  }

  dispose(): void {
    if (this.expectedOwn) clearTimeout(this.expectedOwn.timer);
    for (const recovery of this.recoveryStates.values()) void this.flushRecovery(recovery).catch(() => undefined);
    this.disposables.forEach(disposable => disposable.dispose());
    this.clients.clear();
    this.recoveryStates.clear();
  }
}

/** CodeMirror stores line breaks as LF while TextDocument offsets include CR in CRLF files. */
function positionToNormalizedOffset(lineStarts: number[], position: vscode.Position): number {
  const start = lineStarts[Math.min(position.line, lineStarts.length - 1)];
  const lineEnd = position.line + 1 < lineStarts.length ? lineStarts[position.line + 1] - 1 : Number.MAX_SAFE_INTEGER;
  return Math.min(lineEnd, start + position.character);
}

function normalizedLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) starts.push(index + 1);
  return starts;
}

/** Update cached LF-normalized line offsets from a transaction without rescanning the document. */
function updateNormalizedLineStarts(lineStarts: readonly number[], changes: readonly SourceChange[]): number[] {
  let starts = [...lineStarts];
  for (const change of [...changes].sort((a, b) => b.from - a.from || b.to - a.to)) {
    const prefixEnd = upperBound(starts, change.from);
    const suffixStart = upperBound(starts, change.to);
    const delta = change.insert.length - (change.to - change.from);
    const next = starts.slice(0, prefixEnd);
    for (let index = 0; index < change.insert.length; index++) {
      if (change.insert.charCodeAt(index) === 10) next.push(change.from + index + 1);
    }
    for (let index = suffixStart; index < starts.length; index++) next.push(starts[index] + delta);
    starts = next;
  }
  return starts;
}

function upperBound(values: readonly number[], value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function normalizedOffsetToPosition(lineStarts: number[], offset: number): vscode.Position {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return new vscode.Position(low, offset - lineStarts[low]);
}

/** Apply one CodeMirror transaction, whose ranges are based on the same input text. */
function applyChanges(text: string, changes: SourceChange[]): string | undefined {
  const ordered = [...changes].sort((a, b) => b.from - a.from);
  let priorFrom = text.length + 1;
  for (const change of ordered) {
    if (change.to > text.length || change.to > priorFrom) return undefined;
    priorFrom = change.from;
  }
  for (const change of ordered) text = text.slice(0, change.from) + change.insert + text.slice(change.to);
  return text;
}

function recoveryChangesToSet(changes: SourceChange[], length: number): ChangeSet {
  return sourceChangesToSet([...changes].sort((a, b) => a.from - b.from || a.to - b.to), length);
}
