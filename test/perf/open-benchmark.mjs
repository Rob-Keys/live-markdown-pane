import { basename } from 'node:path';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const port = Number(process.env.LIVE_MARKDOWN_CDP_PORT ?? 9231);
const code = process.env.LIVE_MARKDOWN_CODE ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
const userDataDir = process.env.LIVE_MARKDOWN_USER_DATA_DIR;
const extensionsDir = process.env.LIVE_MARKDOWN_EXTENSIONS_DIR;
const files = process.argv.slice(2);
if (!files.length) throw new Error('Pass one or more disposable Markdown fixture paths.');
const visiblePrefixes = await Promise.all(files.map(async file => (await readFile(file, 'utf8')).slice(0, 4096)));
if (new Set(visiblePrefixes).size !== visiblePrefixes.length) {
  throw new Error('Each fixture needs distinct content in its first 4 KiB so tab switches produce a visible compositor update.');
}

async function activeEditorReady(expectedBasename) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const workbenches = targets.filter(target => target.type === 'page' && target.url.includes('/workbench/workbench.html'));
  let requestedTabOpen = false;
  for (const workbench of workbenches) {
    const page = new WebSocket(workbench.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { page.onopen = resolve; page.onerror = reject; });
    let id = 0;
    const pending = new Map();
    page.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    };
    const send = (method, params = {}) => new Promise(resolve => {
      const commandId = ++id;
      pending.set(commandId, resolve);
      page.send(JSON.stringify({ id: commandId, method, params }));
    });
    const active = (await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const activeTab = document.querySelector('.tab.active');
        const activeName = activeTab?.getAttribute('aria-label')?.split(',')[0]?.trim();
        const activeAt = window.__liveMarkdownOpenProbeActiveAt;
        const frame = [...document.querySelectorAll('iframe.webview')].find(item =>
          getComputedStyle(item).visibility === 'visible'
          && item.src.startsWith('vscode-webview://')
          && new URL(item.src).searchParams.get('extensionId') === 'RobKeys.live-markdown-pane');
        return { activeName, activeAt: Number.isFinite(activeAt) ? activeAt : null, activeId: frame ? new URL(frame.src).searchParams.get('id') : null };
      })()`,
    })).result?.result?.value;
    page.close();
    if (active?.activeName !== expectedBasename) continue;
    requestedTabOpen = true;
    if (!active.activeId) continue;
    const target = targets.find(item => item.type === 'iframe' && item.url.startsWith('vscode-webview://') && new URL(item.url).searchParams.get('id') === active.activeId);
    if (!target) continue;

    const webview = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { webview.onopen = resolve; webview.onerror = reject; });
    let commandId = 0;
    const requests = new Map();
    webview.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && requests.has(message.id)) { requests.get(message.id)(message); requests.delete(message.id); }
    };
    const command = (method, params = {}) => new Promise(resolve => {
      const requestId = ++commandId;
      requests.set(requestId, resolve);
      webview.send(JSON.stringify({ id: requestId, method, params }));
    });
    const tree = (await command('Page.getFrameTree')).result?.frameTree;
    const frame = tree?.childFrames?.[0]?.frame;
    let ready;
    if (frame) {
      const contextId = (await command('Page.createIsolatedWorld', { frameId: frame.id, worldName: `open-probe-${Date.now()}` })).result?.executionContextId;
      if (contextId) {
        const result = await command('Runtime.evaluate', {
          contextId,
          returnByValue: true,
          expression: `(() => {
            const editor = document.querySelector('.cm-content[contenteditable="true"]');
            return editor ? { readyAt: performance.timeOrigin + performance.now() } : null;
          })()`,
        });
        const value = result.result?.result?.value;
        ready = value && Number.isFinite(value.readyAt) ? value : undefined;
      }
    }
    webview.close();
    if (ready) return { readyAt: ready.readyAt, activeAt: active.activeAt };
  }
  return requestedTabOpen ? { requestedTabOpen: true } : false;
}

async function observeTabActivation(expectedBasename) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const expression = `(() => {
    window.__liveMarkdownOpenProbe?.disconnect();
    window.__liveMarkdownOpenProbeActiveAt = null;
    const expected = ${JSON.stringify(expectedBasename)};
    const observer = new MutationObserver(() => {
      const activeName = document.querySelector('.tab.active')?.getAttribute('aria-label')?.split(',')[0]?.trim();
      if (activeName === expected && !Number.isFinite(window.__liveMarkdownOpenProbeActiveAt)) {
        window.__liveMarkdownOpenProbeActiveAt = performance.timeOrigin + performance.now();
      }
    });
    observer.observe(document.querySelector('.tabs-container') ?? document.body, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'aria-selected'],
    });
    window.__liveMarkdownOpenProbe = observer;
    return true;
  })()`;
  for (const workbench of targets.filter(target => target.type === 'page' && target.url.includes('/workbench/workbench.html'))) {
    const page = new WebSocket(workbench.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { page.onopen = resolve; page.onerror = reject; });
    let id = 0;
    const response = new Promise(resolve => {
      page.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.id === 1) resolve(message);
      };
    });
    page.send(JSON.stringify({ id: ++id, method: 'Runtime.evaluate', params: { expression } }));
    await response;
    page.close();
  }
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const workbenches = targets.filter(target => target.type === 'page' && target.url.includes('/workbench/workbench.html'));
const workbench = workbenches.find(target => target.title.includes(' — ')) ?? workbenches[0];
if (!workbench) throw new Error(`No VS Code workbench found on DevTools port ${port}.`);
const page = new WebSocket(workbench.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { page.onopen = resolve; page.onerror = reject; });
const frameSwaps = [];
let pageCommandId = 0;
const pageRequests = new Map();
page.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Page.screencastFrame') {
    const timestamp = message.params.metadata?.timestamp;
    if (Number.isFinite(timestamp)) frameSwaps.push(timestamp * 1000);
    page.send(JSON.stringify({ id: ++pageCommandId, method: 'Page.screencastFrameAck', params: { sessionId: message.params.sessionId } }));
  }
  if (message.id && pageRequests.has(message.id)) {
    pageRequests.get(message.id)(message);
    pageRequests.delete(message.id);
  }
};
const pageCommand = (method, params = {}) => new Promise(resolve => {
  const id = ++pageCommandId;
  pageRequests.set(id, resolve);
  page.send(JSON.stringify({ id, method, params }));
});
await pageCommand('Page.bringToFront');
await pageCommand('Page.enable');
const screencast = await pageCommand('Page.startScreencast', { format: 'jpeg', quality: 40, maxWidth: 960, maxHeight: 600, everyNthFrame: 1 });
if (screencast.error) throw new Error(`Could not start compositor capture: ${screencast.error.message}`);
const waitForPaintFrame = async (readyAt, timeoutMs = 30000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const timestamp = frameSwaps.find(frame => frame >= readyAt);
    if (timestamp !== undefined) return timestamp;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return undefined;
};
const openFile = args => new Promise((resolve, reject) => {
  const child = spawn(code, args, { stdio: 'ignore' });
  child.once('error', reject);
  child.once('close', (status, signal) => resolve({ status, signal, returnedAt: performance.now() }));
});

const samples = [];
for (const file of files) {
  await observeTabActivation(basename(file));
  const args = [];
  if (userDataDir) args.push(`--user-data-dir=${userDataDir}`);
  if (extensionsDir) args.push(`--extensions-dir=${extensionsDir}`);
  args.push('--reuse-window', file);
  const started = performance.now();
  const startedEpoch = performance.timeOrigin + started;
  let requestReturnedAt;
  let openRequestError;
  const dispatch = openFile(args)
    .then(value => { requestReturnedAt = performance.now(); return { value }; }, error => {
      requestReturnedAt = performance.now();
      openRequestError = error;
      return { error };
    });
  let ready;
  let requestedTabSince;
  while (!ready && performance.now() - started < 30000) {
    if (openRequestError) throw openRequestError;
    const active = await activeEditorReady(basename(file));
    if (active?.readyAt && Number.isFinite(active.activeAt)) ready = active;
    else if (active?.requestedTabOpen) {
      requestedTabSince ??= performance.now();
      if (performance.now() - requestedTabSince >= 1500) {
        throw new Error(`${file} became active without a Live Markdown webview; this open path did not select the custom editor.`);
      }
    } else {
      requestedTabSince = undefined;
      if (requestReturnedAt !== undefined && performance.now() - requestReturnedAt >= 2000) {
        throw new Error(`${file} never became the active editor after the VS Code CLI returned; this open path cannot measure file-open paint.`);
      }
    }
    if (!ready) await new Promise(resolve => setTimeout(resolve, 40));
  }
  if (!ready) throw new Error(`Timed out waiting for an editable webview for ${file}.`);
  const dispatchResult = await dispatch;
  if ('error' in dispatchResult) throw dispatchResult.error;
  const opened = dispatchResult.value;
  if (opened.status !== 0) throw new Error(`VS Code could not open ${file} (exit ${opened.status ?? opened.signal}).`);
  const frameSwap = await waitForPaintFrame(ready.readyAt);
  if (frameSwap === undefined) throw new Error(`Timed out waiting for a compositor frame after the editor became editable for ${file}.`);
  const dispatched = opened.returnedAt;
  const dispatchEpoch = performance.timeOrigin + dispatched;
  samples.push({
    file,
    bytes: (await stat(file)).size,
    openRequestMs: dispatched - started,
    cliDispatchMs: dispatched - started,
    tabActivationToEditableMs: ready.readyAt - ready.activeAt,
    tabActivationToFrameSwapMs: frameSwap - ready.activeAt,
    editableFromStartMs: ready.readyAt - startedEpoch,
    editableRelativeToOpenRequestMs: ready.readyAt - dispatchEpoch,
    editableToFrameSwapMs: frameSwap - ready.readyAt,
    paintFromStartMs: frameSwap - startedEpoch,
    paintRelativeToOpenRequestMs: frameSwap - dispatchEpoch,
  });
}
const quantile = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.ceil(q * sorted.length) - 1]; };
const summarize = values => ({ p50Ms: quantile(values, 0.5), p95Ms: quantile(values, 0.95), maxMs: Math.max(...values) });
console.log(JSON.stringify({
  samples,
  summary: {
    count: samples.length,
    openRequest: summarize(samples.map(sample => sample.openRequestMs)),
    cliDispatch: summarize(samples.map(sample => sample.cliDispatchMs)),
    tabActivationToEditable: summarize(samples.map(sample => sample.tabActivationToEditableMs)),
    tabActivationToFrameSwap: summarize(samples.map(sample => sample.tabActivationToFrameSwapMs)),
    editableFromStart: summarize(samples.map(sample => sample.editableFromStartMs)),
    editableRelativeToOpenRequest: summarize(samples.map(sample => sample.editableRelativeToOpenRequestMs)),
    editableToFrameSwap: summarize(samples.map(sample => sample.editableToFrameSwapMs)),
    paintFromStart: summarize(samples.map(sample => sample.paintFromStartMs)),
    paintRelativeToOpenRequest: summarize(samples.map(sample => sample.paintRelativeToOpenRequestMs)),
  },
  note: 'The sampler verifies the requested active tab and a visible Live Markdown webview. Tab activation is timestamped by a workbench MutationObserver; editable readiness is detected from the CodeMirror contenteditable DOM. The compositor metric is the first VS Code workbench screencast frame-swap timestamp at or after editable readiness; it is a paint proxy, not proof of photons at the display. CLI handoff duration is reported separately and is not user-visible open time.',
}, null, 2));
await pageCommand('Page.stopScreencast').catch(() => undefined);
page.close();
