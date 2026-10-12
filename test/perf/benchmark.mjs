import os from 'node:os';
import { randomUUID } from 'node:crypto';

const [sampleArg = '100', intervalArg = '35', inputText = 'a', waitArg = '30000'] = process.argv.slice(2);
const sampleCount = Number(sampleArg);
const intervalMs = Number(intervalArg);
const maxWaitMs = Number(waitArg);
const formattingProbe = process.env.LIVE_MARKDOWN_FORMATTING_PROBE === '1';
const nativeEditor = process.env.LIVE_MARKDOWN_CDP_EDITOR === 'native';
const dispatchStart = process.env.LIVE_MARKDOWN_CDP_START === 'dispatch';
const inputStartLabel = nativeEditor || dispatchStart ? 'renderer pre-dispatch' : 'beforeinput';
if (formattingProbe && inputStartLabel !== 'beforeinput') throw new Error('The formatting probe requires the Live Markdown webview.');
const formattingText = formattingProbe ? inputText.match(/\*\*(.+?)\*\*/s)?.[1] : undefined;
if (formattingProbe && !formattingText) {
  throw new Error('Formatting probe input must contain a bold Markdown span such as **LiveFormatProbe**.');
}
if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 10000) throw new Error('Sample count must be an integer from 1 to 10000.');
if (!Number.isFinite(intervalMs) || intervalMs < 0 || intervalMs > 10000) throw new Error('Input interval must be between 0 and 10000 ms.');
if (!inputText || new TextEncoder().encode(inputText).length > 4096) throw new Error('Each input must contain between 1 byte and 4 KiB.');
if (!Number.isFinite(maxWaitMs) || maxWaitMs < 0 || maxWaitMs > 300000) throw new Error('Result wait must be between 0 and 300000 ms.');

const port = Number(process.env.LIVE_MARKDOWN_CDP_PORT ?? 9231);
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const workbench = targets.find(item => item.type === 'page' && item.url.includes('/workbench/workbench.html'));
if (!workbench) throw new Error(`No VS Code workbench found on DevTools port ${port}.`);
const inputEvents = new Map();
const compositorFrames = { seen: 0, firstAfterInput: new Map(), swapAfterInput: new Map() };
const compositorSwapTimestamps = [];
const formattingChanges = new Map();
const visibleSourceChanges = new Map();

const workbenchSocket = new WebSocket(workbench.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { workbenchSocket.onopen = resolve; workbenchSocket.onerror = reject; });
const workbenchTargetId = 1;
const activeFrame = nativeEditor ? undefined : await new Promise(resolve => {
  workbenchSocket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id !== workbenchTargetId) return;
    resolve(message.result?.result?.value);
  };
  workbenchSocket.send(JSON.stringify({
    id: workbenchTargetId,
    method: 'Runtime.evaluate',
    params: {
      returnByValue: true,
      expression: `(() => [...document.querySelectorAll('iframe.webview')]
        .filter(frame => getComputedStyle(frame).visibility === 'visible' && frame.src.startsWith('vscode-webview://'))
        .map(frame => new URL(frame.src).searchParams.get('id'))[0] ?? null)()`,
    },
  }));
});
workbenchSocket.close();
const target = nativeEditor
  ? workbench
  : targets.find(item => item.type === 'iframe' && item.url.startsWith('vscode-webview://') && new URL(item.url).searchParams.get('id') === activeFrame);
