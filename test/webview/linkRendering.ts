import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { GFM } from '@lezer/markdown';
import { EditorSettings } from '../../src/protocol';
import { liveRendering } from '../../src/webview/liveRendering';
import { linkTargetAt } from '../../src/webview/references';

declare function acquireVsCodeApi(): { postMessage(message: { error?: string }): void };
const vscode = acquireVsCodeApi();

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const source = 'Plain text\n\n[inline](https://example.com) and [reference][docs] and [collapsed][] and [shortcut]\n\n'
    + '<https://example.net> and https://example.org\n\n## [heading](guide.md)\n\n'
    + '[angled](<https://angle.example/path>) and [entity](https://query.example/?a=1&amp;b=2) and [escaped](guide\\(draft\\).md)\n\n'
    + '`[code](https://code.example)`\n\n```md\n[docs]: wrong.md\n```\n\n'
    + '[docs]: ../manual.md\n[collapsed]: collapsed.md\n[shortcut]: shortcut.md\n';
  const settings: EditorSettings = {
    syntaxVisibility: 'activeLine', readingPreset: 'default', fontFamily: 'inherit',
    fontSize: null, lineHeight: null, contentWidth: null, showLineNumbers: false,
    renderImages: true, renderTables: true, allowRemoteImages: false, isTrusted: true,
    screenReaderMode: false, lineNumberStart: 1,
  };
  const failures: unknown[] = [];
  const view = new EditorView({
    parent: document.getElementById('editor')!,
    state: EditorState.create({
      doc: source,
      extensions: [markdown({ extensions: GFM }), liveRendering(
        () => settings, () => false, async () => undefined, () => {}, error => { if (error) failures.push(error); },
      )],
    }),
  });
  try {
    check(ensureSyntaxTree(view.state, source.length, 1000), 'Markdown should parse');
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const expected = [
      ['inline', 'https://example.com'], ['reference', '../manual.md'],
      ['collapsed', 'collapsed.md'], ['shortcut', 'shortcut.md'],
      ['https://example.net', 'https://example.net'], ['https://example.org', 'https://example.org'],
      ['heading', 'guide.md'],
      ['angled', 'https://angle.example/path'], ['entity', 'https://query.example/?a=1&b=2'],
      ['escaped', 'guide(draft).md'],
    ];
    const verify = () => {
      check(failures.length === 0, `Rendering failed: ${failures}`);
      for (const [label, target] of expected) {
        const link = Array.from(view.dom.querySelectorAll<HTMLElement>('.lm-link')).find(element => element.textContent === label);
        check(link, `Missing rendered link label: ${label}`);
        check(link.title.startsWith(`${target} (`), `Missing destination tooltip for ${label}: ${link.title}`);
        check(/(?:Cmd|Ctrl)-click to follow/.test(link.title), `Missing follow hint for ${label}`);
        const style = getComputedStyle(link);
        check(style.textDecorationLine.includes('underline'), `Missing underline for ${label}`);
        check(style.color !== getComputedStyle(view.contentDOM).color, `Missing link color for ${label}`);
        const position = view.state.doc.toString().indexOf(label) + 1;
        check(linkTargetAt(view.state, position) === target, `Incorrect follow destination for ${label}: ${linkTargetAt(view.state, position)}`);
      }
      check(!Array.from(view.dom.querySelectorAll('.lm-link')).some(link => link.textContent?.includes('code.example')), 'Code must remain literal');
    };
    for (const [sourceTarget, target] of [
      ['<https://angle.example/path>', 'https://angle.example/path'],
      ['https://query.example/?a=1&amp;b=2', 'https://query.example/?a=1&b=2'],
      ['guide\\(draft\\).md', 'guide(draft).md'],
    ]) {
      const position = source.indexOf(sourceTarget) + 2;
      check(linkTargetAt(view.state, position) === target, `Source destination clicks must resolve ${sourceTarget}`);
    }
    verify();
    view.dispatch({ selection: { anchor: source.indexOf('inline') + 2 } });
    verify();
    view.dispatch({ selection: { anchor: 0 } });
    verify();
    const definition = source.indexOf('../manual.md');
    view.dispatch({ changes: { from: definition, to: definition + '../manual.md'.length, insert: '../updated.md' } });
    expected[1][1] = '../updated.md';
    verify();
  } finally {
    view.destroy();
  }
}

// A newly opened VS Code webview can start hidden before its first frame.
async function whenVisible(): Promise<void> {
  if (document.hidden) { requestAnimationFrame(whenVisible); return; }
  try { await run(); vscode.postMessage({}); }
  catch (error) { vscode.postMessage({ error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
}
requestAnimationFrame(whenVisible);
