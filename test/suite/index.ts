import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { strict as assert } from 'node:assert';
import { DocumentBridge } from '../../src/documentBridge';
import { isDocumentReadonly } from '../../src/documentAccess';
import { ChangeSet, EditorSelection, EditorState } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { changeSetToSourceChanges, changesOverlap, composeChangeSets, sourceChangesToSet } from '../../src/rebase';
import { isAbsoluteLocalPath, restrictedWorkspaceCssPath, screenReaderModeEnabled, settingsScopeChoices, stripCssImports } from '../../src/configuration';
import { changesMayAffectReferenceDefinitions, linkTarget, referenceDefinitions } from '../../src/webview/references';
import { changesMayAffectTableSyntax, isTableWidgetEligible, readImage, tableCellRuns, tableNodeAt, tableSelectionKey, visibleTableNodes } from '../../src/webview/liveRendering';
import { TableWidget, tableLinkKeyboardIntent } from '../../src/webview/widgets';
import { markdownBackspaceEdit, markdownEnterEdit } from '../../src/webview/listEditing';
import { CompositionGate } from '../../src/webview/composition';
import { documentByteSize, documentBytes, REDUCED_RENDERING_BYTES, shouldOpenInSourceMode, shouldReduceRendering, shouldUseMarkdownLanguage, sourceChangesByteSize, utf8ByteLength } from '../../src/webview/documentMetrics';
import { effectiveSyntaxVisibility, renderingWhenVisible, shouldRenderTableWidget } from '../../src/webview/renderingVisibility';
import { isHostMessage, isPermittedImageSource, isWebviewMessage } from '../../src/protocol';
import { isUriWithin } from '../../src/resources';

const VIEW_TYPE = 'liveMarkdown.liveEditor';

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10000): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for editor state.');
    await delay(25);
  }
}