if (!target) throw new Error(`No active Live Markdown webview found on DevTools port ${port}. Open a Markdown file in Live Markdown and try again.`);
const compositorSocket = new WebSocket(workbench.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { compositorSocket.onopen = resolve; compositorSocket.onerror = reject; });
const compositorCommands = new Map();
let compositorCommandId = 0;
let nextCompositorSequence = 1;
compositorSocket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Page.screencastFrame') {
    const arrivedAt = performance.now();
    const swapTimestamp = message.params.metadata?.timestamp;
    if (Number.isFinite(swapTimestamp)) compositorSwapTimestamps.push(swapTimestamp * 1000);
    compositorFrames.seen++;
    for (;;) {
      const input = inputEvents.get(nextCompositorSequence);
      if (!input) break;
      if (input.compositorFrameMs !== undefined) { nextCompositorSequence++; continue; }
      if (arrivedAt < input.receivedAt) break;
      input.compositorFrameMs = arrivedAt - input.receivedAt;
      if (Number.isFinite(swapTimestamp) && Number.isFinite(input.timeOrigin) && Number.isFinite(input.input)) {
        input.compositorSwapMs = swapTimestamp * 1000 - (input.timeOrigin + input.input);
        compositorFrames.swapAfterInput.set(nextCompositorSequence, input.compositorSwapMs);
      }
      compositorFrames.firstAfterInput.set(nextCompositorSequence, input.compositorFrameMs);
      nextCompositorSequence++;
    }
    compositorSocket.send(JSON.stringify({ id: ++compositorCommandId, method: 'Page.screencastFrameAck', params: { sessionId: message.params.sessionId } }));
  }
  if (message.id && compositorCommands.has(message.id)) {
    compositorCommands.get(message.id)(message);
    compositorCommands.delete(message.id);
  }
};
const compositorCommand = (method, params = {}) => new Promise(resolve => {
  const id = ++compositorCommandId;
  compositorCommands.set(id, resolve);
  compositorSocket.send(JSON.stringify({ id, method, params }));
});
const enableScreencast = async () => {
  await compositorCommand('Page.bringToFront');
  await compositorCommand('Page.enable');
  const started = await compositorCommand('Page.startScreencast', { format: 'jpeg', quality: 40, maxWidth: 960, maxHeight: 600, everyNthFrame: 1 });
  if (started.error) throw new Error(`Could not start compositor capture: ${started.error.message}`);
};
try { await enableScreencast(); }
catch (error) { compositorSocket.close(); throw error; }

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
const nonce = randomUUID().replaceAll('-', '');
const worldName = `live-markdown-performance-${nonce}`;
const bindingName = `lmPerfReport${nonce}`;
let commandId = 0;
const pendingCommands = new Map();
const samples = [];
const operations = [];
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.bindingCalled' && message.params.name === bindingName) {
    try {
      const value = JSON.parse(message.params.payload);
      if (value.kind === 'operation') operations.push(value);
      else if (value.kind === 'input') inputEvents.set(value.sequence, { ...value, receivedAt: performance.now() });
      else if (value.kind === 'formatting') formattingChanges.set(value.sequence, value);
      else if (value.kind === 'visible-source') visibleSourceChanges.set(value.sequence, value);
      else samples.push(value);
    } catch {}
  }
  if (message.id && pendingCommands.has(message.id)) {
    pendingCommands.get(message.id)(message);
    pendingCommands.delete(message.id);
  }
};

const command = (method, params = {}) => new Promise(resolve => {
  const id = ++commandId;
  pendingCommands.set(id, resolve);
  socket.send(JSON.stringify({ id, method, params }));
});

