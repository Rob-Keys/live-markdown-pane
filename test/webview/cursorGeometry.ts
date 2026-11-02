import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { GFM } from '@lezer/markdown';
import { EditorSettings } from '../../src/protocol';
import { liveRendering } from '../../src/webview/liveRendering';

declare function acquireVsCodeApi(): { postMessage(message: { error?: string }): void };
const vscode = acquireVsCodeApi();
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const settings: EditorSettings = {
  syntaxVisibility: 'activeLine', readingPreset: 'default', fontFamily: 'inherit',
  fontSize: null, lineHeight: null, contentWidth: null, showLineNumbers: false,
  renderImages: true, renderTables: true, allowRemoteImages: false, isTrusted: true,
  screenReaderMode: false, lineNumberStart: 1,
};

async function run(): Promise<void> {
  const section = 'Plain text\n\n# Heading one\nText directly below heading\n\n## Heading two\nMore text\n\n'
    + '> A blockquote\n> Another quoted line\n\n- First list item\n- [ ] A task\n\n'
    + 'A paragraph with **bold**, *emphasis*, `inline code`, and [a link](https://example.com/long/path). '.repeat(4) + '\n\n'
    + '| Header | Other |\n| --- | --- |\n| Cell | Value |\n\nAfter table\n\n'
    + '```js\nconst example = true;\n```\n\n![Image](missing.png)\n\nAfter image\n\n';
  const source = section.repeat(8);
  const view = new EditorView({ parent: document.getElementById('editor')!, state: EditorState.create({
    doc: source, extensions: [markdown({ extensions: GFM }), EditorView.lineWrapping,
      liveRendering(() => settings, () => false, async () => undefined, () => {})],
  }) });
  try {
    check(ensureSyntaxTree(view.state, source.length, 10000), 'Fixture must parse fully');
    await frame(); await frame();
    const misses: string[] = [];
    let checked = 0;
    // Compare browser text bounds with CodeMirror's independently measured height
    // map. Vertical margins on table widgets used to shift later hits one line down.
    for (const offset of [0, 300, 900, 1600, 2400, 3600, 1600, 300, 0]) {
      window.scrollTo(0, offset);
      await frame(); await frame();
      for (const element of Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.cm-line'))) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const text = walker.currentNode;
          if (!text.textContent?.trim() || element.querySelector('.lm-image-widget')) continue;
          const range = document.createRange();
          range.selectNodeContents(text);
          for (const rect of Array.from(range.getClientRects())) {
            const y = (rect.top + rect.bottom) / 2;
            if (y < 1 || y > innerHeight - 1 || !rect.width) continue;
            const expected = view.state.doc.lineAt(view.posAtDOM(text, 0)).number;
            const position = view.posAtCoords({ x: rect.left + Math.min(rect.width / 2, 10), y });
            const actual = position === null ? null : view.state.doc.lineAt(position).number;
            checked++;
            if (actual !== expected) misses.push(JSON.stringify({ offset, expected, actual, text: text.textContent.slice(0, 35), y }));
          }
        }
      }
    }
    check(checked > 100, `Expected substantial visible hit-test coverage, got ${checked}`);
    if (misses.length) throw new Error(`Hit testing misses (${misses.length}): ${misses.slice(0, 20).join('\n')}`);

    const tablePosition = source.indexOf('| Header');
    const afterTable = source.indexOf('After table');
    const clickAfterTable = async () => {
      view.dispatch({ effects: EditorView.scrollIntoView(afterTable, { y: 'center' }) });
      await frame(); await frame();
      const element = Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.cm-line'))
        .find(line => line.textContent === 'After table' && view.posAtDOM(line, 0) === afterTable);
      check(element, 'Text following the first table must be rendered');
      const range = document.createRange();
      range.selectNodeContents(element);
      const rect = range.getBoundingClientRect();
      const event = { bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1,
        clientX: rect.left + 10, clientY: (rect.top + rect.bottom) / 2 };
      check(event.clientY > 0 && event.clientY < innerHeight, 'Click target must be visible');
      element.dispatchEvent(new MouseEvent('mousedown', event));
      document.dispatchEvent(new MouseEvent('mouseup', { ...event, buttons: 0 }));
      check(view.state.doc.lineAt(view.state.selection.main.head).from === afterTable,
        'Clicking text below a table must put the cursor on that source line');
    };
    check(view.dom.querySelector('.lm-table-scroll'), 'Fixture must include a rendered table');
    await clickAfterTable();
    // Editing the table removes its widget; leaving it restores the measured
    // block. Both transitions must preserve subsequent pointer mapping.
    view.dispatch({ selection: { anchor: tablePosition } });
    await frame(); await frame();
    check(!view.dom.querySelector(`.lm-table-widget[data-lm-position="${tablePosition}"]`), 'Active table must show source');
    await clickAfterTable();
    await frame(); await frame();
    check(view.dom.querySelector(`.lm-table-widget[data-lm-position="${tablePosition}"]`), 'Inactive table must render again');
    await clickAfterTable();
  } finally { view.destroy(); }
}

async function whenVisible(): Promise<void> {
  if (document.hidden) { requestAnimationFrame(whenVisible); return; }
  try { await run(); vscode.postMessage({}); }
  catch (error) { vscode.postMessage({ error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
}
requestAnimationFrame(whenVisible);
