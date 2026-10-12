export type SourceChange = { from: number; to: number; insert: string };

/** Local relative image paths are resolved by the host; remote images require explicit trusted HTTPS access. */
export function isPermittedImageSource(source: string | undefined, trusted: boolean, allowRemoteImages: boolean): boolean {
  if (!source) return false;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(source)?.[0].slice(0, -1).toLowerCase();
  return scheme === undefined || (scheme === 'https' && trusted && allowRemoteImages);
}

export type WebviewMessage =
  | { type: 'ready'; sessionId: string; recoveryId: string }
  | { type: 'resume'; sessionId: string }
  | { type: 'draft'; sessionId: string; sequence: number; changes: SourceChange[] }
  | { type: 'clearDraft'; sessionId: string }
  | { type: 'edit'; sessionId: string; operationId: string; baseVersion: number; draftSequence: number; clientRevision?: number; changes: SourceChange[] }
  | { type: 'action'; sessionId: string; action: 'toggleSource' | 'bold' | 'italic' | 'inlineCode' | 'insertLink' | 'undo' | 'redo' | 'save' | 'openInTextEditor' }
  | { type: 'followLink'; sessionId: string; target: string }
  | { type: 'resource'; sessionId: string; requestId: string; src: string }
  | { type: 'cancelResource'; sessionId: string; requestId: string };

export type EditorCommand = 'toggleSource' | 'bold' | 'italic' | 'inlineCode' | 'insertLink' | 'undo' | 'redo' | 'save' | 'openInTextEditor';

export type HostMessage =
  | { type: 'initialize'; sessionId: string; recoveryId: string; text: string; version: number; eol: '\n' | '\r\n'; readonly: boolean; visible: boolean; settings: EditorSettings; customCss?: string; recoveredDraft?: string }
  | { type: 'visibility'; visible: boolean }
  | { type: 'ack'; operationId: string; version: number; clientRevision?: number; hostProcessingMs?: number; recoveryWaitMs?: number; workspaceEditMs?: number }
  | { type: 'external'; text: string; version: number; eol: '\n' | '\r\n'; baseVersion?: number; changes?: SourceChange[] }
  | { type: 'failure'; operationId?: string; message: string; draft: string; version: number }
  | { type: 'resourceResult'; requestId: string; uri?: string; error?: string }
  | { type: 'configuration'; settings: EditorSettings; customCss?: string };

export type StatusMessage = { type: 'status'; message: string };
export type CommandMessage = { type: 'command'; action: EditorCommand };

export type EditorSettings = {
  syntaxVisibility: 'activeLine' | 'activeBlock' | 'always';
  readingPreset: 'default' | 'compact' | 'comfortable';
  fontFamily: string;
  fontSize: number | null;
  lineHeight: number | null;
  contentWidth: string | number | null;
  showLineNumbers: boolean;
  renderImages: boolean;
  renderTables: boolean;
  allowRemoteImages: boolean;
  isTrusted: boolean;
  screenReaderMode: boolean;
  lineNumberStart: number;
};

export function isWebviewMessage(value: unknown): value is WebviewMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (typeof message.type !== 'string' || typeof message.sessionId !== 'string') return false;
  switch (message.type) {
    case 'ready': return typeof message.recoveryId === 'string' && /^[a-f0-9-]{16,64}$/i.test(message.recoveryId);
    case 'resume': return true;
    case 'clearDraft': return true;
    case 'draft':
      return Number.isSafeInteger(message.sequence) && (message.sequence as number) > 0 && isSourceChangeArray(message.changes);
    case 'edit':
      return typeof message.operationId === 'string' && message.operationId.length <= 128 && Number.isSafeInteger(message.baseVersion) && (message.baseVersion as number) >= 0 && Number.isSafeInteger(message.draftSequence) && (message.draftSequence as number) >= 0 && (message.clientRevision === undefined || Number.isSafeInteger(message.clientRevision) && (message.clientRevision as number) > 0) && isSourceChangeArray(message.changes);
    case 'action': return ['toggleSource', 'bold', 'italic', 'inlineCode', 'insertLink', 'undo', 'redo', 'save', 'openInTextEditor'].includes(String(message.action));
    case 'followLink': return typeof message.target === 'string' && message.target.length <= 8192;
    case 'resource': return typeof message.requestId === 'string' && message.requestId.length <= 128 && typeof message.src === 'string' && message.src.length <= 8192;
    case 'cancelResource': return typeof message.requestId === 'string' && message.requestId.length <= 128;
    default: return false;
  }
}