try {
  const tree = (await command('Page.getFrameTree')).result.frameTree;
  const editorFrame = nativeEditor ? tree.frame : tree.childFrames?.[0]?.frame;
  if (!editorFrame) throw new Error('The Live Markdown editor frame is not ready.');
  const contextId = (await command('Page.createIsolatedWorld', {
    frameId: editorFrame.id,
    worldName,
  })).result.executionContextId;
  await command('Runtime.addBinding', {
    name: bindingName,
    executionContextName: worldName,
  });

  const nativeSetup = `(() => {
    const editor = [...document.querySelectorAll('.monaco-editor')].find(item => {
      const rect = item.getBoundingClientRect();
      const text = item.querySelector('.view-lines')?.textContent.replace(/\\s+/g, ' ').trim();
      return rect.width > 100 && rect.height > 100 && text.includes('Typing paint fixture');
    });
    const line = editor?.querySelector('.view-line');
    if (!line) return { status: 'missing-native-editor' };
    const rect = line.getBoundingClientRect();
    return { status: 'ready', x: Math.max(rect.left + 8, 60), y: rect.top + rect.height / 2 };
  })()`;
  const setup = await command('Runtime.evaluate', {
    contextId,
      returnByValue: true,
      expression: `(() => {
        const editor = ${nativeEditor
        ? "[...document.querySelectorAll('.monaco-editor')].find(item => { const rect = item.getBoundingClientRect(); const text = item.querySelector('.view-lines')?.textContent.replace(/\\s+/g, ' ').trim(); return rect.width > 100 && rect.height > 100 && text?.includes('Typing paint fixture'); })?.querySelector('.view-lines')"
        : "document.querySelector('.cm-content[contenteditable=\\\"true\\\"]')"};
      if (!editor) return 'missing-editor';
      if (!${nativeEditor}) editor.focus();
      window.__lmPerfSamples = [];
      window.__lmPerfInputSequence = 0;
      window.__lmPerfFormattingProbe = ${formattingProbe};
      window.__lmPerfFormattingText = ${JSON.stringify(formattingText ?? '')};
      window.__lmPerfLongTasks = [];
      window.__lmPerfVisibleSource = editor;
      window.__lmPerfVisibleRoot = ${nativeEditor ? "editor.closest('.monaco-editor') ?? editor" : 'editor'};
      const visibleSourceText = () => ${nativeEditor
        ? "window.__lmPerfVisibleRoot?.querySelector('.view-lines')?.textContent ?? ''"
        : "window.__lmPerfVisibleRoot?.textContent ?? ''"};
      new MutationObserver(() => {
        const current = visibleSourceText();
        for (const sample of window.__lmPerfSamples) {
          if (sample.visibleMutation !== undefined || current === sample.visibleTextBefore) continue;
          sample.visibleMutation = performance.now();
          sample.visibleTextAfter = current;
          window[${JSON.stringify(bindingName)}](JSON.stringify({
            kind: 'visible-source', sequence: sample.sequence, mutation: sample.visibleMutation,
            timeOrigin: performance.timeOrigin, beforeLength: sample.visibleTextBefore.length,
            afterLength: current.length,
          }));
          break;
        }
      }).observe(window.__lmPerfVisibleRoot, { childList: true, characterData: true, subtree: true });
      window.__lmPerfLongTaskSupported = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask') === true;
      if (window.__lmPerfLongTaskSupported) {
        const observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) window.__lmPerfLongTasks.push({ start: entry.startTime, duration: entry.duration });
        });
        observer.observe({ type: 'longtask', buffered: true });
      }
      if (window.__lmPerfFormattingProbe) {
        const editorView = document.querySelector('.cm-content');
        let formattedCount = [...editorView.querySelectorAll('.lm-strong')].filter(node => node.textContent.includes(window.__lmPerfFormattingText)).length;
        new MutationObserver(() => {
          const nextCount = [...editorView.querySelectorAll('.lm-strong')].filter(node => node.textContent.includes(window.__lmPerfFormattingText)).length;
          if (nextCount <= formattedCount) return;
          formattedCount = nextCount;
          window[${JSON.stringify(bindingName)}](JSON.stringify({
            kind: 'formatting', sequence: window.__lmPerfInputSequence,
            mutation: performance.now(), timeOrigin: performance.timeOrigin,
          }));
        }).observe(editorView, { childList: true, subtree: true, attributes: true });
      }
      const report = sample => {
        sample.longTaskDurations = window.__lmPerfLongTasks
          .filter(task => task.start >= sample.input && task.start <= performance.now())
          .map(task => task.duration);
        window[${JSON.stringify(bindingName)}](JSON.stringify(sample));
      };
      const recordInput = sequence => {
        window.__lmPerfInputSequence = sequence;
        const sample = { sequence, input: performance.now(), visibleTextBefore: visibleSourceText() };
        window.__lmPerfSamples.push(sample);
        window[${JSON.stringify(bindingName)}](JSON.stringify({ kind: 'input', sequence: sample.sequence, input: sample.input, timeOrigin: performance.timeOrigin }));
        requestAnimationFrame(() => {
          sample.firstFrame = performance.now();
          requestAnimationFrame(() => {
            sample.secondFrame = performance.now();
            if (${nativeEditor} || sample.ack !== undefined) report(sample);
          });
        });
      };
      ${nativeEditor || dispatchStart
        ? 'window.__lmPerfRecordNativeInput = sequence => recordInput(sequence);'
        : "window.addEventListener('beforeinput', () => recordInput(++window.__lmPerfInputSequence), true);"}
      window.addEventListener('message', event => {
        if (event.data?.type !== 'ack') return;
        const ack = performance.now();
        const revision = event.data.clientRevision;
        const covered = window.__lmPerfSamples.filter(item => item.ack === undefined
          && (Number.isSafeInteger(revision) ? item.sequence <= revision : item.sequence === window.__lmPerfSamples.find(sample => sample.ack === undefined)?.sequence));
        for (const sample of covered) {
          sample.ack = ack;
          if (sample.secondFrame !== undefined) report(sample);
        }
        window[${JSON.stringify(bindingName)}](JSON.stringify({
          kind: 'operation', clientRevision: revision, ack,
          hostProcessingMs: event.data.hostProcessingMs,
          recoveryWaitMs: event.data.recoveryWaitMs,
          workspaceEditMs: event.data.workspaceEditMs,
        }));
      }, true);
      return 'ready';
    })()`,
  });
  if (nativeEditor) {
    if (setup.result?.result?.value !== 'ready') {
      const reason = setup.result?.exceptionDetails?.text ?? setup.result?.result?.value ?? 'unknown result';
      throw new Error(`Could not instrument the native Markdown editor surface (${reason}).`);
    }
    const position = await command('Runtime.evaluate', { contextId, returnByValue: true, expression: nativeSetup });
    const point = position.result?.result?.value;
    if (point?.status !== 'ready') throw new Error('Could not locate the native Markdown editor surface.');
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await new Promise(resolve => setTimeout(resolve, 100));
  } else if (setup.result?.result?.value !== 'ready') throw new Error(`Could not attach to the editable CodeMirror surface (${setup.result?.result?.value ?? 'unknown error'}).`);

  for (let index = 0; index < sampleCount; index++) {
    const insertion = { text: inputText };
    if (nativeEditor || dispatchStart) {
      // Wait for the renderer to snapshot source and record the start before
      // dispatching input. Sending both commands without this barrier can let
      // Input.insertText win the race and make a real edit look like no change.
      await command('Runtime.evaluate', {
        contextId,
        expression: `window.__lmPerfRecordNativeInput(${index + 1})`,
      });
      await command('Input.insertText', insertion);
    } else {
      await command('Input.insertText', insertion);
    }
    if (intervalMs) await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  const waitStarted = Date.now();
  while ((samples.length < sampleCount
    || inputEvents.size < sampleCount
    || compositorFrames.swapAfterInput.size < sampleCount
    || visibleSourceChanges.size < sampleCount
    || (formattingProbe && formattingChanges.size < sampleCount))
    && Date.now() - waitStarted < maxWaitMs) await new Promise(resolve => setTimeout(resolve, 25));
  if (samples.length !== sampleCount) {
    throw new Error(`Captured ${samples.length} of ${sampleCount} ${inputStartLabel} samples. Results require complete input coverage.`);
  }
  if (inputEvents.size !== sampleCount || compositorFrames.swapAfterInput.size !== sampleCount) {
    throw new Error(`Only ${compositorFrames.swapAfterInput.size} of ${sampleCount} inputs were matched to compositor frame swaps. Results require complete frame coverage.`);
  }
  if (visibleSourceChanges.size !== sampleCount) {
    const finalVisible = await command('Runtime.evaluate', {
      contextId,
      returnByValue: true,
      expression: nativeEditor
        ? "window.__lmPerfVisibleRoot?.querySelector('.view-lines')?.textContent ?? ''"
        : "window.__lmPerfVisibleRoot?.textContent ?? ''",
    });
    const finalLength = finalVisible.result?.result?.value?.length;
    const missing = samples.filter(sample => !visibleSourceChanges.has(sample.sequence))
      .map(sample => `${sample.sequence}:${sample.visibleTextBefore?.length ?? '?'}→${sample.visibleTextAfter?.length ?? '?'}`);
    throw new Error(`Only ${visibleSourceChanges.size} of ${sampleCount} inputs changed visible source (missing ${missing.join(', ')}; first visible length ${samples[0]?.visibleTextBefore?.length ?? '?'}, final visible length ${finalLength ?? '?'}). Results require complete visible-source coverage.`);
  }

  const quantile = (values, q) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.ceil(q * sorted.length) - 1] : null;
  };
  const summarize = values => ({
    n: values.filter(Number.isFinite).length,
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    max: quantile(values, 1),
  });
  const rows = [
    { metric: `${inputStartLabel} to next animation frame (proxy, ms)`, values: samples.map(sample => sample.firstFrame - sample.input) },
    { metric: `${inputStartLabel} to second animation frame (proxy, ms)`, values: samples.map(sample => sample.secondFrame - sample.input) },
    { metric: `${inputStartLabel} to compositor frame swap timestamp (CDP clock-aligned, ms)`, values: [...compositorFrames.swapAfterInput.values()] },
    { metric: `${inputStartLabel} to visible source DOM mutation (ms)`, values: [...visibleSourceChanges.values()].map(value => {
      const input = inputEvents.get(value.sequence);
      return input && value.timeOrigin === input.timeOrigin ? value.mutation - input.input : NaN;
    }) },
    { metric: `${inputStartLabel} to screencast event arrival (includes capture/transport, ms)`, values: [...compositorFrames.firstAfterInput.values()] },
    ...(formattingProbe ? [
      { metric: `${inputStartLabel} to visible strong-mark DOM mutation (ms)`, values: [...formattingChanges.values()].map(value => {
        const input = inputEvents.get(value.sequence);
        return input && value.timeOrigin === input.timeOrigin ? value.mutation - input.input : NaN;
      }) },
      { metric: `${inputStartLabel} to compositor frame swap after formatting becomes visible (ms)`, values: [...formattingChanges.entries()].map(([sequence, value]) => {
        const input = inputEvents.get(sequence);
        if (!input || value.timeOrigin !== input.timeOrigin) return NaN;
        const mutationEpoch = value.timeOrigin + value.mutation;
        const inputEpoch = input.timeOrigin + input.input;
        const swapEpoch = compositorSwapTimestamps.find(timestamp => timestamp >= mutationEpoch);
        return swapEpoch === undefined ? NaN : swapEpoch - inputEpoch;
      }) },
      { metric: 'formatting DOM mutation to following compositor frame swap (ms)', values: [...formattingChanges.values()].map(value => {
        const mutationEpoch = value.timeOrigin + value.mutation;
        const swapEpoch = compositorSwapTimestamps.find(timestamp => timestamp >= mutationEpoch);
        return swapEpoch === undefined ? NaN : swapEpoch - mutationEpoch;
      }) },
    ] : []),
      ...(!nativeEditor ? [{ metric: `${inputStartLabel} to host acknowledgement (ms)`, values: samples.map(sample => sample.ack - sample.input) }] : []),
    { metric: 'host wait for durable recovery journal (ms)', values: operations.map(operation => operation.recoveryWaitMs).filter(Number.isFinite) },
    { metric: 'extension-host edit preparation (ms; excludes WorkspaceEdit wait)', values: operations.map(operation => operation.hostProcessingMs).filter(Number.isFinite) },
    { metric: 'VS Code WorkspaceEdit wait (ms)', values: operations.map(operation => operation.workspaceEditMs).filter(Number.isFinite) },
  ];
  const longTaskDurations = [...new Set(samples.flatMap(sample => sample.longTaskDurations ?? []))];
  console.log(JSON.stringify({
    samplesRequested: sampleCount,
    samplesCaptured: samples.length,
    compositorFramesObserved: compositorFrames.seen,
    inputsWithCompositorFrame: compositorFrames.firstAfterInput.size,
    inputsWithVisibleSourceMutation: visibleSourceChanges.size,
    formattingProbe,
    formattingMutationsObserved: formattingChanges.size,
    hostAcknowledgements: operations.length,
    inputIntervalMs: intervalMs,
    inputBytes: new TextEncoder().encode(inputText).length,
    resultWaitLimitMs: maxWaitMs,
    longTaskApiSupported: samples.some(sample => sample.longTaskDurations !== undefined),
    observedLongTasks: longTaskDurations.length,
    maxObservedLongTaskMs: longTaskDurations.length ? Math.max(...longTaskDurations) : 0,
    system: { platform: os.platform(), release: os.release(), architecture: os.arch(), cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem() },
    measurements: rows.map(row => ({ metric: row.metric, ...summarize(row.values) })),
    note: `Animation-frame callbacks are proxies. Timings start at ${nativeEditor ? 'a renderer timestamp recorded immediately before CDP text insertion in the native source editor' : dispatchStart ? 'a renderer timestamp recorded immediately before CDP text insertion in the Live Markdown webview' : 'the webview beforeinput event in Live Markdown'}. The compositor swap metric subtracts that start time (aligned by performance.timeOrigin) from Page.screencastFrame metadata.timestamp, documented by CDP as the frame-swap timestamp; the separate event-arrival metric includes capture and transport delay. A compositor frame swap is not proof of photons at the physical display. Run against a disposable fixture; each sample inserts the supplied text into the open document.`,
  }, null, 2));
} finally {
  await compositorCommand('Page.stopScreencast').catch(() => undefined);
  compositorSocket.close();
  socket.close();
}