export async function run(): Promise<void> {
  const testFilter = process.env.LIVE_MARKDOWN_TEST_FILTER;
  async function runCase(name: string, body: (dir: string) => Promise<void>): Promise<void> {
    if (testFilter && !name.toLowerCase().includes(testFilter.toLowerCase())) return;
    console.log(`START ${name}`);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'live-markdown-test-'));
    try {
      await body(tempDir);
      console.log(`PASS ${name}`);
    } catch (error) {
      console.error(`FAIL ${name}`, error);
      throw error;
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  await runCase('presentation changes wait for IME composition and coalesce', async () => {
      const gate = new CompositionGate();
      let refreshes = 0;
      if (gate.requestRefresh()) refreshes++;
      assert.equal(refreshes, 1, 'presentation changes run immediately outside composition');
      gate.start();
      assert.equal(gate.requestRefresh(), false);
      assert.equal(gate.requestRefresh(), false);
      assert.equal(refreshes, 1, 'presentation changes do not run during composition');
      assert.equal(gate.isActive(), true);
      assert.equal(gate.finish(), true, 'composition end signals one coalesced refresh');
      assert.equal(gate.isActive(), false);
      if (gate.requestRefresh()) refreshes++;
      assert.equal(refreshes, 2, 'subsequent changes run immediately');
      assert.equal(gate.finish(), false, 'composition end without pending changes needs no refresh');
  });

  await runCase('hidden webviews do not construct rendering extensions during restore', async () => {
      let constructed = false;
      const hidden = renderingWhenVisible(false, () => { constructed = true; return ['decorations']; });
      assert.deepEqual(hidden, []);
      assert.equal(constructed, false, 'restoring source mode in a hidden panel must not restart decorations');
      assert.deepEqual(renderingWhenVisible(true, () => ['decorations']), ['decorations']);
  });

  await runCase('extension manifest keeps Markdown editing available in Restricted Mode', async () => {
      const extension = vscode.extensions.getExtension('RobKeys.live-markdown-pane');
      assert.equal(extension?.packageJSON.capabilities?.untrustedWorkspaces?.supported, true);
      const properties = extension?.packageJSON.contributes.configuration.properties as Record<string, { scope?: string }>;
      for (const name of ['syntaxVisibility', 'readingPreset', 'fontFamily', 'fontSize', 'lineHeight', 'contentWidth', 'showLineNumbers', 'lineNumberStart', 'renderImages', 'renderTables', 'customCss', 'allowRemoteImages']) {
        assert.equal(properties[`liveMarkdown.${name}`]?.scope, 'resource', `${name} must support document-resource configuration`);
      }
  });

  await runCase('Restricted Mode accepts only an explicit absolute user stylesheet', async () => {
      assert.equal(restrictedWorkspaceCssPath('/Users/example/live-markdown.css'), '/Users/example/live-markdown.css');
      assert.equal(restrictedWorkspaceCssPath('C:\\Users\\example\\live-markdown.css'), 'C:\\Users\\example\\live-markdown.css');
      assert.equal(restrictedWorkspaceCssPath('\\\\server\\share\\live-markdown.css'), '\\\\server\\share\\live-markdown.css');
      assert.equal(restrictedWorkspaceCssPath('styles/live-markdown.css'), '');
      assert.equal(restrictedWorkspaceCssPath(undefined), '');
      assert.equal(isAbsoluteLocalPath('\\\\server\\share\\live-markdown.css'), true);
      assert.equal(isAbsoluteLocalPath('server\\share\\live-markdown.css'), false);
  });

  await runCase('explicit VS Code screen-reader mode reveals Markdown syntax', async () => {
      assert.equal(screenReaderModeEnabled('on'), true);
      assert.equal(screenReaderModeEnabled('auto'), false);
      assert.equal(screenReaderModeEnabled('off'), false);
      assert.equal(screenReaderModeEnabled(undefined), false);
      assert.equal(effectiveSyntaxVisibility(false, true, 'activeLine'), 'always');
      assert.equal(effectiveSyntaxVisibility(false, true, 'activeBlock'), 'always');
      assert.equal(effectiveSyntaxVisibility(false, false, 'activeLine'), 'activeLine');
      assert.equal(effectiveSyntaxVisibility(true, false, 'activeLine'), 'always');
      assert.equal(shouldRenderTableWidget(false, true, 'activeLine', false, false), false, 'screen-reader mode must preserve editable table source');
      assert.equal(shouldRenderTableWidget(false, false, 'activeLine', false, false), true, 'inactive tables may render in ordinary reading mode');
      assert.equal(shouldRenderTableWidget(false, false, 'activeLine', true, false), false, 'entering a table reveals its source rows');
      assert.equal(shouldRenderTableWidget(false, false, 'activeLine', false, true), false, 'selecting table source keeps its source positions visible');
  });

  await runCase('remote images require trusted opt-in HTTPS while local paths remain eligible', async () => {
      assert.equal(isPermittedImageSource('images/photo.png', false, false), true);
      assert.equal(isPermittedImageSource('../photo.png', true, false), true, 'host containment still validates local paths');
      assert.equal(isPermittedImageSource('https://example.com/photo.png', false, true), false);
      assert.equal(isPermittedImageSource('https://example.com/photo.png', true, false), false);
      assert.equal(isPermittedImageSource('https://example.com/photo.png', true, true), true);
      assert.equal(isPermittedImageSource('http://example.com/photo.png', true, true), false);
      assert.equal(isPermittedImageSource('file:///tmp/photo.png', true, true), false);
      assert.equal(isPermittedImageSource('javascript:alert(1)', true, true), false);
      assert.equal(isPermittedImageSource(undefined, true, true), false);
  });

  await runCase('resource containment rejects prefix lookalikes, other authorities, and symlink escapes', async tempDir => {
      const workspace = path.join(tempDir, 'workspace');
      const sibling = path.join(tempDir, 'workspace-escape');
      const outside = path.join(tempDir, 'outside');
      await Promise.all([fs.mkdir(workspace), fs.mkdir(sibling), fs.mkdir(outside)]);
      await fs.writeFile(path.join(workspace, 'inside.png'), 'inside');
      await fs.writeFile(path.join(sibling, 'outside.png'), 'sibling');
      await fs.writeFile(path.join(outside, 'secret.png'), 'outside');
      const root = vscode.Uri.file(workspace);
      assert.equal(await isUriWithin(root, vscode.Uri.file(path.join(workspace, 'inside.png'))), true);
      assert.equal(await isUriWithin(root, vscode.Uri.file(path.join(sibling, 'outside.png'))), false);
      assert.equal(await isUriWithin(root, vscode.Uri.file(path.join(outside, 'secret.png'))), false);
      const differentlyCasedWorkspace = path.join(tempDir, 'WORKSPACE');
      let caseInsensitivePathExists = false;
      try {
        await fs.stat(path.join(differentlyCasedWorkspace, 'inside.png'));
        caseInsensitivePathExists = true;
      } catch { /* The path does not exist on case-sensitive filesystems. */ }
      if (caseInsensitivePathExists) {
        assert.equal(await isUriWithin(vscode.Uri.file(differentlyCasedWorkspace), vscode.Uri.file(path.join(differentlyCasedWorkspace, 'inside.png'))), true,
          'valid local paths with a different case should work on case-insensitive filesystems');
      }

      const remoteRoot = vscode.Uri.parse('vscode-remote://ssh-remote+host/workspace');
      assert.equal(await isUriWithin(remoteRoot, vscode.Uri.parse('vscode-remote://ssh-remote+host/workspace/images/photo.png')), true);
      assert.equal(await isUriWithin(remoteRoot, vscode.Uri.parse('vscode-remote://other-host/workspace/images/photo.png')), false);
      assert.equal(await isUriWithin(remoteRoot, vscode.Uri.parse('vscode-remote://ssh-remote+host/workspace-escape/photo.png')), false);

      let symlinkCreated = false;
      try { await fs.symlink(outside, path.join(workspace, 'linked'), 'dir'); symlinkCreated = true; }
      catch (error) { if (process.platform !== 'win32') throw error; }
      if (symlinkCreated) assert.equal(await isUriWithin(root, vscode.Uri.file(path.join(workspace, 'linked', 'secret.png'))), false);
  });

  await runCase('host visibility messages are validated and initialization carries panel state', async () => {
      const settings = {
        syntaxVisibility: 'activeLine', readingPreset: 'default', fontFamily: 'inherit', fontSize: null,
        lineHeight: null, contentWidth: null, showLineNumbers: false, renderImages: true,
        renderTables: true, allowRemoteImages: false, isTrusted: false, screenReaderMode: false, lineNumberStart: 1,
      };
      assert.equal(isHostMessage({ type: 'visibility', visible: false }), true);
      assert.equal(isHostMessage({ type: 'visibility', visible: true }), true);
      assert.equal(isHostMessage({ type: 'visibility', visible: 'false' }), false);
      assert.equal(isHostMessage({ type: 'ack', operationId: 'op', version: 1, clientRevision: 4, hostProcessingMs: 0.1, recoveryWaitMs: 2, workspaceEditMs: 3 }), true);
      assert.equal(isHostMessage({ type: 'ack', operationId: 'op', version: 1, hostProcessingMs: -1 }), false);
      assert.equal(isHostMessage({ type: 'ack', operationId: 'op', version: 1, workspaceEditMs: -1 }), false);
      assert.equal(isHostMessage({ type: 'ack', operationId: 'op', version: 1, clientRevision: 0 }), false);
      assert.equal(isWebviewMessage({ type: 'edit', sessionId: 'session', operationId: 'op', baseVersion: 0, draftSequence: 1, clientRevision: 1, changes: [] }), true);
      assert.equal(isWebviewMessage({ type: 'edit', sessionId: 'session', operationId: 'op', baseVersion: 0, draftSequence: 1, clientRevision: 0, changes: [] }), false);
      assert.equal(isWebviewMessage({ type: 'resume', sessionId: 'session' }), true);
      const initialize = {
        type: 'initialize', sessionId: 'session', recoveryId: '0123456789abcdef', text: '', version: 0,
        eol: '\n', readonly: false, visible: true, settings,
      };
      assert.equal(isHostMessage(initialize), true);
      assert.equal(isHostMessage({ ...initialize, visible: undefined }), false);
  });

  await runCase('large-document thresholds use UTF-8 bytes and track edits', async () => {
      const state = EditorState.create({ doc: 'a😀é', extensions: [documentByteSize] });
      assert.equal(documentBytes(state), utf8ByteLength('a😀é'));
      assert.equal(shouldReduceRendering(state), false);
      const edited = state.update({ changes: { from: 1, to: 3, insert: 'xy' } }).state;
      assert.equal(documentBytes(edited), utf8ByteLength('axyé'));
      assert.equal(sourceChangesByteSize([{ from: 1, to: 3, insert: 'é😀' }], (from, to) => state.sliceDoc(from, to)), utf8ByteLength('😀') + utf8ByteLength('é😀'));
      const nearLimit = EditorState.create({ doc: 'a'.repeat(REDUCED_RENDERING_BYTES - 3), extensions: [documentByteSize] });
      assert.equal(shouldReduceRendering(nearLimit), false);
      const overLimit = nearLimit.update({ changes: { from: 0, to: 0, insert: '😀' } }).state;
      assert.equal(documentBytes(overLimit), REDUCED_RENDERING_BYTES + 1);
      assert.equal(shouldReduceRendering(overLimit), true);
      const largeUnicode = '😀'.repeat(1_310_721);
      assert.ok(largeUnicode.length < 5 * 1024 * 1024, 'UTF-16 length stays below five MiB');
      assert.equal(shouldOpenInSourceMode(largeUnicode), true, 'UTF-8 byte size crosses five MiB');
      assert.equal(shouldUseMarkdownLanguage(true, true), false, 'large documents in source mode skip the Markdown parser');
      assert.equal(shouldUseMarkdownLanguage(true, false), true, 'explicitly returning to rendered mode restores Markdown parsing');
      assert.equal(shouldUseMarkdownLanguage(false, true), true, 'ordinary source mode keeps Markdown editing behavior');
  });

  await runCase('table invalidation skips unrelated text edits but catches pipe and row-boundary changes', async () => {
      const plain = EditorState.create({ doc: 'A plain paragraph.\nAnother line.' });
      assert.equal(changesMayAffectTableSyntax(plain.update({ changes: { from: 3, to: 3, insert: 'x' } })), false);
      assert.equal(changesMayAffectTableSyntax(plain.update({ changes: { from: 3, to: 3, insert: '|' } })), true);

      const table = EditorState.create({ doc: '| A | B |\n|---|---|\n| 1 | 2 |' });
      const headerBreak = table.doc.line(1).to;
      assert.equal(changesMayAffectTableSyntax(table.update({ changes: { from: headerBreak, to: headerBreak + 1, insert: '' } })), true);
      const cellText = table.doc.line(1).from + 2;
      assert.equal(changesMayAffectTableSyntax(table.update({ changes: { from: cellText, to: cellText + 1, insert: 'C' } })), true);
  });

  await runCase('table widgets are discovered only in requested viewport ranges', async () => {
      const source = Array.from({ length: 30 }, (_, index) => `| H${index} |\n|---|\n| V${index} |`).join('\n\n');
      const state = EditorState.create({ doc: source, extensions: [markdown({ extensions: GFM })] });
      const parsed = ensureSyntaxTree(state, state.doc.length, 10_000);
      assert.ok(parsed && parsed.length === state.doc.length, 'the small viewport fixture should parse completely');
      const allTables: Array<{ from: number; to: number }> = [];
      parsed.iterate({ enter: node => { if (node.name === 'Table') allTables.push({ from: node.from, to: node.to }); } });
      assert.equal(allTables.length, 30);
      const target = allTables[18];
      assert.deepEqual(visibleTableNodes(state, [target]).map(node => node.from), [target.from]);
      assert.deepEqual(visibleTableNodes(state, [target, { from: target.from + 1, to: target.to }]).map(node => node.from), [target.from]);
  });

  await runCase('large tables stay as source when their widget would be expensive', async () => {
      const small = EditorState.create({ doc: '| A |\n|---|\n| B |', extensions: [markdown({ extensions: GFM })] });
      ensureSyntaxTree(small, small.doc.length, 10_000);
      let smallTable: { from: number; to: number } | undefined;
      syntaxTree(small).iterate({ enter: node => { if (node.name === 'Table') smallTable = node; } });
      assert.ok(smallTable);
      assert.equal(isTableWidgetEligible(smallTable, 3), true);

      const source = `| A | B |\n|---|---|\n${Array.from({ length: 300 }, (_, index) => `| ${index} | value ${index} |`).join('\n')}`;
      const large = EditorState.create({ doc: source, extensions: [markdown({ extensions: GFM })] });
      ensureSyntaxTree(large, large.doc.length, 10_000);
      let largeTable: { from: number; to: number } | undefined;
      syntaxTree(large).iterate({ enter: node => { if (node.name === 'Table') largeTable = node; } });
      assert.ok(largeTable);
      assert.equal(isTableWidgetEligible(largeTable, 302), false);
  });

  await runCase('custom CSS strips imports without altering comments or strings', async () => {
      const source = '@IMPORT url(https://example.invalid/a.css); .kept { color: red; } @im\\70 ort"local.css"; .next { color: blue; } .text::after { content: "@import \"x.css\";"; } /* @import ignored.css; */';
      const expected = ' .kept { color: red; }  .next { color: blue; } .text::after { content: "@import \"x.css\";"; } /* @import ignored.css; */';
      assert.equal(stripCssImports(source), expected);
  });

  await runCase('configuration commands offer only applicable settings scopes', async () => {
      const docs = vscode.Uri.file('/workspace/docs');
      const apps = vscode.Uri.file('/workspace/apps');
      const folders = [{ name: 'docs', uri: docs }, { name: 'apps', uri: apps }];
      assert.deepEqual(settingsScopeChoices(false, folders, docs).map(choice => choice.target), [
        vscode.ConfigurationTarget.WorkspaceFolder,
        vscode.ConfigurationTarget.Global,
      ]);
      assert.equal(settingsScopeChoices(false, folders, docs)[0].scopeUri?.toString(), docs.toString());
      assert.deepEqual(settingsScopeChoices(true, folders, docs).map(choice => choice.target), [
        vscode.ConfigurationTarget.Workspace,
        vscode.ConfigurationTarget.WorkspaceFolder,
        vscode.ConfigurationTarget.Global,
      ]);
      assert.deepEqual(settingsScopeChoices(true, folders).map(choice => choice.label), [
        'Workspace',
        'Workspace Folder: docs',
        'Workspace Folder: apps',
        'User',
      ]);
      assert.deepEqual(settingsScopeChoices(false, []).map(choice => choice.target), [vscode.ConfigurationTarget.Global]);
      assert.deepEqual(settingsScopeChoices(false, [{ name: 'single', uri: docs }]).map(choice => choice.target), [
        vscode.ConfigurationTarget.Workspace,
        vscode.ConfigurationTarget.Global,
      ]);
      assert.deepEqual(settingsScopeChoices(true, [{ name: 'single', uri: docs }]).map(choice => choice.target), [
        vscode.ConfigurationTarget.Workspace,
        vscode.ConfigurationTarget.WorkspaceFolder,
        vscode.ConfigurationTarget.Global,
      ]);
  });

  await runCase('reference definitions resolve across the document and invalidate selectively', async () => {
      const source = `[image][late]\n${'body text\n'.repeat(80)}[late]: <assets/image%20one.png> "title"\n`;
      const state = EditorState.create({ doc: source });
      assert.equal(referenceDefinitions(state).get('late'), 'assets/image%20one.png');

      const unrelated = ChangeSet.of([{ from: 0, to: 0, insert: 'prefix\n' }], state.doc.length);
      const unrelatedState = state.update({ changes: unrelated }).state;
      assert.equal(changesMayAffectReferenceDefinitions(state.doc, unrelatedState.doc, unrelated), false);

      const targetFrom = source.indexOf('assets/image%20one.png');
      const definitionEdit = ChangeSet.of([{ from: targetFrom, to: targetFrom + 'assets/image%20one.png'.length, insert: 'assets/new.png' }], state.doc.length);
      const definitionState = state.update({ changes: definitionEdit }).state;
      assert.equal(changesMayAffectReferenceDefinitions(state.doc, definitionState.doc, definitionEdit), true);
      assert.equal(referenceDefinitions(definitionState).get('late'), 'assets/new.png');
  });

  await runCase('inline and reference links resolve destinations from their opening bracket', async () => {
      const source = '[inline](https://example.com) and [manual][docs]\n\n[docs]: ../manual.md\n';
      const state = EditorState.create({ doc: source, extensions: [markdown({ extensions: GFM })] });
      const links: Array<{ from: number; to: number }> = [];
      syntaxTree(state).iterate({ enter: node => { if (node.name === 'Link') links.push({ from: node.from, to: node.to }); } });
      assert.equal(links.length, 2);
      assert.deepEqual(links.map(link => linkTarget(state, link.from, link.to)), ['https://example.com', '../manual.md']);
  });

  await runCase('image parser keeps alt text separate from inline and reference destinations', async () => {
      const source = '![Tall image](<assets/tall image.svg>) and ![Referenced image][landscape]\n\n[landscape]: assets/landscape.svg\n';
      const state = EditorState.create({ doc: source, extensions: [markdown({ extensions: GFM })] });
      assert.ok(ensureSyntaxTree(state, source.length, 10_000), 'image syntax should parse synchronously');
      const images: import('@lezer/common').SyntaxNode[] = [];
      syntaxTree(state).iterate({ enter: node => { if (node.name === 'Image') images.push(node.node); } });
      assert.equal(images.length, 2);
      assert.deepEqual(readImage(state, images[0]), { alt: 'Tall image', source: 'assets/tall image.svg', reference: undefined });
      assert.deepEqual(readImage(state, images[1]), { alt: 'Referenced image', source: undefined, reference: 'landscape' });
  });

  await runCase('table links enter source by default and follow only on modified Enter', async () => {
      assert.equal(tableLinkKeyboardIntent({ key: 'Enter', ctrlKey: false, metaKey: false }), 'edit');
      assert.equal(tableLinkKeyboardIntent({ key: 'F2', ctrlKey: false, metaKey: false }), 'edit');
      assert.equal(tableLinkKeyboardIntent({ key: 'Enter', ctrlKey: true, metaKey: false }), 'follow');
      assert.equal(tableLinkKeyboardIntent({ key: 'Enter', ctrlKey: false, metaKey: true }), 'follow');
      assert.equal(tableLinkKeyboardIntent({ key: 'F2', ctrlKey: true, metaKey: true }), 'edit');
      assert.equal(tableLinkKeyboardIntent({ key: 'Tab', ctrlKey: false, metaKey: false }), undefined);
  });

  await runCase('table cell runs preserve inline formatting, links, and escapes', async () => {
      const source = '| value |\n| --- |\n| **bold** `code` [label](https://example.com) [project][repo] <https://example.net> escaped\\|pipe |\n\n[repo]: https://example.org\n';
      const state = EditorState.create({ doc: source, extensions: [markdown({ extensions: GFM })] });
      assert.ok(ensureSyntaxTree(state, source.length, 10_000), 'Markdown syntax should parse synchronously');
      const cells: import('@lezer/common').SyntaxNode[] = [];
      syntaxTree(state).iterate({ enter: node => { if (node.name === 'TableCell') cells.push(node.node); } });
      assert.ok(cells.length >= 2, 'GFM parser should expose header and body cells');
      const runs = tableCellRuns(state, cells[cells.length - 1]);
      assert.deepEqual(runs, [
        { text: 'bold', marks: ['strong'] },
        { text: ' ', marks: [] },
        { text: 'code', marks: ['code'] },
        { text: ' ', marks: [] },
        { text: 'label', marks: ['link'], linkTarget: 'https://example.com' },
        { text: ' ', marks: [] },
        { text: 'project', marks: ['link'], linkTarget: 'https://example.org' },
        { text: ' ', marks: [] },
        { text: 'https://example.net', marks: ['link'], linkTarget: 'https://example.net' },
        { text: ' escaped', marks: [] },
        { text: '|', marks: [] },
        { text: 'pipe', marks: [] }
      ]);
  });

  await runCase('table replacement resolves only the table at its start boundary', async () => {
      const source = '# Before\n\nIntro.\n\n| Name | State |\n| --- | --- |\n| smoke | ready |\n\nAfter text.\n';
      const state = EditorState.create({ doc: source, extensions: [markdown({ extensions: GFM })] });
      const tableStart = source.indexOf('| Name');
      const table = tableNodeAt(state, tableStart);
      assert.ok(table, 'the table should resolve when the parser starts at its first delimiter');
      assert.equal(table.name, 'Table');
      assert.equal(table.from, tableStart);
      assert.equal(state.sliceDoc(table.from, table.to), '| Name | State |\n| --- | --- |\n| smoke | ready |');
      assert.equal(tableSelectionKey(state.update({ selection: EditorSelection.cursor(table.from) }).state), `${table.from}:${table.to}`);
      assert.equal(tableSelectionKey(state.update({ selection: EditorSelection.cursor(table.to) }).state), `${table.from}:${table.to}`);
  });

  await runCase('table widgets are rebuilt when source row positions change', async () => {
      const rows = [[[{ text: 'header', marks: [] as Array<'strong' | 'emphasis' | 'code' | 'strike' | 'link'> }]]];
      const enter = (_position: number) => {};
      const oldWidget = new TableWidget(0, 20, rows, [0], [], enter);
      const shiftedWidget = new TableWidget(0, 20, rows, [5], [], enter);
      assert.equal(oldWidget.eq(shiftedWidget), false);
  });

  await runCase('Enter continues and exits ordered, task, nested, and quoted lists', async () => {
      const apply = (source: string, edit: ReturnType<typeof markdownEnterEdit>): { text: string; cursor: number } => {
        assert.ok(edit, `expected Enter behavior for ${JSON.stringify(source)}`);
        const state = EditorState.create({ doc: source });
        const updated = state.update({
          changes: { from: edit.from, to: edit.to, insert: edit.insert },
          selection: EditorSelection.cursor(edit.cursor),
        }).state;
        return { text: updated.doc.toString(), cursor: updated.selection.main.head };
      };
      const stateAtEnd = (source: string) => EditorState.create({ doc: source, selection: EditorSelection.cursor(source.length) });

      assert.deepEqual(apply('- item', markdownEnterEdit(stateAtEnd('- item'))), { text: '- item\n- ', cursor: 9 });
      assert.deepEqual(apply('3. [x] item', markdownEnterEdit(stateAtEnd('3. [x] item'))), { text: '3. [x] item\n4. [ ] ', cursor: 19 });
      assert.deepEqual(apply('> - item', markdownEnterEdit(stateAtEnd('> - item'))), { text: '> - item\n> - ', cursor: 13 });
      assert.deepEqual(apply('- ', markdownEnterEdit(stateAtEnd('- '))), { text: '\n', cursor: 1 });
      assert.deepEqual(apply('- parent\n  - ', markdownEnterEdit(stateAtEnd('- parent\n  - '))), { text: '- parent\n\n', cursor: 10 });
      assert.deepEqual(apply('- parent\n    - ', markdownEnterEdit(stateAtEnd('- parent\n    - '))), { text: '- parent\n  \n  ', cursor: 12 });
      assert.deepEqual(apply('> - ', markdownEnterEdit(stateAtEnd('> - '))), { text: '>\n> ', cursor: 4 });
      assert.deepEqual(apply('>     - ', markdownEnterEdit(stateAtEnd('>     - '))), { text: '>\n>   ', cursor: 6 });
  });

  await runCase('Backspace exits list indentation and empty quote prefixes', async () => {
      const apply = (source: string, cursor: number): string => {
        const state = EditorState.create({ doc: source, selection: EditorSelection.cursor(cursor) });
        const edit = markdownBackspaceEdit(state);
        assert.ok(edit, `expected Backspace behavior for ${JSON.stringify(source)}`);
        return state.update({ changes: { from: edit.from, to: edit.to, insert: edit.insert } }).state.doc.toString();
      };

      assert.equal(apply('- item', 2), 'item');
      assert.equal(apply('  - item', 4), '- item');
      assert.equal(apply('> text', 2), 'text');
  });

  await runCase('default file opening and save immediately after a CodeMirror edit', async tempDir => {
      const extension = vscode.extensions.getExtension('live-markdown.live-markdown');
      assert.ok(extension, 'extension manifest should be discovered');
      await extension.activate();
      const file = path.join(tempDir, 'default.md');
      const original = '# Smoke\n\nPlain text.\n';
      await fs.writeFile(file, original, 'utf8');
      const uri = vscode.Uri.file(file);

      await vscode.commands.executeCommand('vscode.open', uri);
      await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputCustom);
      const active = vscode.window.tabGroups.activeTabGroup.activeTab!;
      assert.ok(active.input instanceof vscode.TabInputCustom);
      assert.equal((active.input as vscode.TabInputCustom).viewType, VIEW_TYPE);
      const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri.toString());
      assert.ok(document, 'the host TextDocument should remain open');
      await waitFor(() => !document.isDirty, 1000);
      await delay(1000); // Let the webview finish its initial ready/initialize handshake.
      assert.equal(await fs.readFile(file, 'utf8'), original, 'opening and rendering must not rewrite file bytes');

      await vscode.commands.executeCommand('liveMarkdown.bold');
      await vscode.commands.executeCommand('liveMarkdown.save');
      await waitFor(() => document.getText().startsWith('****'));
      assert.equal(document.getText(), `****${original}`);
      await waitFor(async () => !document.isDirty && await fs.readFile(file, 'utf8') === `****${original}`);

  });

  await runCase('rendering and saving preserve exact Markdown bytes', async tempDir => {
      const extension = vscode.extensions.getExtension('live-markdown.live-markdown');
      assert.ok(extension);
      await extension.activate();
      const file = path.join(tempDir, 'byte-preservation.md');
      const original = Buffer.from(
        '# Unicode 😀 heading\r\n\r\n- [ ] task with **emphasis** and `code`\r\n\r\n'
        + '| A | B |\r\n| --- | --- |\r\n| **bold** | <literal> & raw HTML\r\n',
        'utf8',
      );
      await fs.writeFile(file, original);
      const uri = vscode.Uri.file(file);

      await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
      await waitFor(() => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE && input.uri.toString() === uri.toString();
      });
      const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri.toString());
      assert.ok(document, 'the Markdown TextDocument should remain the backing model');
      await waitFor(() => !document.isDirty, 1000);
      await delay(1000); // Allow the webview to parse and render the fixture before saving.
      assert.equal(document.eol, vscode.EndOfLine.CRLF);
      assert.equal(document.getText(), original.toString('utf8'));
      assert.equal(document.isDirty, false);

      await vscode.commands.executeCommand('liveMarkdown.save');
      await delay(100);
      assert.equal(document.getText(), original.toString('utf8'), 'presentation must not mutate source text');
      assert.equal(document.isDirty, false, 'rendering and Save must leave a no-op document clean');
      assert.deepEqual(await fs.readFile(file), original, 'rendering and Save must preserve the exact on-disk bytes');
  });

  await runCase('hidden custom editors reload from the committed TextDocument', async tempDir => {
      const firstFile = path.join(tempDir, 'first.md');
      const secondFile = path.join(tempDir, 'second.md');
      await fs.writeFile(firstFile, '# First\n', 'utf8');
      await fs.writeFile(secondFile, '# Second\n', 'utf8');
      const firstUri = vscode.Uri.file(firstFile);
      const secondUri = vscode.Uri.file(secondFile);
      void vscode.commands.executeCommand('vscode.openWith', firstUri, VIEW_TYPE).then(undefined, error => console.error('Opening first custom editor failed', error));
      await waitFor(() => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE && input.uri.toString() === firstUri.toString()
          && vscode.workspace.textDocuments.some(document => document.uri.toString() === firstUri.toString());
      });
      const firstDocument = vscode.workspace.textDocuments.find(document => document.uri.toString() === firstUri.toString());
      assert.ok(firstDocument, 'opening the custom editor should register its TextDocument');
      await vscode.commands.executeCommand('liveMarkdown.bold');
      await waitFor(() => firstDocument.getText() === '****# First\n');
      await delay(500); // Let the acknowledgment and durable-journal cleanup finish before testing hidden-view resumption.

      void vscode.commands.executeCommand('vscode.openWith', secondUri, VIEW_TYPE).then(undefined, error => console.error('Opening second custom editor failed', error));
      await waitFor(() => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE && input.uri.toString() === secondUri.toString()
          && vscode.workspace.textDocuments.some(document => document.uri.toString() === secondUri.toString());
      });
      assert.equal(firstDocument.getText(), '****# First\n', 'hiding the page must not lose its committed edit');
      const hiddenExternal = new vscode.WorkspaceEdit();
      hiddenExternal.insert(firstUri, firstDocument.positionAt(firstDocument.getText().length), 'External while hidden\n');
      assert.equal(await vscode.workspace.applyEdit(hiddenExternal), true);
      await waitFor(() => firstDocument.getText() === '****# First\nExternal while hidden\n');

      void vscode.commands.executeCommand('vscode.openWith', firstUri, VIEW_TYPE).then(undefined, error => console.error('Reopening first custom editor failed', error));
      await waitFor(() => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE && input.uri.toString() === firstUri.toString()
          && vscode.workspace.textDocuments.some(document => document.uri.toString() === firstUri.toString());
      });
      await delay(300);
      await vscode.commands.executeCommand('liveMarkdown.bold');
      try {
        await waitFor(() => firstDocument.getText() === '********# First\nExternal while hidden\n');
      } catch {
        throw new Error(`Restored editor did not apply Bold; current document is ${JSON.stringify(firstDocument.getText())}.`);
      }
      await vscode.commands.executeCommand('liveMarkdown.save');
      await waitFor(async () => !firstDocument.isDirty && await fs.readFile(firstFile, 'utf8') === '********# First\nExternal while hidden\n');
  });

  await runCase('untitled Markdown routing', async () => {
      const extension = vscode.extensions.getExtension('live-markdown.live-markdown');
      assert.ok(extension);
      await extension.activate();
      await vscode.commands.executeCommand('liveMarkdown.newDocument');
      await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputCustom);
      const input = vscode.window.tabGroups.activeTabGroup.activeTab!.input as vscode.TabInputCustom;
      assert.equal(input.viewType, VIEW_TYPE);
      assert.equal(input.uri.scheme, 'untitled');
  });

  await runCase('source-mode toggles leave the Markdown document unchanged', async tempDir => {
      const extension = vscode.extensions.getExtension('live-markdown.live-markdown');
      assert.ok(extension);
      await extension.activate();
      const file = path.join(tempDir, 'source-mode.md');
      const original = '# Source mode\n\nA **bold** paragraph.\n';
      await fs.writeFile(file, original, 'utf8');
      const uri = vscode.Uri.file(file);
      await vscode.commands.executeCommand('vscode.open', uri);
      await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputCustom);
      const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri.toString());
      assert.ok(document);
      await delay(1000);
      await vscode.commands.executeCommand('liveMarkdown.toggleSource');
      await vscode.commands.executeCommand('liveMarkdown.toggleSource');
      await delay(200);
      assert.equal(document.getText(), original);
      assert.equal(document.isDirty, false);
      assert.equal(await fs.readFile(file, 'utf8'), original);
  });

  await runCase('same-document split views synchronize through the shared host document', async tempDir => {
      const extension = vscode.extensions.getExtension('live-markdown.live-markdown');
      assert.ok(extension);
      await extension.activate();
      const file = path.join(tempDir, 'split.md');
      const original = '# Split view\n';
      await fs.writeFile(file, original, 'utf8');
      const uri = vscode.Uri.file(file);
      await vscode.commands.executeCommand('vscode.open', uri);
      await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputCustom);
      await vscode.commands.executeCommand('workbench.action.splitEditorRight');
      await waitFor(() => vscode.window.tabGroups.all.filter(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === uri.toString())).length === 2);
      const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri.toString());
      assert.ok(document);
      await delay(1200);

      await vscode.commands.executeCommand('liveMarkdown.bold');
      await waitFor(() => document.getText() === `****${original}`);
      await delay(150);
      await vscode.commands.executeCommand('workbench.action.focusPreviousGroup');
      await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputCustom);
      await vscode.commands.executeCommand('liveMarkdown.bold');
      await waitFor(() => document.getText() === `********${original}`);
  });

  await runCase('Live Markdown undo and redo update the shared TextDocument', async tempDir => {
      const extension = vscode.extensions.getExtension('live-markdown.live-markdown');
      assert.ok(extension);
      await extension.activate();
      const file = path.join(tempDir, 'history.md');
      const original = '# History\n';
      await fs.writeFile(file, original, 'utf8');
      const uri = vscode.Uri.file(file);
      await vscode.commands.executeCommand('vscode.open', uri);
      await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputCustom);
      const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri.toString());
      assert.ok(document);
      await delay(1000);

      await vscode.commands.executeCommand('liveMarkdown.bold');
      await waitFor(() => document.getText() === `****${original}`);
      await vscode.commands.executeCommand('liveMarkdown.undo');
      await waitFor(() => document.getText() === original);
      await vscode.commands.executeCommand('liveMarkdown.redo');
      await waitFor(() => document.getText() === `****${original}`);
      await vscode.commands.executeCommand('liveMarkdown.undo');
      await waitFor(() => document.getText() === original);

      // Task widgets commit the same minimal source edit as any other editor action.
      const task = '- [ ] Task\n';
      const taskSetup = new vscode.WorkspaceEdit();
      taskSetup.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), task);
      assert.equal(await vscode.workspace.applyEdit(taskSetup), true);
      await waitFor(() => document.getText() === task);
      const checkboxEdit = new vscode.WorkspaceEdit();
      checkboxEdit.replace(uri, new vscode.Range(new vscode.Position(0, 2), new vscode.Position(0, 5)), '[x]');
      assert.equal(await vscode.workspace.applyEdit(checkboxEdit), true);
      await waitFor(() => document.getText() === '- [x] Task\n');
      await vscode.commands.executeCommand('liveMarkdown.undo');
      await waitFor(() => document.getText() === task);
      await vscode.commands.executeCommand('liveMarkdown.redo');
      await waitFor(() => document.getText() === '- [x] Task\n');
      await vscode.commands.executeCommand('liveMarkdown.undo');
      await waitFor(() => document.getText() === task);
  });

  await runCase('consecutive local character insertions and deletions undo as typing groups', async tempDir => {
      const file = path.join(tempDir, 'typing-history.md');
      await fs.writeFile(file, 'x', 'utf8');
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const values = new Map<string, unknown>();
      const state = {
        get<T>(key: string, defaultValue?: T): T | undefined { return values.has(key) ? values.get(key) as T : defaultValue; },
        async update(key: string, value: unknown): Promise<void> { if (value === undefined) values.delete(key); else values.set(key, value); },
        keys(): readonly string[] { return [...values.keys()]; },
        setKeysForSync(): void {},
      } as unknown as vscode.Memento;
      const panel = { webview: { postMessage: async () => true } } as unknown as vscode.WebviewPanel;
      const client = { panel, sessionId: 'typing-history-session', ready: false, recoveryId: undefined as string | undefined };
      const bridge = new DocumentBridge(document, state);
      bridge.add(client);
      await bridge.prepareRecoveryClient(client, '9'.repeat(32));
      await bridge.receive(client, { type: 'ready', sessionId: client.sessionId, recoveryId: client.recoveryId });
      let sequence = 0;
      const edit = async (from: number, to: number, insert: string) => {
        const changes = [{ from, to, insert }];
        sequence++;
        await bridge.receive(client, { type: 'draft', sessionId: client.sessionId, sequence, changes });
        await bridge.receive(client, { type: 'edit', sessionId: client.sessionId, operationId: `typing-${sequence}`, baseVersion: document.version, draftSequence: sequence, changes });
      };
      await edit(1, 1, 'a');
      await edit(2, 2, 'b');
      assert.equal(document.getText(), 'xab');
      await bridge.receive(client, { type: 'action', sessionId: client.sessionId, action: 'undo' });
      assert.equal(document.getText(), 'x', 'one undo should remove the consecutive typed characters');
      await bridge.receive(client, { type: 'action', sessionId: client.sessionId, action: 'redo' });
      assert.equal(document.getText(), 'xab');

      await edit(2, 3, '');
      await edit(1, 2, '');
      assert.equal(document.getText(), 'x');
      await bridge.receive(client, { type: 'action', sessionId: client.sessionId, action: 'undo' });
      assert.equal(document.getText(), 'xab', 'one undo should restore consecutive backspaces');
      bridge.dispose();
  });

  await runCase('rapid edits stay ordered while a host acknowledgement is delayed', async tempDir => {
      const file = path.join(tempDir, 'delayed-ack.md');
      await fs.writeFile(file, '', 'utf8');
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const values = new Map<string, unknown>();
      const state = {
        get<T>(key: string, defaultValue?: T): T | undefined { return values.has(key) ? values.get(key) as T : defaultValue; },
        async update(key: string, value: unknown): Promise<void> { if (value === undefined) values.delete(key); else values.set(key, value); },
        keys(): readonly string[] { return [...values.keys()]; },
        setKeysForSync(): void {},
      } as unknown as vscode.Memento;
      let releaseAck!: () => void;
      let ackStarted!: () => void;
      const gate = new Promise<void>(resolve => { releaseAck = resolve; });
      const ackSignal = new Promise<void>(resolve => { ackStarted = resolve; });
      const panel = { webview: { postMessage: async (message: { type: string }) => {
        if (message.type === 'ack') { ackStarted(); await gate; }
        return true;
      } } } as unknown as vscode.WebviewPanel;
      const client = { panel, sessionId: 'delayed-ack-session', ready: false, recoveryId: undefined as string | undefined };
      const bridge = new DocumentBridge(document, state);
      bridge.add(client);
      await bridge.prepareRecoveryClient(client, '8'.repeat(32));
      await bridge.receive(client, { type: 'ready', sessionId: client.sessionId, recoveryId: client.recoveryId });

      await bridge.receive(client, { type: 'draft', sessionId: client.sessionId, sequence: 1, changes: [{ from: 0, to: 0, insert: 'a' }] });
      const first = bridge.receive(client, { type: 'edit', sessionId: client.sessionId, operationId: 'delayed-1', baseVersion: document.version, draftSequence: 1, changes: [{ from: 0, to: 0, insert: 'a' }] });
      await ackSignal;
      await bridge.receive(client, { type: 'draft', sessionId: client.sessionId, sequence: 2, changes: [{ from: 1, to: 1, insert: 'b' }] });
      const second = bridge.receive(client, { type: 'edit', sessionId: client.sessionId, operationId: 'delayed-2', baseVersion: document.version, draftSequence: 2, changes: [{ from: 1, to: 1, insert: 'b' }] });
      await delay(50);
      assert.equal(document.getText(), 'a', 'the second edit must wait for the first acknowledgement');
      releaseAck();
      await Promise.all([first, second]);
      assert.equal(document.getText(), 'ab', 'the queued edit should apply after the acknowledgement');
      bridge.dispose();
  });

  await runCase('a closed view retains input committed before its acknowledgement was delivered', async tempDir => {
      const file = path.join(tempDir, 'closed-after-commit.md');
      await fs.writeFile(file, '', 'utf8');
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const values = new Map<string, unknown>();
      const state = {
        get<T>(key: string, defaultValue?: T): T | undefined { return values.has(key) ? values.get(key) as T : defaultValue; },
        async update(key: string, value: unknown): Promise<void> { if (value === undefined) values.delete(key); else values.set(key, value); },
        keys(): readonly string[] { return [...values.keys()]; },
        setKeysForSync(): void {},
      } as unknown as vscode.Memento;
      const panel = { webview: { postMessage: async (message: { type: string }) => {
        if (message.type === 'ack') throw new Error('The view closed before receiving the acknowledgement.');
        return true;
      } } } as unknown as vscode.WebviewPanel;
      const client = { panel, sessionId: 'closed-commit-session', ready: false, recoveryId: undefined as string | undefined };
      const bridge = new DocumentBridge(document, state);
      bridge.add(client);
      await bridge.prepareRecoveryClient(client, '7'.repeat(32));
      await bridge.receive(client, { type: 'ready', sessionId: client.sessionId, recoveryId: client.recoveryId });
      const changes = [{ from: 0, to: 0, insert: 'typed' }];
      await bridge.receive(client, { type: 'draft', sessionId: client.sessionId, sequence: 1, changes });
      await assert.rejects(bridge.receive(client, { type: 'edit', sessionId: client.sessionId, operationId: 'closed-edit', baseVersion: document.version, draftSequence: 1, changes }));
      assert.equal(document.getText(), 'typed', 'the host document should contain the edit even if its acknowledgment could not be delivered');
      bridge.remove(client);
      bridge.dispose();

      const reopenedPanel = { webview: { postMessage: async () => true } } as unknown as vscode.WebviewPanel;
      const reopened = { panel: reopenedPanel, sessionId: 'reopened-session', ready: false, recoveryId: client.recoveryId };
      const nextBridge = new DocumentBridge(document, state);
      nextBridge.add(reopened);
      await nextBridge.prepareRecoveryClient(reopened, reopened.recoveryId!);
      assert.equal(await nextBridge.recoveredDraft(reopened), 'typed', 'the recovery journal should preserve the pending draft across close');
      await nextBridge.clearStaleRecoveryIfCommitted(reopened);
      assert.equal(await nextBridge.recoveredDraft(reopened), undefined, 'recovery can clear once the committed document includes the draft');
      nextBridge.dispose();
  });

  await runCase('closing immediately after uncommitted input retains the durable draft', async tempDir => {
      const file = path.join(tempDir, 'closed-before-commit.md');
      const original = '# Saved version\n';
      const draft = 'Unsaved: ' + original;
      await fs.writeFile(file, original, 'utf8');
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const values = new Map<string, unknown>();
      const state = {
        get<T>(key: string, defaultValue?: T): T | undefined { return values.has(key) ? values.get(key) as T : defaultValue; },
        async update(key: string, value: unknown): Promise<void> { if (value === undefined) values.delete(key); else values.set(key, value); },
        keys(): readonly string[] { return [...values.keys()]; },
        setKeysForSync(): void {},
      } as unknown as vscode.Memento;
      const panel = { webview: { postMessage: async () => true } } as unknown as vscode.WebviewPanel;
      const client = { panel, sessionId: 'close-before-commit-session', ready: false, recoveryId: undefined as string | undefined };
      const bridge = new DocumentBridge(document, state);
      bridge.add(client);
      await bridge.prepareRecoveryClient(client, '6'.repeat(32));
      await bridge.receive(client, { type: 'ready', sessionId: client.sessionId, recoveryId: client.recoveryId });

      const changes = [{ from: 0, to: 0, insert: 'Unsaved: ' }];
      const draftReceived = bridge.receive(client, { type: 'draft', sessionId: client.sessionId, sequence: 1, changes });
      // Closing immediately after the webview sends its recovery patch must not commit or erase it.
      bridge.remove(client);
      bridge.dispose();
      await draftReceived;
      await waitFor(() => [...values.keys()].some(key => key.endsWith('.snapshot')));

      assert.equal(document.getText(), original, 'input without a host edit acknowledgement must not change the saved document');
      const reopenedPanel = { webview: { postMessage: async () => true } } as unknown as vscode.WebviewPanel;
      const reopened = { panel: reopenedPanel, sessionId: 'close-before-commit-reopened', ready: false, recoveryId: client.recoveryId };
      const nextBridge = new DocumentBridge(document, state);
      nextBridge.add(reopened);
      await nextBridge.prepareRecoveryClient(reopened, reopened.recoveryId!);
      assert.equal(await nextBridge.recoveredDraft(reopened), draft, 'the immediately closed editor must offer the unsaved source on reopen');
      nextBridge.dispose();
  });

  await runCase('external document changes reconcile before rapid queued formatting edits', async tempDir => {
      const extension = vscode.extensions.getExtension('live-markdown.live-markdown');
      assert.ok(extension);
      await extension.activate();
      const file = path.join(tempDir, 'external.md');
      const original = '# External edit\n';
      await fs.writeFile(file, original, 'utf8');
      const uri = vscode.Uri.file(file);
      await vscode.commands.executeCommand('vscode.open', uri);
      await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputCustom);
      const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri.toString());
      assert.ok(document);
      await delay(1200);

      const outsideEdit = new vscode.WorkspaceEdit();
      outsideEdit.insert(uri, new vscode.Position(0, 0), 'Outside: ');
      assert.equal(await vscode.workspace.applyEdit(outsideEdit), true);
      await waitFor(() => document.getText() === `Outside: ${original}`);
      await delay(100);
      await vscode.commands.executeCommand('liveMarkdown.bold');
      await vscode.commands.executeCommand('liveMarkdown.bold');
      await waitFor(() => document.getText() === `********Outside: ${original}`);
  });

  await runCase('VS Code auto-save writes custom-editor transactions', async tempDir => {
      const extension = vscode.extensions.getExtension('live-markdown.live-markdown');
      assert.ok(extension);
      await extension.activate();
      const config = vscode.workspace.getConfiguration('files');
      await config.update('autoSave', 'afterDelay', vscode.ConfigurationTarget.Global);
      await config.update('autoSaveDelay', 300, vscode.ConfigurationTarget.Global);
      const file = path.join(tempDir, 'autosave.md');
      const original = '# Auto-save\n';
      await fs.writeFile(file, original, 'utf8');
      const uri = vscode.Uri.file(file);
      await vscode.commands.executeCommand('vscode.open', uri);
      await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputCustom);
      const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri.toString());
      assert.ok(document);
      await delay(1000);
      await vscode.commands.executeCommand('liveMarkdown.bold');
      await waitFor(async () => document.getText() === `****${original}` && await fs.readFile(file, 'utf8') === `****${original}`, 5000);
      await config.update('autoSave', 'off', vscode.ConfigurationTarget.Global);
  });

  await runCase('renamed custom editors continue committing to the renamed document', async tempDir => {
      const extension = vscode.extensions.getExtension('live-markdown.live-markdown');
      assert.ok(extension);
      await extension.activate();
      const file = path.join(tempDir, 'before-rename.md');
      const renamedFile = path.join(tempDir, 'after-rename.md');
      const original = '# Rename me\n';
      await fs.writeFile(file, original, 'utf8');
      const uri = vscode.Uri.file(file);
      const renamedUri = vscode.Uri.file(renamedFile);
      await vscode.commands.executeCommand('vscode.open', uri);
      await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputCustom);
      await delay(1000);

      await vscode.workspace.fs.rename(uri, renamedUri);
      await waitFor(() => vscode.workspace.textDocuments.some(item => item.uri.toString() === renamedUri.toString()));
      await waitFor(() => {
        const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return active instanceof vscode.TabInputCustom && active.uri.toString() === renamedUri.toString() && active.viewType === VIEW_TYPE;
      });
      // Wait for the renamed document's change event to reach the retained webview.
      await delay(250);
      await vscode.commands.executeCommand('liveMarkdown.bold');
      const renamedDocument = vscode.workspace.textDocuments.find(item => item.uri.toString() === renamedUri.toString());
      assert.ok(renamedDocument, 'the renamed TextDocument should remain open');
      await waitFor(() => renamedDocument.getText() === `****${original}`);
      await vscode.commands.executeCommand('liveMarkdown.save');
      await waitFor(async () => !renamedDocument.isDirty && await fs.readFile(renamedFile, 'utf8') === `****${original}`);
      await assert.rejects(fs.access(file), 'the old path should no longer exist');
  });

  await runCase('a renamed split-view bridge stays alive while either view remains open', async tempDir => {
      const extension = vscode.extensions.getExtension('live-markdown.live-markdown');
      assert.ok(extension);
      await extension.activate();
      const file = path.join(tempDir, 'split-before-rename.md');
      const renamedFile = path.join(tempDir, 'split-after-rename.md');
      const original = '# Shared rename\n';
      await fs.writeFile(file, original, 'utf8');
      const uri = vscode.Uri.file(file);
      const renamedUri = vscode.Uri.file(renamedFile);
      await vscode.commands.executeCommand('vscode.open', uri);
      await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputCustom);
      await vscode.commands.executeCommand('workbench.action.splitEditorRight');
      await waitFor(() => vscode.window.tabGroups.all.reduce((count, group) => count + group.tabs.filter(tab => tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === uri.toString()).length, 0) === 2);

      await vscode.workspace.fs.rename(uri, renamedUri);
      await waitFor(() => vscode.workspace.textDocuments.some(item => item.uri.toString() === renamedUri.toString()));
      const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === renamedUri.toString());
      assert.ok(document);
      await waitFor(() => vscode.window.tabGroups.all.reduce((count, group) => count + group.tabs.filter(tab => tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === renamedUri.toString()).length, 0) === 2);

      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await waitFor(() => vscode.window.tabGroups.all.reduce((count, group) => count + group.tabs.filter(tab => tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === renamedUri.toString()).length, 0) === 1);
      const external = new vscode.WorkspaceEdit();
      external.insert(renamedUri, document.positionAt(document.getText().length), 'External');
      assert.equal(await vscode.workspace.applyEdit(external), true);
      await waitFor(() => document.getText() === `${original}External`);
      await delay(100);
      await vscode.commands.executeCommand('liveMarkdown.bold');
      await waitFor(() => document.getText() === `****${original}External`);
      await vscode.commands.executeCommand('liveMarkdown.save');
      await waitFor(async () => !document.isDirty && await fs.readFile(renamedFile, 'utf8') === `****${original}External`);
  });

  await runCase('dirty custom editors discard local changes when reloaded from disk', async tempDir => {
      const extension = vscode.extensions.getExtension('live-markdown.live-markdown');
      assert.ok(extension);
      await extension.activate();
      const filesConfig = vscode.workspace.getConfiguration('files');
      await filesConfig.update('autoSave', 'off', vscode.ConfigurationTarget.Global);
      await waitFor(() => filesConfig.get('autoSave') === 'off');
      await delay(400);
      const file = path.join(tempDir, 'revert.md');
      const original = '# Before reload\n';
      const external = '# Reloaded from disk\n';
      await fs.writeFile(file, original, 'utf8');
      const uri = vscode.Uri.file(file);
      await vscode.commands.executeCommand('vscode.open', uri);
      await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputCustom);
      const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri.toString());
      assert.ok(document);
      await delay(1000);

      await vscode.commands.executeCommand('liveMarkdown.bold');
      await waitFor(() => document.getText() === `****${original}`);
      await waitFor(() => document.isDirty);
      assert.equal(document.isDirty, true, 'the editor should have an uncommitted local change');
      await fs.writeFile(file, external, 'utf8');
      await vscode.commands.executeCommand('workbench.action.files.revert');
      await waitFor(() => document.getText() === external && !document.isDirty);
      await vscode.commands.executeCommand('liveMarkdown.bold');
      await waitFor(() => document.getText() === `****${external}`);
  });

  await runCase('unacknowledged recovery journal survives bridge disposal and is found on reopen', async tempDir => {
      const file = path.join(tempDir, 'recovery.md');
      const original = '# Recover me\n';
      await fs.writeFile(file, original, 'utf8');
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const values = new Map<string, unknown>();
      const state = {
        get<T>(key: string, defaultValue?: T): T | undefined { return values.has(key) ? values.get(key) as T : defaultValue; },
        async update(key: string, value: unknown): Promise<void> { if (value === undefined) values.delete(key); else values.set(key, value); },
        keys(): readonly string[] { return [...values.keys()]; },
        setKeysForSync(): void {},
      } as unknown as vscode.Memento;
      const panel = { webview: { postMessage: async () => true } } as unknown as vscode.WebviewPanel;
      const first = { panel, sessionId: 'first-session', ready: false, recoveryId: undefined as string | undefined };
      const firstBridge = new DocumentBridge(document, state);
      firstBridge.add(first);
      await firstBridge.prepareRecoveryClient(first, 'a'.repeat(32));
      await firstBridge.receive(first, { type: 'ready', sessionId: first.sessionId, recoveryId: first.recoveryId });
      await firstBridge.receive(first, { type: 'draft', sessionId: first.sessionId, sequence: 1, changes: [{ from: 0, to: 0, insert: 'Draft: ' }] });
      firstBridge.dispose();

      const second = { panel, sessionId: 'second-session', ready: false, recoveryId: undefined as string | undefined };
      const secondBridge = new DocumentBridge(document, state);
      secondBridge.add(second);
      await secondBridge.prepareRecoveryClient(second, 'b'.repeat(32));
      await secondBridge.receive(second, { type: 'ready', sessionId: second.sessionId, recoveryId: second.recoveryId });
      assert.equal(second.recoveryId, 'a'.repeat(32), 'reopen should claim the prior inactive webview journal');
      assert.equal(await secondBridge.recoveredDraft(second), `Draft: ${original}`);
      secondBridge.dispose();
  });

  await runCase('host offset mapping preserves CRLF and Unicode surrogate positions', async tempDir => {
      const file = path.join(tempDir, 'offsets.md');
      const original = 'a😀b\r\nz\r\n';
      await fs.writeFile(file, original, 'utf8');
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      assert.equal(document.eol, vscode.EndOfLine.CRLF);
      const values = new Map<string, unknown>();
      const state = {
        get<T>(key: string, defaultValue?: T): T | undefined { return values.has(key) ? values.get(key) as T : defaultValue; },
        async update(key: string, value: unknown): Promise<void> { if (value === undefined) values.delete(key); else values.set(key, value); },
        keys(): readonly string[] { return [...values.keys()]; },
        setKeysForSync(): void {},
      } as unknown as vscode.Memento;
      const outgoing: Array<{ type?: string; baseVersion?: number; changes?: Array<{ from: number; to: number; insert: string }> }> = [];
      const panel = { webview: { postMessage: async (message: { type?: string; baseVersion?: number; changes?: Array<{ from: number; to: number; insert: string }> }) => { outgoing.push(message); return true; } } } as unknown as vscode.WebviewPanel;
      const client = { panel, sessionId: 'offset-session', ready: false, recoveryId: undefined as string | undefined };
      const bridge = new DocumentBridge(document, state);
      bridge.add(client);
      await bridge.prepareRecoveryClient(client, 'c'.repeat(32));
      await bridge.receive(client, { type: 'ready', sessionId: client.sessionId, recoveryId: client.recoveryId });
      const changes = [{ from: 3, to: 3, insert: 'X' }]; // after the two UTF-16 code units of 😀
      await bridge.receive(client, { type: 'draft', sessionId: client.sessionId, sequence: 1, changes });
      await bridge.receive(client, { type: 'edit', sessionId: client.sessionId, operationId: 'offset-edit', baseVersion: document.version, draftSequence: 1, changes });
      assert.equal(document.getText(), 'a😀Xb\r\nz\r\n');
      assert.equal(await document.save(), true);
      assert.equal(await fs.readFile(file, 'utf8'), 'a😀Xb\r\nz\r\n');
      await bridge.receive(client, { type: 'clearDraft', sessionId: client.sessionId });
      const baseVersion = document.version;
      const external = new vscode.WorkspaceEdit();
      external.insert(document.uri, new vscode.Position(1, 1), 'Y');
      assert.equal(await vscode.workspace.applyEdit(external), true);
      await waitFor(() => outgoing.some(message => message.type === 'external'));
      const update = outgoing.find(message => message.type === 'external')!;
      assert.equal(update.baseVersion, baseVersion);
      assert.deepEqual(update.changes, [{ from: 7, to: 7, insert: 'Y' }]);
      const newlineEdit = new vscode.WorkspaceEdit();
      newlineEdit.insert(document.uri, new vscode.Position(0, 1), 'q\n');
      assert.equal(await vscode.workspace.applyEdit(newlineEdit), true);
      await waitFor(() => outgoing.some(message => message.type === 'external' && message.changes?.some(change => change.from === 1 && change.to === 1 && change.insert === 'q\n')));
      assert.deepEqual(outgoing.find(message => message.type === 'external' && message.changes?.some(change => change.from === 1 && change.to === 1 && change.insert === 'q\n'))?.changes, [{ from: 1, to: 1, insert: 'q\n' }]);
      const appendAtLastLine = [{ from: 10, to: 10, insert: 'T' }];
      await bridge.receive(client, { type: 'draft', sessionId: client.sessionId, sequence: 1, changes: appendAtLastLine });
      await bridge.receive(client, { type: 'edit', sessionId: client.sessionId, operationId: 'after-newline-edit', baseVersion: document.version, draftSequence: 1, changes: appendAtLastLine });
      assert.equal(document.getText(), 'aq\r\n😀Xb\r\nzYT\r\n');
      bridge.dispose();
  });

  await runCase('document bridge edits a URI-backed filesystem provider', async () => {
      let contents: Uint8Array<ArrayBufferLike> = new TextEncoder().encode('# Remote URI\n');
      const events = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
      const uri = vscode.Uri.parse('liveMarkdown-test://remote/workspace/document.md');
      const provider: vscode.FileSystemProvider = {
        onDidChangeFile: events.event,
        watch: () => new vscode.Disposable(() => {}),
        stat: () => ({ type: vscode.FileType.File, ctime: 0, mtime: 0, size: contents.byteLength }),
        readFile: () => contents,
        writeFile: (_uri, data) => { contents = data; events.fire([{ type: vscode.FileChangeType.Changed, uri }]); },
        readDirectory: () => [],
        createDirectory: () => {},
        delete: () => { contents = new Uint8Array(); },
        rename: () => {},
      };
      const registration = vscode.workspace.registerFileSystemProvider('liveMarkdown-test', provider, { isCaseSensitive: true, isReadonly: false });
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        const values = new Map<string, unknown>();
        const state = {
          get<T>(key: string, defaultValue?: T): T | undefined { return values.has(key) ? values.get(key) as T : defaultValue; },
          async update(key: string, value: unknown): Promise<void> { if (value === undefined) values.delete(key); else values.set(key, value); },
          keys(): readonly string[] { return [...values.keys()]; },
          setKeysForSync(): void {},
        } as unknown as vscode.Memento;
        const outgoing: Array<{ type?: string; message?: string }> = [];
        const panel = { webview: { postMessage: async (message: { type?: string; message?: string }) => { outgoing.push(message); return true; } } } as unknown as vscode.WebviewPanel;
        const client = { panel, sessionId: 'remote-uri-session', ready: false, recoveryId: undefined as string | undefined };
        const bridge = new DocumentBridge(document, state);
        bridge.add(client);
        await bridge.prepareRecoveryClient(client, '6'.repeat(32));
        await bridge.receive(client, { type: 'ready', sessionId: client.sessionId, recoveryId: client.recoveryId });
        const changes = [{ from: 0, to: 0, insert: 'Remote: ' }];
        await bridge.receive(client, { type: 'draft', sessionId: client.sessionId, sequence: 1, changes });
        await bridge.receive(client, { type: 'edit', sessionId: client.sessionId, operationId: 'remote-uri-edit', baseVersion: document.version, draftSequence: 1, changes });
        assert.equal(document.getText(), 'Remote: # Remote URI\n', JSON.stringify(outgoing));
        assert.equal(await document.save(), true);
        assert.equal(new TextDecoder().decode(contents), 'Remote: # Remote URI\n');
        bridge.dispose();

        // Exercise the full custom-editor/provider path as well as the isolated
        // bridge above. This models a non-file URI backed by workspace.fs.
        await vscode.commands.executeCommand('vscode.open', uri);
        await waitFor(() => {
          const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
          return active instanceof vscode.TabInputCustom && active.uri.toString() === uri.toString() && active.viewType === VIEW_TYPE;
        });
        await delay(1000);
        await vscode.commands.executeCommand('liveMarkdown.bold');
        await waitFor(() => document.getText() === `****Remote: # Remote URI\n`);
        assert.equal(await document.save(), true);
        assert.equal(new TextDecoder().decode(contents), `****Remote: # Remote URI\n`);
      } finally {
        registration.dispose();
        events.dispose();
      }
  });

  await runCase('a disconnected URI provider leaves edits recoverable until it returns', async () => {
      let available = true;
      let contents: Uint8Array<ArrayBufferLike> = new TextEncoder().encode('# Offline provider\n');
      const uri = vscode.Uri.parse('liveMarkdown-offline://remote/workspace/offline.md');
      const events = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
      const provider: vscode.FileSystemProvider = {
        onDidChangeFile: events.event,
        watch: () => new vscode.Disposable(() => {}),
        stat: () => {
          if (!available) throw vscode.FileSystemError.Unavailable(uri);
          return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: contents.byteLength };
        },
        readFile: () => {
          if (!available) throw vscode.FileSystemError.Unavailable(uri);
          return contents;
        },
        writeFile: (_target, data) => {
          if (!available) throw vscode.FileSystemError.Unavailable(uri);
          contents = data;
        },
        readDirectory: () => [],
        createDirectory: () => {},
        delete: () => {},
        rename: () => {},
      };
      const registration = vscode.workspace.registerFileSystemProvider('liveMarkdown-offline', provider, { isCaseSensitive: true, isReadonly: false });
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.commands.executeCommand('vscode.open', uri);
        await waitFor(() => {
          const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
          return active instanceof vscode.TabInputCustom && active.uri.toString() === uri.toString() && active.viewType === VIEW_TYPE;
        });
        await delay(1000);
        available = false;
        await vscode.commands.executeCommand('liveMarkdown.bold');
        await waitFor(() => document.getText() === `****# Offline provider\n`);
        assert.equal(await document.save(), false, 'saving should report that the remote provider is unavailable');
        assert.equal(document.getText(), `****# Offline provider\n`, 'the local document draft should remain intact');
        assert.equal(document.isDirty, true, 'the unsaved edit should remain recoverable');
        assert.equal(new TextDecoder().decode(contents), '# Offline provider\n', 'failed save must not replace provider contents');

        available = true;
        assert.equal(await document.save(), true, 'saving should succeed after the provider returns');
        assert.equal(new TextDecoder().decode(contents), `****# Offline provider\n`);
      } finally {
        registration.dispose();
        events.dispose();
      }
  });

  await runCase('readonly files preserve local drafts instead of committing edits', async tempDir => {
      const file = path.join(tempDir, 'readonly.md');
      const original = '# Read only\n';
      await fs.writeFile(file, original, 'utf8');
      await fs.chmod(file, 0o444);
      const uri = vscode.Uri.file(file);
      const document = await vscode.workspace.openTextDocument(uri);
      assert.equal(await isDocumentReadonly(uri), true);
      const extension = vscode.extensions.getExtension('live-markdown.live-markdown');
      assert.ok(extension);
      await extension.activate();
      await vscode.commands.executeCommand('vscode.open', uri);
      await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputCustom);
      await delay(1000);
      await vscode.commands.executeCommand('liveMarkdown.bold');
      await delay(100);
      assert.equal(document.getText(), original, 'formatting commands must not create a local draft for a read-only document');
      const values = new Map<string, unknown>();
      const state = {
        get<T>(key: string, defaultValue?: T): T | undefined { return values.has(key) ? values.get(key) as T : defaultValue; },
        async update(key: string, value: unknown): Promise<void> { if (value === undefined) values.delete(key); else values.set(key, value); },
        keys(): readonly string[] { return [...values.keys()]; },
        setKeysForSync(): void {},
      } as unknown as vscode.Memento;
      const messages: Array<{ type?: string }> = [];
      const panel = { webview: { postMessage: async (message: { type?: string }) => { messages.push(message); return true; } } } as unknown as vscode.WebviewPanel;
      const client = { panel, sessionId: 'readonly-session', ready: false, recoveryId: undefined as string | undefined };
      const bridge = new DocumentBridge(document, state);
      bridge.add(client);
      await bridge.prepareRecoveryClient(client, 'd'.repeat(32));
      await bridge.receive(client, { type: 'ready', sessionId: client.sessionId, recoveryId: client.recoveryId });
      const changes = [{ from: 0, to: 0, insert: 'Draft: ' }];
      await bridge.receive(client, { type: 'draft', sessionId: client.sessionId, sequence: 1, changes });
      await bridge.receive(client, { type: 'edit', sessionId: client.sessionId, operationId: 'readonly-edit', baseVersion: document.version, draftSequence: 1, changes });
      assert.equal(document.getText(), original);
      assert.ok(messages.some(message => message.type === 'failure'));
      assert.equal(values.size > 0, true, 'the unsaved draft journal must be retained');
      bridge.dispose();
      await fs.chmod(file, 0o644);
  });

  await runCase('stale split-view edits conflict without replacing the committed version', async tempDir => {
      const file = path.join(tempDir, 'stale.md');
      const original = 'abc';
      await fs.writeFile(file, original, 'utf8');
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const initialVersion = document.version;
      const values = new Map<string, unknown>();
      const state = {
        get<T>(key: string, defaultValue?: T): T | undefined { return values.has(key) ? values.get(key) as T : defaultValue; },
        async update(key: string, value: unknown): Promise<void> { if (value === undefined) values.delete(key); else values.set(key, value); },
        keys(): readonly string[] { return [...values.keys()]; },
        setKeysForSync(): void {},
      } as unknown as vscode.Memento;
      const firstMessages: Array<{ type?: string }> = [];
      const secondMessages: Array<{ type?: string }> = [];
      const firstPanel = { webview: { postMessage: async (message: { type?: string }) => { firstMessages.push(message); return true; } } } as unknown as vscode.WebviewPanel;
      const secondPanel = { webview: { postMessage: async (message: { type?: string }) => { secondMessages.push(message); return true; } } } as unknown as vscode.WebviewPanel;
      const first = { panel: firstPanel, sessionId: 'first-stale-session', ready: false, recoveryId: undefined as string | undefined };
      const second = { panel: secondPanel, sessionId: 'second-stale-session', ready: false, recoveryId: undefined as string | undefined };
      const bridge = new DocumentBridge(document, state);
      bridge.add(first);
      bridge.add(second);
      await bridge.prepareRecoveryClient(first, 'e'.repeat(32));
      await bridge.prepareRecoveryClient(second, 'f'.repeat(32));
      await bridge.receive(first, { type: 'ready', sessionId: first.sessionId, recoveryId: first.recoveryId });
      await bridge.receive(second, { type: 'ready', sessionId: second.sessionId, recoveryId: second.recoveryId });
      const firstChange = [{ from: 1, to: 1, insert: 'A' }];
      await bridge.receive(first, { type: 'draft', sessionId: first.sessionId, sequence: 1, changes: firstChange });
      await bridge.receive(first, { type: 'edit', sessionId: first.sessionId, operationId: 'first-stale-edit', baseVersion: initialVersion, draftSequence: 1, changes: firstChange });
      assert.equal(document.getText(), 'aAbc');
      const secondChange = [{ from: 1, to: 1, insert: 'B' }];
      await bridge.receive(second, { type: 'draft', sessionId: second.sessionId, sequence: 1, changes: secondChange });
      await bridge.receive(second, { type: 'edit', sessionId: second.sessionId, operationId: 'second-stale-edit', baseVersion: initialVersion, draftSequence: 1, changes: secondChange });
      assert.equal(document.getText(), 'aAbc');
      assert.ok(secondMessages.some(message => message.type === 'failure'));
      assert.ok(values.size > 0, 'the conflicting view keeps a recoverable journal');
      bridge.dispose();
  });

  await runCase('non-overlapping source changes rebase and overlapping ranges conflict', async () => {
      const base = 'abcd';
      const local = sourceChangesToSet([{ from: 1, to: 1, insert: 'L' }], base.length);
      const remote = sourceChangesToSet([{ from: 3, to: 3, insert: 'R' }], base.length);
      assert.equal(changesOverlap(local, remote), false);
      const hostText = remote.apply(EditorState.create({ doc: base }).doc);
      const localOverRemote = local.map(remote);
      assert.equal(localOverRemote.apply(hostText).toString(), 'aLbcRd');

      const localReplacement = sourceChangesToSet([{ from: 1, to: 3, insert: 'X' }], base.length);
      const remoteInsertion = sourceChangesToSet([{ from: 2, to: 2, insert: 'Y' }], base.length);
      assert.equal(changesOverlap(localReplacement, remoteInsertion), true);
  });

  await runCase('queued local transactions compose into one source edit', async () => {
      const first = sourceChangesToSet([{ from: 1, to: 1, insert: 'X' }], 3);
      const second = sourceChangesToSet([{ from: 3, to: 3, insert: 'Y' }], first.newLength);
      const combined = composeChangeSets(3, [first, second]);
      const state = EditorState.create({ doc: 'abc' });
      assert.equal(combined.apply(state.doc).toString(), 'aXbYc');
      assert.deepEqual(changeSetToSourceChanges(combined), [
        { from: 1, to: 1, insert: 'X' },
        { from: 2, to: 2, insert: 'Y' },
      ]);
  });
}