export function isHostMessage(value: unknown): value is HostMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'initialize':
      return typeof value.sessionId === 'string' && value.sessionId.length <= 128
        && typeof value.recoveryId === 'string' && /^[a-f0-9-]{16,64}$/i.test(value.recoveryId)
        && typeof value.text === 'string' && isVersion(value.version)
        && isEol(value.eol) && typeof value.readonly === 'boolean' && typeof value.visible === 'boolean' && isEditorSettings(value.settings)
        && (value.customCss === undefined || typeof value.customCss === 'string' && value.customCss.length <= 256 * 1024)
        && (value.recoveredDraft === undefined || typeof value.recoveredDraft === 'string');
    case 'visibility': return typeof value.visible === 'boolean';
    case 'ack':
      return typeof value.operationId === 'string' && value.operationId.length <= 128
        && isVersion(value.version)
        && (value.clientRevision === undefined || isVersion(value.clientRevision) && value.clientRevision > 0)
        && isTiming(value.hostProcessingMs)
        && isTiming(value.recoveryWaitMs)
        && isTiming(value.workspaceEditMs);
    case 'external':
      return typeof value.text === 'string' && isVersion(value.version) && isEol(value.eol)
        && (value.baseVersion === undefined || isVersion(value.baseVersion))
        && (value.changes === undefined || isSourceChangeArray(value.changes, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
    case 'failure':
      return (value.operationId === undefined || typeof value.operationId === 'string' && value.operationId.length <= 128)
        && typeof value.message === 'string' && value.message.length <= 10000
        && typeof value.draft === 'string' && isVersion(value.version);
    case 'resourceResult':
      return typeof value.requestId === 'string' && value.requestId.length <= 128
        && (value.uri === undefined || typeof value.uri === 'string' && value.uri.length <= 8192)
        && (value.error === undefined || typeof value.error === 'string' && value.error.length <= 10000);
    case 'configuration':
      return isEditorSettings(value.settings)
        && (value.customCss === undefined || typeof value.customCss === 'string' && value.customCss.length <= 256 * 1024);
    default: return false;
  }
}

export function isStatusMessage(value: unknown): value is StatusMessage {
  return isRecord(value) && value.type === 'status' && typeof value.message === 'string' && value.message.length <= 10000;
}

export function isCommandMessage(value: unknown): value is CommandMessage {
  return isRecord(value) && value.type === 'command' && isEditorCommand(value.action);
}

function isEditorSettings(value: unknown): value is EditorSettings {
  if (!isRecord(value)) return false;
  return ['activeLine', 'activeBlock', 'always'].includes(String(value.syntaxVisibility))
    && ['default', 'compact', 'comfortable'].includes(String(value.readingPreset))
    && typeof value.fontFamily === 'string' && value.fontFamily.length <= 4096
    && (value.fontSize === null || typeof value.fontSize === 'number' && Number.isFinite(value.fontSize) && value.fontSize >= 10 && value.fontSize <= 32)
    && (value.lineHeight === null || typeof value.lineHeight === 'number' && Number.isFinite(value.lineHeight) && value.lineHeight >= 1.2 && value.lineHeight <= 2.2)
    && (value.contentWidth === null || value.contentWidth === 'full' || typeof value.contentWidth === 'number' && Number.isFinite(value.contentWidth) && value.contentWidth >= 40 && value.contentWidth <= 120)
    && typeof value.showLineNumbers === 'boolean' && typeof value.renderImages === 'boolean'
    && typeof value.renderTables === 'boolean' && typeof value.allowRemoteImages === 'boolean'
    && typeof value.isTrusted === 'boolean' && typeof value.screenReaderMode === 'boolean'
    && Number.isSafeInteger(value.lineNumberStart) && (value.lineNumberStart as number) >= 1;
}

function isEditorCommand(value: unknown): value is EditorCommand {
  return ['toggleSource', 'bold', 'italic', 'inlineCode', 'insertLink', 'undo', 'redo', 'save', 'openInTextEditor'].includes(String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTiming(value: unknown): boolean {
  return value === undefined || typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 60_000;
}

function isVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isEol(value: unknown): value is '\n' | '\r\n' {
  return value === '\n' || value === '\r\n';
}

function isSourceChange(change: unknown, maxInsert = 1024 * 1024): change is SourceChange {
  if (!change || typeof change !== 'object') return false;
  const item = change as Record<string, unknown>;
  return Number.isSafeInteger(item.from) && Number.isSafeInteger(item.to) && (item.from as number) >= 0 && (item.to as number) >= (item.from as number) && typeof item.insert === 'string' && item.insert.length <= maxInsert;
}

function isSourceChangeArray(value: unknown, maxChanges = 1024, maxPayload = 2 * 1024 * 1024, maxInsert = 1024 * 1024): value is SourceChange[] {
  if (!Array.isArray(value) || value.length > maxChanges || !value.every(change => isSourceChange(change, maxInsert))) return false;
  let payloadSize = 0;
  for (const change of value) {
    payloadSize += change.insert.length + change.to - change.from;
    if (payloadSize > maxPayload) return false;
  }
  return true;
}
