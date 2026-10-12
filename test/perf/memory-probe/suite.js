const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs/promises');

const viewType = 'liveMarkdown.liveEditor';
const mode = process.env.LIVE_MARKDOWN_MEMORY_MODE ?? 'live';
if (!['live', 'native'].includes(mode)) throw new Error('LIVE_MARKDOWN_MEMORY_MODE must be live or native.');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixtureTabCount = (folder, files) => {
  const fixtureUris = new Set(files.map(name => vscode.Uri.joinPath(folder.uri, name).toString()));
  return vscode.window.tabGroups.all
  .flatMap(group => group.tabs)
  .filter(tab => fixtureUris.has(tab.input.uri?.toString()) && (mode === 'native'
    ? tab.input instanceof vscode.TabInputText
    : tab.input instanceof vscode.TabInputCustom && tab.input.viewType === viewType))
  .length;
};

async function waitFor(predicate, timeoutMs = 10_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for memory-probe editor tabs to close.');
    await delay(50);
  }
}

async function setSamplePhase(phase, count) {
  const markerFile = process.env.LIVE_MARKDOWN_MEMORY_PHASE_FILE;
  if (markerFile) await fs.writeFile(markerFile, JSON.stringify({ phase, count }));
}

async function run() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('Open the generated memory-fixture folder first.');
  const entries = await vscode.workspace.fs.readDirectory(folder.uri);
  const files = entries
    .filter(([name, type]) => type === vscode.FileType.File && /^doc-\d+\.md$/.test(name))
    .map(([name]) => name)
    .sort();
  if (!files.length) throw new Error('No doc-NNN.md fixtures were found.');

  await setSamplePhase('blank', 0);
  console.log('LIVE_MARKDOWN_MEMORY_SAMPLE blank-ready');
  const blankHoldMs = Number(process.env.LIVE_MARKDOWN_MEMORY_BLANK_HOLD_MS ?? 10_000);
  await delay(Number.isFinite(blankHoldMs) ? Math.max(0, blankHoldMs) : 10_000);
  await setSamplePhase('opening', 0);
  for (let index = 0; index < files.length; index++) {
    const uri = vscode.Uri.joinPath(folder.uri, files[index]);
    await vscode.commands.executeCommand('vscode.openWith', uri, mode === 'native' ? 'default' : viewType);
    const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const expectedEditor = mode === 'native'
      ? active instanceof vscode.TabInputText
      : active instanceof vscode.TabInputCustom && active.viewType === viewType;
    if (!expectedEditor || active.uri.toString() !== uri.toString()) {
      throw new Error(`VS Code did not activate the ${mode} editor for ${path.basename(uri.fsPath)}.`);
    }
    if ((index + 1) % 20 === 0 || index + 1 === files.length) {
      console.log(`LIVE_MARKDOWN_MEMORY_PROGRESS ${index + 1}/${files.length}`);
    }
  }

  if (fixtureTabCount(folder, files) !== files.length) {
    throw new Error(`Expected ${files.length} open ${mode} fixture tabs; found ${fixtureTabCount(folder, files)}.`);
  }
  await setSamplePhase('open', files.length);
  console.log(`LIVE_MARKDOWN_MEMORY_SAMPLE editors-open count=${files.length}`);
  const holdMs = Number(process.env.LIVE_MARKDOWN_MEMORY_HOLD_MS ?? 60_000);
  await delay(Number.isFinite(holdMs) ? Math.max(0, holdMs) : 60_000);
  await setSamplePhase('closing', files.length);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitFor(() => fixtureTabCount(folder, files) === 0);
  await setSamplePhase('closed', files.length);
  console.log('LIVE_MARKDOWN_MEMORY_SAMPLE editors-closed');
  const closedHoldMs = Number(process.env.LIVE_MARKDOWN_MEMORY_CLOSED_HOLD_MS ?? 30_000);
  await delay(Number.isFinite(closedHoldMs) ? Math.max(0, closedHoldMs) : 30_000);
  await setSamplePhase('done', files.length);
}

module.exports = { run };
