import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { strict as assert } from 'node:assert';
import { build } from 'esbuild';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { GFM } from '@lezer/markdown';
import { documentHeadings } from '../../src/webview/headings';
import { fencedCodeText } from '../../src/webview/codeBlocks';
import { isCommandMessage, isHostMessage, isWebviewMessage } from '../../src/protocol';

export async function runUxCases(runCase: (name: string, body: (dir: string) => Promise<void>) => Promise<void>): Promise<void> {
  await runCase('UX headings preserve visible labels, Unicode, and unique section links', async () => {
    const source = '# **Hello** [world](guide.md) ###\n\n## Hello world\n\n## Hello world-1\n\n## Hello world\n\n'
      + 'Café & tea\n---\n\n> ### Quoted `heading`\n\n## <https://example.com> and https://example.org\n\n```md\n# Example only\n```\n';
    const state = EditorState.create({ doc: source, extensions: [markdown({ extensions: GFM })] });
    const headings = documentHeadings(state)!;
    assert.deepEqual(headings.map(({ label, slug, level }) => ({ label, slug, level })), [
      { label: 'Hello world', slug: 'hello-world', level: 1 },
      { label: 'Hello world', slug: 'hello-world-1', level: 2 },
      { label: 'Hello world-1', slug: 'hello-world-1-1', level: 2 },
      { label: 'Hello world', slug: 'hello-world-2', level: 2 },
      { label: 'Café & tea', slug: 'café-tea', level: 2 },
      { label: 'Quoted heading', slug: 'quoted-heading', level: 3 },
      { label: 'https://example.com and https://example.org', slug: 'httpsexamplecom-and-httpsexampleorg', level: 2 },
    ]);
    assert.equal(state.doc.toString(), source, 'navigation must preserve Markdown bytes');
  });

  await runCase('UX copying fenced code preserves whitespace and excludes container syntax', async () => {
    for (const [source, expected] of [
      ['```ts\nconst x = 1;\n\n```', 'const x = 1;\n\n'],
      ['```\n```', ''], ['```\nunclosed\n', 'unclosed\n'],
      ['> ```js\n> let x = 1;\n>   nested();\n> ```', 'let x = 1;\n  nested();\n'],
      ['- ```js\n  let x = 1;\n    nested();\n  ```', 'let x = 1;\n  nested();\n'],
    ]) {
      const state = EditorState.create({ doc: source, extensions: [markdown()] });
      const tree = ensureSyntaxTree(state, source.length, 1000)!;
      let copied: string | undefined;
      tree.iterate({ enter: node => { if (node.name === 'FencedCode') copied = fencedCodeText(state, node.node); } });
      assert.equal(copied, expected, source);
    }
  });

  await runCase('UX navigation messages and spellcheck settings validate their payloads', async () => {
    const heading = { label: 'Title', slug: 'title', level: 2 };
    assert.equal(isWebviewMessage({ type: 'pickHeading', sessionId: 's', headings: [heading] }), true);
    assert.equal(isWebviewMessage({ type: 'pickHeading', sessionId: 's', headings: [{ ...heading, level: 7 }] }), false);
    assert.equal(isWebviewMessage({ type: 'pickHeading', sessionId: 's', headings: Array(2001).fill(heading) }), false);
    assert.equal(isCommandMessage({ type: 'navigateHeading', slug: 'title' }), true);
    assert.equal(isCommandMessage({ type: 'navigateHeading', slug: 2 }), false);
    assert.equal(isCommandMessage({ type: 'command', action: 'goToHeading' }), true);
    assert.equal(isCommandMessage({ type: 'command', action: 'copyHeadingLink' }), true);
    const settings = { syntaxVisibility: 'activeLine', readingPreset: 'default', fontFamily: 'inherit', fontSize: null,
      lineHeight: null, contentWidth: null, showLineNumbers: false, renderImages: true, renderTables: true,
      allowRemoteImages: false, isTrusted: true, screenReaderMode: false, lineNumberStart: 1, spellcheck: true };
    assert.equal(isHostMessage({ type: 'configuration', settings }), true);
    assert.equal(isHostMessage({ type: 'configuration', settings: { ...settings, spellcheck: 'true' } }), false);
    const manifest = JSON.parse(await fs.readFile(path.resolve(__dirname, '../../../package.json'), 'utf8'));
    for (const command of ['goToHeading', 'toggleSource', 'chooseReadingPreset']) {
      assert.ok(manifest.contributes.menus['editor/title'].some((item: { command: string; when: string }) =>
        item.command === `liveMarkdown.${command}` && item.when === 'activeCustomEditorId == liveMarkdown.liveEditor'));
    }
  });

  await runCase('UX rendered controls, table positions, navigation, and prose spellcheck work in a webview', async () => {
    const extensionRoot = vscode.Uri.file(path.resolve(__dirname, '../../..'));
    const bundle = await build({ entryPoints: [path.join(extensionRoot.fsPath, 'test/webview/ux.ts')],
      bundle: true, write: false, platform: 'browser', format: 'iife' });
    const panel = vscode.window.createWebviewPanel('liveMarkdown.uxTest', 'Markdown UX test', vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [extensionRoot] });
    try {
      const result = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('UX webview timed out')), 30000);
        panel.webview.onDidReceiveMessage((message: { error?: string }) => {
          clearTimeout(timeout);
          if (message.error) reject(new Error(message.error)); else resolve();
        });
      });
      const theme = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionRoot, 'media/theme.css'));
      panel.webview.html = `<!doctype html><html><head><link rel="stylesheet" href="${theme}"></head><body><div id="editor"></div><script>${bundle.outputFiles[0].text}</script></body></html>`;
      await result;
    } finally { panel.dispose(); }
  });
}
