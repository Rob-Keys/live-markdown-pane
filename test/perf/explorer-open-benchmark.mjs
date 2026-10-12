import { basename, resolve } from 'node:path';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const port = Number(process.env.LIVE_MARKDOWN_CDP_PORT ?? 9243);
const files = process.argv.slice(2);
if (!files.length) throw new Error('Pass disposable Markdown files already listed in the VS Code Explorer.');
const prefixes = await Promise.all(files.map(async file => (await readFile(file, 'utf8')).slice(0, 4096)));
if (new Set(prefixes).size !== prefixes.length) throw new Error('Each fixture needs distinct visible source in its first 4 KiB.');

async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => { socket.onopen = resolveOpen; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    else if (message.method) for (const listener of listeners) listener(message);
  };
  const send = (method, params = {}) => new Promise(resolveMessage => {
    const id = ++nextId;
    pending.set(id, resolveMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { socket, send, onEvent: listener => listeners.add(listener) };
}

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const workbenchTarget = targets.find(target => target.type === 'page' && target.url.includes('/workbench/workbench.html'));
if (!workbenchTarget) throw new Error(`No VS Code workbench found on DevTools port ${port}.`);
const workbench = await connect(workbenchTarget);
const pageCommand = workbench.send;
await pageCommand('Page.bringToFront');
await pageCommand('Page.enable');
const frameSwaps = [];
workbench.onEvent(message => {
  if (message.method !== 'Page.screencastFrame') return;
  const timestamp = message.params.metadata?.timestamp;
  if (Number.isFinite(timestamp)) frameSwaps.push(timestamp * 1000);
  void pageCommand('Page.screencastFrameAck', { sessionId: message.params.sessionId });
});
const screencast = await pageCommand('Page.startScreencast', { format: 'jpeg', quality: 40, maxWidth: 960, maxHeight: 600, everyNthFrame: 1 });
if (screencast.error) throw new Error(`Could not start compositor capture: ${screencast.error.message}`);

async function evaluate(expression) {
  const response = await pageCommand('Runtime.evaluate', { expression, returnByValue: true });
  if (response.error || response.result?.exceptionDetails) throw new Error(`Workbench evaluation failed: ${response.error?.message ?? response.result.exceptionDetails.text}`);
  return response.result?.result?.value;
}

async function visibleExplorerRow(name) {
  return evaluate(`(() => {
    const tree = document.querySelector('[role="tree"][aria-label="Files Explorer"]');
    if (!tree) return { tree: false };
    const viewport = tree.getBoundingClientRect();
    const row = [...(tree?.querySelectorAll('[role="treeitem"]') ?? [])].find(item => item.getAttribute('aria-label') === ${JSON.stringify(name)});
    const wheelX = viewport.left + Math.min(80, viewport.width / 2);
    const wheelY = viewport.top + Math.min(300, viewport.height / 2);
    if (!row) return { found: false, tree: true, wheelX, wheelY };
    const bounds = row.getBoundingClientRect();
    return { found: true, x: bounds.left + Math.min(40, bounds.width / 2), y: bounds.top + bounds.height / 2,
      visible: bounds.top >= viewport.top && bounds.bottom <= viewport.bottom,
      wheelX, wheelY };
  })()`);
}

async function revealExplorerRow(name) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const row = await visibleExplorerRow(name);
    if (row?.found && row.visible) return row;
    if (row?.tree === false) throw new Error('VS Code does not have a visible Files Explorer tree.');
    if (!row) throw new Error('The workbench did not return Explorer row geometry.');
    await pageCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: row.wheelX, y: row.wheelY, deltaY: 420, deltaX: 0 });
    await sleep(35);
  }
  throw new Error(`Could not scroll ${name} into the visible Explorer range.`);
}

async function resetExplorerToTop() {
  // Explorer may restore a deep scroll position from a prior 100-file run.
  for (let attempt = 0; attempt < 60; attempt++) {
    const row = await visibleExplorerRow(basename(files[0]));
    if (row?.found && row.visible) return;
    if (row?.tree === false) throw new Error('VS Code does not have a visible Files Explorer tree.');
    if (!row) throw new Error('The workbench did not return Explorer row geometry.');
    await pageCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: row.wheelX, y: row.wheelY, deltaY: -600, deltaX: 0 });
    await sleep(25);
  }
  throw new Error(`Could not scroll ${basename(files[0])} into the visible Explorer range before benchmarking.`);
}

async function setActivationObserver(name) {
  await evaluate(`(() => {
    window.__liveMarkdownExplorerActivation?.disconnect();
    window.__liveMarkdownExplorerActivationAt = null;
    const expected = ${JSON.stringify(name)};
    const observe = () => {
      const activeName = document.querySelector('.tab.active')?.getAttribute('aria-label')?.split(',')[0]?.trim();
      if (activeName === expected && !Number.isFinite(window.__liveMarkdownExplorerActivationAt))
        window.__liveMarkdownExplorerActivationAt = performance.timeOrigin + performance.now();
    };
    const observer = new MutationObserver(observe);
    observer.observe(document.querySelector('.tabs-container') ?? document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'aria-selected'] });
    window.__liveMarkdownExplorerActivation = observer;
    observe();
  })()`);
}

