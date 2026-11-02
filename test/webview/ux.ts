import { EditorView } from '@codemirror/view';
import { EditorSettings } from '../../src/protocol';

declare function acquireVsCodeApi(): { postMessage(message: { error?: string }): void };
const report = acquireVsCodeApi();
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function settle(): Promise<void> { await frame(); await frame(); await frame(); }
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function pointerClick(element: HTMLElement): void {
  const rect = element.getBoundingClientRect();
  const options = { bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1,
    clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  element.dispatchEvent(new MouseEvent('mousedown', options));
  check(element.isConnected, 'Mouse down must not remove an interactive widget before its click');
  element.dispatchEvent(new MouseEvent('mouseup', { ...options, buttons: 0 }));
  element.dispatchEvent(new MouseEvent('click', { ...options, buttons: 0 }));
}

async function run(): Promise<void> {
  const source = 'Intro\n\n# First **section**\n\nProse with `misspeledCode` and [link](https://example.com).\n\n'
    + '```ts\nconst value = 1;\n\n```\n\n'
    + '| Name | Value |\n| --- | --- |\n| alpha | **beta** |\n| [jump](#distant-section) | More |\n\n'
    + '![Remote illustration](https://example.invalid/image.png)\n\n![Local illustration](missing.png)\n\n'
    + '## First section\n\n## Café &amp; tea\n\n' + 'Long document paragraph.\n\n'.repeat(150) + '# Distant section\n\nEnd.\n';
  const settings: EditorSettings = { syntaxVisibility: 'activeLine', readingPreset: 'default', fontFamily: 'inherit',
    fontSize: null, lineHeight: null, contentWidth: null, showLineNumbers: false, renderImages: true,
    renderTables: true, allowRemoteImages: false, isTrusted: true, screenReaderMode: false, lineNumberStart: 1, spellcheck: false };
  const sessionId = 'ux-test';
  const messages: Array<Record<string, any>> = [];
  const copied: string[] = [];
  let clipboardAvailable = true;
  const send = (message: unknown) => window.postMessage(message, '*');
  document.documentElement.dataset.sessionId = sessionId;
  Object.defineProperty(window, 'acquireVsCodeApi', { configurable: true, value: () => ({
    getState: () => undefined, setState: () => {},
    postMessage: (message: Record<string, any>) => {
      messages.push(message);
      if (message.type === 'ready') send({ type: 'initialize', sessionId, recoveryId: 'a'.repeat(32), text: source,
        version: 1, eol: '\n', readonly: false, visible: true, settings });
      if (message.type === 'resource') send({ type: 'resourceResult', requestId: message.requestId, error: 'Image could not be loaded.' });
      if (message.type === 'copyText') { if (clipboardAvailable) copied.push(message.text); send({ type: 'clipboardResult', requestId: message.requestId, copied: clipboardAvailable }); }
    },
  }) });
  await import('../../src/webview/editor');
  await settle();
  const root = document.querySelector<HTMLElement>('.cm-editor');
  check(root, 'Editor should initialize through its real ready/initialize protocol');
  const view = EditorView.findFromDOM(root)!;
  const command = async (action: string) => { send({ type: 'command', action }); await settle(); };
  const select = async (position: number) => {
    view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'start' }) });
    await settle();
  };
  try {
    check(view.contentDOM.spellcheck === false, 'Spellcheck must default off');
    const controls = root.querySelector<HTMLElement>('.lm-code-controls');
    check(controls && controls.textContent?.includes('ts'), 'Code controls must show the fence language');
    pointerClick(controls.querySelector('button')!);
    await settle();
    check(copied.pop() === 'const value = 1;\n\n', 'Copy code must preserve whitespace and omit fences');
    check(controls.querySelector('button')!.textContent === 'Copied', 'Copy must provide feedback');
    clipboardAvailable = false;
    pointerClick(controls.querySelector('button')!);
    await settle();
    check(controls.querySelector('button')!.textContent === 'Retry copy', 'Clipboard failures must provide a retry');
    clipboardAvailable = true;
    pointerClick(controls.querySelector('button')!);
    await settle();
    check(copied.pop() === 'const value = 1;\n\n', 'Retry must copy the same code');

    const bodyCells = root.querySelectorAll<HTMLElement>('.lm-table-widget td');
    check(bodyCells.length === 4, 'Fixture should render body cells');
    pointerClick(bodyCells[1]);
    await settle();
    check(view.state.selection.main.head === source.indexOf('**beta**'), 'Click must enter the selected cell, not the start of its row');
    await select(0);
    const header = root.querySelectorAll<HTMLElement>('.lm-table-widget th')[1];
    header.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
    await settle();
    check(view.state.selection.main.head === source.indexOf('Value |'), 'F2 must enter the selected header cell');
    await select(0);

    const remote = () => Array.from(root.querySelectorAll<HTMLElement>('.lm-image-widget')).find(widget => widget.textContent?.includes('Remote illustration'));
    check(remote()?.textContent?.includes('Remote images disabled'), 'Remote placeholders must explain the disabled setting');
    check(!messages.some(message => message.type === 'resource' && message.src.startsWith('https:')), 'Disabled remote images must not request resources');
    pointerClick(remote()!.querySelector('button')!);
    check(messages.some(message => message.type === 'imageSettings'), 'Image settings must open through the host');
    check(view.state.selection.main.head === 0, 'Image settings must not enter the image source');
    check(root.textContent?.includes('Local illustration — Image unavailable'), 'Failed local images must keep alt text and explain unavailability');

    root.querySelector('.lm-table-widget a')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    await settle();
    check(view.state.selection.main.head === source.indexOf('# Distant section'), 'Same-document links inside tables must navigate in the editor');
    await select(0);

    await command('goToHeading');
    const picker = messages.find(message => message.type === 'pickHeading');
    check(picker?.headings.some((heading: { slug: string }) => heading.slug === 'first-section-1'), 'Heading picker must expose unique duplicate slugs');
    check(picker?.headings.some((heading: { slug: string }) => heading.slug === 'distant-section'), 'Picker must include distant headings');
    check(picker?.headings.some((heading: { label: string }) => heading.label === 'Café & tea'), 'Picker must decode heading entities');
    send({ type: 'navigateHeading', slug: 'distant-section' });
    await settle();
    check(view.state.selection.main.head === source.indexOf('# Distant section'), 'Heading picker must select the requested section');
    check(window.scrollY > 1000, 'Heading navigation must scroll to distant sections');
    await command('copyHeadingLink');
    check(copied.pop() === '#distant-section', 'Copy heading link must use the current section');

    await select(0);
    send({ type: 'configuration', settings: { ...settings, spellcheck: true } });
    await settle();
    check(view.contentDOM.spellcheck, 'Spellcheck must update without reopening');
    const inline = root.querySelector('.lm-inline-code');
    check(inline?.closest('[spellcheck="false"]') || inline?.querySelector('[spellcheck="false"]'), 'Inline code must be excluded from spellcheck');
    await command('toggleSource');
    check(!root.querySelector('.lm-code-controls'), 'Source mode must preserve editable fences');
    const codePosition = source.indexOf('misspeledCode');
    const dom = view.domAtPos(codePosition).node;
    check((dom instanceof Element ? dom : dom.parentElement)?.closest('[spellcheck="false"]'), 'Code must remain excluded in source mode');
    const urlDOM = view.domAtPos(source.indexOf('https://example.com') + 2).node;
    check((urlDOM instanceof Element ? urlDOM : urlDOM.parentElement)?.closest('[spellcheck="false"]'), 'Link destinations must be excluded in source mode');
    await command('toggleSource');
    send({ type: 'configuration', settings: { ...settings, isTrusted: false } });
    await settle();
    check(remote()?.textContent?.includes('Restricted Mode'), 'Restricted Mode must explain why images cannot load');
    send({ type: 'configuration', settings: { ...settings, allowRemoteImages: true } });
    await settle();
    check(remote()?.textContent?.includes('Image unavailable'), 'Permitted but failed remote images must show unavailability');
    check(view.state.doc.toString() === source, 'Presentation actions must preserve all Markdown bytes');
    check(!messages.some(message => message.type === 'edit' || message.type === 'draft'), 'Presentation actions must not create document edits');
  } finally { view.destroy(); }
}

async function whenVisible(): Promise<void> {
  if (document.hidden) { requestAnimationFrame(whenVisible); return; }
  try { await run(); report.postMessage({}); }
  catch (error) { report.postMessage({ error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
}
requestAnimationFrame(whenVisible);
