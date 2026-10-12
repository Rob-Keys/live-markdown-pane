const vscode = require('vscode');

const viewType = 'liveMarkdown.liveEditor';

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('liveMarkdownMemoryProbe.openFixtures', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showErrorMessage('Open a folder containing generated Markdown fixtures first.');
      return;
    }
    const entries = await vscode.workspace.fs.readDirectory(folder.uri);
    const files = entries
      .filter(([name, type]) => type === vscode.FileType.File && /^doc-\d+\.md$/.test(name))
      .map(([name]) => name)
      .sort();
    if (!files.length) {
      void vscode.window.showErrorMessage('No doc-NNN.md fixtures were found in the first workspace folder.');
      return;
    }

    for (let index = 0; index < files.length; index++) {
      const uri = vscode.Uri.joinPath(folder.uri, files[index]);
      await vscode.commands.executeCommand('vscode.openWith', uri, viewType);
      if ((index + 1) % 20 === 0 || index + 1 === files.length) {
        console.log(`Live Markdown memory probe opened ${index + 1}/${files.length} custom editors.`);
      }
    }
    void vscode.window.showInformationMessage(`Opened ${files.length} Live Markdown memory fixtures.`);
  }));
}

module.exports = { activate };
