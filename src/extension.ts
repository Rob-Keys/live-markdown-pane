import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './markdownEditorProvider';
import { settingsScopeChoices, SettingsScopeChoice } from './configuration';

const VIEW_TYPE = 'liveMarkdown.liveEditor';

async function chooseSettingsScope(uri: vscode.Uri | undefined): Promise<SettingsScopeChoice | undefined> {
  const folder = uri ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
  const choices = settingsScopeChoices(Boolean(vscode.workspace.workspaceFile), vscode.workspace.workspaceFolders ?? [], folder?.uri);
  if (choices.length === 1) return choices[0];
  const selected = await vscode.window.showQuickPick(choices, {
    title: 'Choose where to apply Live Markdown settings',
    placeHolder: 'Settings scope',
  });
  return selected;
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new MarkdownEditorProvider(context);
  context.subscriptions.push(provider, vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
    // Hidden editor views restore from their TextDocument and durable draft journal.
    // Releasing the page context keeps large tab sets from retaining one full webview per file.
    webviewOptions: { retainContextWhenHidden: false },
    supportsMultipleEditorsPerDocument: true,
  }));

  const registerAction = (command: string, action: Parameters<MarkdownEditorProvider['action']>[0]) => {
    context.subscriptions.push(vscode.commands.registerCommand(command, () => provider.action(action)));
  };
  registerAction('liveMarkdown.toggleSource', 'toggleSource');
  registerAction('liveMarkdown.bold', 'bold');
  registerAction('liveMarkdown.italic', 'italic');
  registerAction('liveMarkdown.inlineCode', 'inlineCode');
  registerAction('liveMarkdown.insertLink', 'insertLink');
  registerAction('liveMarkdown.save', 'save');
  registerAction('liveMarkdown.undo', 'undo');
  registerAction('liveMarkdown.redo', 'redo');
  context.subscriptions.push(
    vscode.commands.registerCommand('liveMarkdown.newDocument', async () => {
      const uri = vscode.Uri.parse(`untitled:${encodeURIComponent(`Untitled-${Date.now()}.md`)}`);
      try {
        await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
      } catch (error) {
        const choice = await vscode.window.showErrorMessage(`Could not open the untitled Markdown document in Live Markdown: ${String(error)}`, 'Open in Text Editor');
        if (choice) await vscode.commands.executeCommand('vscode.open', uri);
      }
    }),
    vscode.commands.registerCommand('liveMarkdown.openInTextEditor', () => provider.openInTextEditor()),
    vscode.commands.registerCommand('liveMarkdown.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:live-markdown.live-markdown')),
    vscode.commands.registerCommand('liveMarkdown.chooseReadingPreset', async () => {
      const selected = await vscode.window.showQuickPick([
        { label: 'Default', value: 'default', description: '16 px · 1.6 · 80 ch' },
        { label: 'Compact', value: 'compact', description: '14 px · 1.45 · 100 ch' },
        { label: 'Comfortable', value: 'comfortable', description: '18 px · 1.75 · 72 ch' },
      ], { placeHolder: 'Choose a reading preset' });
      if (!selected) return;
      const uri = provider.activeDocumentUri();
      const target = await chooseSettingsScope(uri);
      if (!target) return;
      await vscode.workspace.getConfiguration('liveMarkdown', target.scopeUri ?? uri).update('readingPreset', selected.value, target.target);
    }),
    vscode.commands.registerCommand('liveMarkdown.resetAppearance', async () => {
      const uri = provider.activeDocumentUri();
      const target = await chooseSettingsScope(uri);
      if (!target) return;
      const config = vscode.workspace.getConfiguration('liveMarkdown', target.scopeUri ?? uri);
      for (const key of ['syntaxVisibility', 'readingPreset', 'fontFamily', 'fontSize', 'lineHeight', 'contentWidth', 'showLineNumbers', 'lineNumberStart', 'renderImages', 'renderTables', 'customCss', 'allowRemoteImages']) await config.update(key, undefined, target.target);
    }),
  );
}

export function deactivate(): void {}
