const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const vscode = require('vscode');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 15_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out opening the benchmark editor.');
    await delay(50);
  }
}

async function run() {
  const mode = process.env.LIVE_MARKDOWN_BENCHMARK_MODE;
  const file = process.env.LIVE_MARKDOWN_BENCHMARK_FIXTURE;
  const resultPath = process.env.LIVE_MARKDOWN_BENCHMARK_RESULT;
  const viewType = mode === 'native' ? 'default' : 'liveMarkdown.liveEditor';
  if (!['native', 'live'].includes(mode) || !file || !resultPath) throw new Error('Missing paired benchmark configuration.');

  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), viewType);
  await waitFor(() => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return mode === 'native'
      ? input instanceof vscode.TabInputText && input.uri.fsPath === file
      : input instanceof vscode.TabInputCustom && input.viewType === viewType && input.uri.fsPath === file;
  });
  await delay(750);

  const benchmark = path.resolve(__dirname, '../benchmark.mjs');
  const count = process.env.LIVE_MARKDOWN_BENCHMARK_SAMPLES ?? '100';
  const interval = process.env.LIVE_MARKDOWN_BENCHMARK_INTERVAL_MS ?? '35';
  const insertion = process.env.LIVE_MARKDOWN_BENCHMARK_INSERTION ?? 'a';
  const maxWait = process.env.LIVE_MARKDOWN_BENCHMARK_WAIT_MS ?? '30000';
  const env = {
    ...process.env,
    LIVE_MARKDOWN_CDP_PORT: process.env.LIVE_MARKDOWN_BENCHMARK_PORT ?? '9231',
    ...(mode === 'native'
      ? { LIVE_MARKDOWN_CDP_EDITOR: 'native', LIVE_MARKDOWN_CDP_START: '' }
      : { LIVE_MARKDOWN_CDP_EDITOR: '', LIVE_MARKDOWN_CDP_START: 'dispatch' }),
  };
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.env.LIVE_MARKDOWN_BENCHMARK_NODE ?? 'node', [benchmark, count, interval, insertion, maxWait], { env });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), Number(maxWait) + 60_000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
  if (result.code !== 0) throw new Error(`Benchmark failed (${result.code ?? result.signal}): ${result.stderr || result.stdout}`);
  const measured = JSON.parse(result.stdout);
  assert.equal(measured.samplesCaptured, Number(count));
  assert.equal(measured.inputsWithVisibleSourceMutation, Number(count));
  assert.equal(measured.inputsWithCompositorFrame, Number(count));
  fs.writeFileSync(resultPath, JSON.stringify(measured, null, 2));
  console.log(`LIVE_MARKDOWN_PAIRED_BENCHMARK_RESULT ${resultPath}`);
}

module.exports = { run };
