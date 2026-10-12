import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { DocumentBridge } from './documentBridge';
import { isAbsoluteLocalPath, readCustomCss, readCustomCssPath, readSettings } from './configuration';
import { isDocumentReadonly } from './documentAccess';
import { WebviewMessage, isPermittedImageSource, isWebviewMessage } from './protocol';
import { documentDirectory, isUriWithin } from './resources';

type EditorAction = 'toggleSource' | 'bold' | 'italic' | 'inlineCode' | 'insertLink' | 'undo' | 'redo' | 'save' | 'openInTextEditor';
type EditorClient = { panel: vscode.WebviewPanel; document: vscode.TextDocument; sessionId: string; bridgeClient: { panel: vscode.WebviewPanel; sessionId: string; ready: boolean }; pendingCommands: EditorAction[]; pendingCommandOverflow: boolean; resourceRequests: Set<string>; cssWatcher?: vscode.FileSystemWatcher; customCss?: string; allowRemoteImages?: boolean; trusted?: boolean };
type PendingAction = { action: EditorAction; queuedAt: number };
const VIEW_TYPE = 'liveMarkdown.liveEditor';
const MAX_PENDING_ACTIONS = 16;
const PENDING_ACTION_TTL_MS = 10_000;

function postToPanelIfAlive(panel: vscode.WebviewPanel, message: unknown): void {
  try { void panel.webview.postMessage(message).then(undefined, () => undefined); }
  catch { /* Panel disposal can race a final visibility notification. */ }
}