async function activeExplorerTab(name) {
  return evaluate(`(() => {
    const activeName = document.querySelector('.tab.active')?.getAttribute('aria-label')?.split(',')[0]?.trim();
    const activeAt = window.__liveMarkdownExplorerActivationAt;
    const frame = [...document.querySelectorAll('iframe.webview')].find(item => getComputedStyle(item).visibility === 'visible'
      && item.src.startsWith('vscode-webview://')
      && new URL(item.src).searchParams.get('extensionId') === 'RobKeys.live-markdown-pane');
    return activeName === ${JSON.stringify(name)} ? { activeAt: Number.isFinite(activeAt) ? activeAt : null,
      activeId: frame ? new URL(frame.src).searchParams.get('id') : null } : null;
  })()`);
}

async function editableReady(activeId, name) {
  const currentTargets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = currentTargets.find(item => item.type === 'iframe' && item.url.startsWith('vscode-webview://')
    && new URL(item.url).searchParams.get('id') === activeId);
  if (!target) return undefined;
  const webview = await connect(target);
  try {
    const tree = (await webview.send('Page.getFrameTree')).result?.frameTree;
    const frame = tree?.childFrames?.[0]?.frame;
    if (!frame) return undefined;
    const world = await webview.send('Page.createIsolatedWorld', { frameId: frame.id, worldName: `explorer-open-${Date.now()}` });
    const contextId = world.result?.executionContextId;
    if (!contextId) return undefined;
    const response = await webview.send('Runtime.evaluate', {
      contextId, returnByValue: true,
      expression: `(() => { const editor = document.querySelector('.cm-content[contenteditable="true"]'); return editor ? { readyAt: performance.timeOrigin + performance.now(), title: document.title } : null; })()`,
    });
    const value = response.result?.result?.value;
    return value?.title === 'Live Markdown' && Number.isFinite(value.readyAt) ? value.readyAt : undefined;
  } finally { webview.socket.close(); }
}

async function waitForPaintFrame(readyAt, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const timestamp = frameSwaps.find(frame => frame >= readyAt);
    if (timestamp !== undefined) return timestamp;
    await sleep(20);
  }
  return undefined;
}

const samples = [];
await resetExplorerToTop();
for (const file of files) {
  const name = basename(file);
  const row = await revealExplorerRow(name);
  await setActivationObserver(name);
  const started = performance.now();
  await pageCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y });
  await pageCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: row.x, y: row.y, button: 'left', clickCount: 1 });
  await pageCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: row.x, y: row.y, button: 'left', clickCount: 1 });

  let result;
  const timeoutAt = Date.now() + 15_000;
  while (!result && Date.now() < timeoutAt) {
    const active = await activeExplorerTab(name);
    if (active?.activeAt && active.activeId) {
      const readyAt = await editableReady(active.activeId, name);
      if (readyAt) result = { activeAt: active.activeAt, readyAt };
    }
    if (!result) await sleep(35);
  }
  if (!result) throw new Error(`Explorer click did not open ${name} in an editable Live Markdown webview.`);
  const frameSwapAt = await waitForPaintFrame(result.readyAt);
  if (frameSwapAt === undefined) throw new Error(`No compositor frame was captured after ${name} became editable.`);
  samples.push({ file, bytes: (await stat(file)).size, explorerClickToEditableMs: result.readyAt - (performance.timeOrigin + started),
    tabActivationToEditableMs: result.readyAt - result.activeAt,
    explorerClickToFrameSwapMs: frameSwapAt - (performance.timeOrigin + started),
    tabActivationToFrameSwapMs: frameSwapAt - result.activeAt });
}

const quantile = (values, q) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.ceil(q * sorted.length) - 1]; };
const summarize = key => {
  const values = samples.map(sample => sample[key]);
  return { p50Ms: quantile(values, 0.5), p95Ms: quantile(values, 0.95), maxMs: Math.max(...values) };
};
const result = { versionPath: workbenchTarget.url, trigger: 'VS Code Explorer row click via Chromium input dispatch', sampleCount: samples.length,
  explorerClickToEditable: summarize('explorerClickToEditableMs'), tabActivationToEditable: summarize('tabActivationToEditableMs'),
  explorerClickToFrameSwap: summarize('explorerClickToFrameSwapMs'), tabActivationToFrameSwap: summarize('tabActivationToFrameSwapMs'), samples };
const json = JSON.stringify(result, null, 2);
if (process.env.LIVE_MARKDOWN_EXPLORER_RESULT_FILE) await writeFile(resolve(process.env.LIVE_MARKDOWN_EXPLORER_RESULT_FILE), json);
console.log(json);
await pageCommand('Page.stopScreencast');
workbench.socket.close();