export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider, vscode.Disposable {
  private bridges = new Map<vscode.TextDocument, DocumentBridge>();
  private clients = new Set<EditorClient>();
  private pendingActionsByUri = new Map<string, PendingAction[]>();
  private pendingActionOverflowUris = new Set<string>();
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('liveMarkdown') || event.affectsConfiguration('editor.accessibilitySupport')) void this.refreshConfiguration();
        if (event.affectsConfiguration('security.workspace.trust')) void this.refreshConfiguration();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refreshConfiguration()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => void this.refreshConfiguration()),
    );
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    let panelDisposed = false;
    const disposalGuard = panel.onDidDispose(() => { panelDisposed = true; });
    const readonly = await isDocumentReadonly(document.uri);
    if (panelDisposed) return;

    const root = vscode.workspace.getWorkspaceFolder(document.uri);
    const roots: vscode.Uri[] = [this.context.extensionUri];
    if (root) roots.push(root.uri);
    else if (document.uri.scheme !== 'untitled') roots.push(documentDirectory(document.uri));
    panel.webview.options = { enableScripts: true, localResourceRoots: roots };
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const bridgeClient = { panel, sessionId, ready: false, recoveryId: undefined as string | undefined };
    const documentKey = document.uri.toString();
    const pendingCommands = (this.pendingActionsByUri.get(documentKey) ?? [])
      .filter(pending => Date.now() - pending.queuedAt <= PENDING_ACTION_TTL_MS)
      .map(pending => pending.action);
    this.pendingActionsByUri.delete(documentKey);
    const client: EditorClient = { panel, document, sessionId, bridgeClient, pendingCommands, pendingCommandOverflow: this.pendingActionOverflowUris.delete(documentKey), resourceRequests: new Set() };
    client.allowRemoteImages = vscode.workspace.isTrusted && readSettings(document.uri).allowRemoteImages;
    client.trusted = vscode.workspace.isTrusted;
    let actionTail = Promise.resolve();
    this.clients.add(client);
    this.watchCustomCss(client, root);
    let bridge = this.bridges.get(document);
    if (!bridge) {
      bridge = new DocumentBridge(document, this.context.workspaceState);
      this.bridges.set(document, bridge);
    }
    bridge.add(bridgeClient);
    const visibilityDisposable = panel.onDidChangeViewState(event => {
      if (!event.webviewPanel.visible) bridgeClient.ready = false;
      postToPanelIfAlive(panel, { type: 'visibility', visible: event.webviewPanel.visible });
    });
    const messageDisposable = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (panelDisposed) return;
      try {
        if (!isWebviewMessage(message) || message.sessionId !== sessionId) return;
        const m: WebviewMessage = message;
        if (m.type === 'ready') {
          await bridge?.prepareRecoveryClient(bridgeClient, m.recoveryId);
          const settings = readSettings(document.uri);
          const customCss = await this.loadCustomCss(client, root);
          let recoveredDraft = await bridge?.recoveredDraft(bridgeClient);
          const committed = document.getText().replace(/\r\n/g, '\n');
          if (recoveredDraft === committed) {
            await bridge?.clearStaleRecoveryIfCommitted(bridgeClient);
            recoveredDraft = undefined;
          }
          if (panelDisposed) return;
          await panel.webview.postMessage({
            type: 'initialize', sessionId, recoveryId: bridgeClient.recoveryId!, text: document.getText(), version: document.version,
            eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n', readonly, visible: panel.visible, settings, customCss, recoveredDraft,
          });
        } else if (m.type === 'resource') {
          client.resourceRequests.add(m.requestId);
          void this.resolveResource(panel.webview, document.uri, m.requestId, m.src, () => client.resourceRequests.has(m.requestId))
            .catch(() => undefined)
            .finally(() => client.resourceRequests.delete(m.requestId));
        } else if (m.type === 'cancelResource') {
          client.resourceRequests.delete(m.requestId);
        } else if (m.type === 'followLink') {
          await this.followLink(document.uri, m.target);
        } else if (m.type === 'action') {
          actionTail = actionTail.then(async () => {
            if (m.action === 'save') {
              const saved = await document.save();
              if (!saved && !panelDisposed) postToPanelIfAlive(panel, { type: 'status', message: 'Save was cancelled. Committed edits remain in the document.' });
            } else if (m.action === 'openInTextEditor') {
              if (document.isDirty && !(await document.save())) {
                if (!panelDisposed) postToPanelIfAlive(panel, { type: 'status', message: 'Save was cancelled. Live Markdown remains open.' });
              } else if (!panelDisposed) await vscode.commands.executeCommand('workbench.action.reopenTextEditor');
            }
          }).catch(() => {
            if (!panelDisposed) postToPanelIfAlive(panel, { type: 'status', message: 'The editor action could not be completed.' });
          });
        }
        await bridge?.receive(bridgeClient, message);
        if (panelDisposed) return;
        if (m.type === 'resume') {
          const settings = readSettings(document.uri);
          const customCss = await this.loadCustomCss(client, root);
          if (panelDisposed) return;
          await panel.webview.postMessage({
            type: 'external', text: document.getText(), version: document.version,
            eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
          });
          await panel.webview.postMessage({ type: 'configuration', settings, customCss });
        }
        if ((m.type === 'ready' || m.type === 'resume') && client.pendingCommands.length) {
          for (const action of client.pendingCommands.splice(0)) await panel.webview.postMessage({ type: 'command', action });
        }
        if ((m.type === 'ready' || m.type === 'resume') && client.pendingCommandOverflow) {
          client.pendingCommandOverflow = false;
          await panel.webview.postMessage({ type: 'status', message: 'Some editor commands were not run because the pending command limit was reached. Try them again now.' });
        }
      } catch {
        if (!panelDisposed) postToPanelIfAlive(panel, { type: 'status', message: 'Live Markdown could not complete an editor message.' });
      }
    });
    if (!panelDisposed) panel.webview.html = this.getHtml(panel.webview, sessionId, client.allowRemoteImages);
    panel.onDidDispose(() => {
      disposalGuard.dispose();
      panelDisposed = true;
      messageDisposable.dispose();
      visibilityDisposable.dispose();
      client.resourceRequests.clear();
      client.cssWatcher?.dispose();
      this.clients.delete(client);
      bridge?.remove(bridgeClient);
      if (bridge && !this.clientsHasDocument(document)) {
        bridge.dispose();
        this.bridges.delete(document);
      }
    });
  }

  activePanel(): vscode.WebviewPanel | undefined {
    const clients = [...this.clients].reverse();
    const group = vscode.window.tabGroups.activeTabGroup;
    const input = group.activeTab?.input;
    if (input instanceof vscode.TabInputCustom) {
      const uri = input.uri.toString();
      // A custom editor can survive a filesystem rename while its TextDocument
      // URI is being replaced. Prefer the panel VS Code marks active in this
      // group, then fall back to URI matching for editors being restored.
      return clients.find(client => client.document.uri.toString() === uri && client.panel.active && client.panel.viewColumn === group.viewColumn)?.panel
        ?? clients.find(client => client.document.uri.toString() === uri && client.panel.active)?.panel
        ?? clients.find(client => client.document.uri.toString() === uri && client.panel.viewColumn === group.viewColumn)?.panel
        ?? clients.find(client => client.panel.active && client.panel.viewColumn === group.viewColumn)?.panel;
    }
    const activeColumn = vscode.window.activeTextEditor?.viewColumn;
    return activeColumn === undefined ? undefined : clients.find(client => client.panel.active || client.panel.viewColumn === activeColumn)?.panel;
  }

  activeDocumentUri(): vscode.Uri | undefined {
    const panel = this.activePanel();
    return [...this.clients].find(client => client.panel === panel)?.document.uri;
  }

  async action(action: 'toggleSource' | 'bold' | 'italic' | 'inlineCode' | 'insertLink' | 'undo' | 'redo' | 'save' | 'openInTextEditor'): Promise<void> {
    const panel = this.activePanel();
    if (!panel) {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      if (input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE) {
        const key = input.uri.toString();
        const now = Date.now();
        const pending = (this.pendingActionsByUri.get(key) ?? []).filter(item => now - item.queuedAt <= PENDING_ACTION_TTL_MS);
        if (pending.length < MAX_PENDING_ACTIONS) pending.push({ action, queuedAt: now });
        else this.pendingActionOverflowUris.add(key);
        this.pendingActionsByUri.set(key, pending);
      }
      return;
    }
    const client = [...this.clients].reverse().find(candidate => candidate.panel === panel);
    if (!client) return;
    if (!client.bridgeClient.ready) {
      if (client.pendingCommands.length < MAX_PENDING_ACTIONS) client.pendingCommands.push(action);
      else client.pendingCommandOverflow = true;
    }
    else await panel.webview.postMessage({ type: 'command', action });
  }

  async openInTextEditor(): Promise<void> {
    await this.action('openInTextEditor');
  }

  async refreshConfiguration(): Promise<void> {
    for (const client of this.clients) {
      const root = vscode.workspace.getWorkspaceFolder(client.document.uri);
      this.watchCustomCss(client, root);
      const allowRemoteImages = vscode.workspace.isTrusted && readSettings(client.document.uri).allowRemoteImages;
      const trusted = vscode.workspace.isTrusted;
      if (client.trusted !== trusted) client.customCss = undefined;
      if (client.allowRemoteImages !== allowRemoteImages || client.trusted !== trusted) {
        client.allowRemoteImages = allowRemoteImages;
        client.trusted = trusted;
        client.panel.webview.html = this.getHtml(client.panel.webview, client.sessionId, allowRemoteImages);
      } else {
        try {
          await client.panel.webview.postMessage({ type: 'configuration', settings: readSettings(client.document.uri), customCss: await this.loadCustomCss(client, root) });
        } catch {
          // Configuration refreshes can race with a hidden page being released or its panel closing.
        }
      }
    }
  }

  private async loadCustomCss(client: EditorClient, workspace: vscode.WorkspaceFolder | undefined): Promise<string | undefined> {
    const configured = readCustomCssPath(client.document.uri, workspace);
    const blocked = !vscode.workspace.isTrusted && !!workspace && !configured;
    const css = await readCustomCss(client.document.uri, workspace);
    if (css !== undefined) client.customCss = css;
    else if (!configured || blocked) client.customCss = undefined;
    return client.customCss;
  }

  private watchCustomCss(client: EditorClient, workspace: vscode.WorkspaceFolder | undefined): void {
    client.cssWatcher?.dispose();
    client.cssWatcher = undefined;
    const configured = readCustomCssPath(client.document.uri, workspace);
    if (!configured || (!vscode.workspace.isTrusted && workspace)) return;
    if (!isAbsoluteLocalPath(configured) && configured.split(/[\\/]/).includes('..')) return;
    let base: vscode.Uri;
    let pattern: string;
    if (isAbsoluteLocalPath(configured)) {
      const file = vscode.Uri.file(configured);
      const slash = file.path.lastIndexOf('/');
      base = file.with({ path: file.path.slice(0, slash) || '/' });
      pattern = file.path.slice(slash + 1);
    } else {
      base = workspace?.uri ?? vscode.Uri.joinPath(client.document.uri, '..');
      pattern = configured;
    }
    try {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, pattern));
      const refresh = () => void this.refreshConfiguration();
      watcher.onDidChange(refresh);
      watcher.onDidCreate(refresh);
      watcher.onDidDelete(refresh);
      client.cssWatcher = watcher;
    } catch {
      client.cssWatcher = undefined;
    }
  }

  private clientsHasDocument(document: vscode.TextDocument): boolean {
    return [...this.clients].some(client => client.document === document);
  }

  private async resolveResource(webview: vscode.Webview, docUri: vscode.Uri, requestId: string, source: string, active: () => boolean): Promise<void> {
    const reply = async (uri?: vscode.Uri, error?: string, suffix = '') => active() && webview.postMessage({ type: 'resourceResult', requestId, uri: uri ? `${webview.asWebviewUri(uri).toString()}${suffix}` : undefined, error });
    try {
      if (!active()) return;
      const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(source)?.[0].slice(0, -1).toLowerCase();
      if (scheme) {
        if (isPermittedImageSource(source, vscode.workspace.isTrusted, readSettings(docUri).allowRemoteImages)) {
          await webview.postMessage({ type: 'resourceResult', requestId, uri: source });
        } else await reply(undefined, 'Only permitted HTTPS images can be loaded.');
        return;
      }
      const suffixOffset = source.search(/[?#]/);
      const sourcePath = suffixOffset < 0 ? source : source.slice(0, suffixOffset);
      if (!sourcePath) return void await reply(undefined, 'Image path is empty.');
      const suffix = suffixOffset < 0 ? '' : source.slice(suffixOffset);
      const decodedPath = decodeURIComponent(sourcePath);
      const root = vscode.workspace.getWorkspaceFolder(docUri)?.uri ?? documentDirectory(docUri);
      const candidate = decodedPath.startsWith('/') ? vscode.Uri.joinPath(root, decodedPath.slice(1)) : vscode.Uri.joinPath(documentDirectory(docUri), decodedPath);
      if (!await isUriWithin(root, candidate)) return void await reply(undefined, 'Image is outside the document workspace.');
      if (!active()) return;
      await vscode.workspace.fs.stat(candidate);
      await reply(candidate, undefined, suffix);
    } catch {
      await reply(undefined, 'Image could not be loaded.');
    }
  }

  private async followLink(documentUri: vscode.Uri, target: string): Promise<void> {
    try {
      if (/^https?:\/\//i.test(target)) {
        const uri = vscode.Uri.parse(target);
        if (uri.scheme === 'http' || uri.scheme === 'https') await vscode.env.openExternal(uri);
        return;
      }
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('#')) return;
      const path = decodeURIComponent(target.split(/[?#]/, 1)[0]);
      if (!path) return;
      const workspaceRoot = vscode.workspace.getWorkspaceFolder(documentUri)?.uri;
      const root = workspaceRoot ?? documentDirectory(documentUri);
      const candidate = vscode.Uri.joinPath(documentDirectory(documentUri), path);
      if (!await isUriWithin(root, candidate)) return;
      const document = await vscode.workspace.openTextDocument(candidate);
      await vscode.window.showTextDocument(document, { preview: false });
    } catch {
      // Invalid or unavailable document links stay inert in the editor.
    }
  }

  private getHtml(webview: vscode.Webview, sessionId: string, allowRemoteImages = false): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const nonce = randomBytes(18).toString('base64');
    const remoteImageSource = allowRemoteImages ? ' https:' : '';
    const csp = `default-src 'none'; img-src ${webview.cspSource}${remoteImageSource}; style-src ${webview.cspSource} 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';`;
    return `<!doctype html><html data-session-id="${sessionId}"><head><meta charset="UTF-8"><meta name="live-markdown-nonce" content="${nonce}"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1"><link href="${webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'theme.css'))}" rel="stylesheet"><title>Live Markdown</title></head><body><div id="editor"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }

  dispose(): void {
    this.disposables.forEach(disposable => disposable.dispose());
    this.clients.forEach(client => {
      client.resourceRequests.clear();
      client.cssWatcher?.dispose();
    });
    this.bridges.forEach(bridge => bridge.dispose());
    this.bridges.clear();
  }
}
