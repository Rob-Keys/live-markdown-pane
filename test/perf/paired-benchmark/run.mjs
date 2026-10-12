import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(scriptDirectory, '../../..');
const executable = process.env.VSCODE_EXECUTABLE ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const port = Number(process.env.LIVE_MARKDOWN_BENCHMARK_PORT ?? 9231);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('LIVE_MARKDOWN_BENCHMARK_PORT must be a valid TCP port.');

const temporaryBase = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
const root = await fs.mkdtemp(path.join(temporaryBase, 'lmp-'));
const fixtureDirectory = path.join(root, 'workspace');
await fs.mkdir(fixtureDirectory);
const prefix = 'Typing paint fixture\n\nPlain paragraph for paired source-edit responsiveness measurements.\n';
let source = prefix;
while (Buffer.byteLength(source + 'Sample paragraph with ordinary Markdown text.\n') <= 100 * 1024) {
  source += 'Sample paragraph with ordinary Markdown text.\n';
}
source += 'x'.repeat(100 * 1024 - Buffer.byteLength(source));
const fixture = path.join(fixtureDirectory, 'typing-paint.md');
await fs.writeFile(fixture, source);

const results = [];
try {
  for (const mode of ['native', 'live']) {
    const profile = path.join(root, mode);
    const resultPath = path.join(root, `${mode}.json`);
    const exitCode = await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: repository,
      extensionTestsPath: path.join(scriptDirectory, 'suite.cjs'),
      extensionTestsEnv: {
        LIVE_MARKDOWN_BENCHMARK_MODE: mode,
        LIVE_MARKDOWN_BENCHMARK_FIXTURE: fixture,
        LIVE_MARKDOWN_BENCHMARK_RESULT: resultPath,
        LIVE_MARKDOWN_BENCHMARK_PORT: String(port),
        LIVE_MARKDOWN_BENCHMARK_SAMPLES: process.env.LIVE_MARKDOWN_BENCHMARK_SAMPLES ?? '100',
        LIVE_MARKDOWN_BENCHMARK_INTERVAL_MS: process.env.LIVE_MARKDOWN_BENCHMARK_INTERVAL_MS ?? '35',
        LIVE_MARKDOWN_BENCHMARK_INSERTION: process.env.LIVE_MARKDOWN_BENCHMARK_INSERTION ?? 'a',
        LIVE_MARKDOWN_BENCHMARK_WAIT_MS: process.env.LIVE_MARKDOWN_BENCHMARK_WAIT_MS ?? '30000',
      },
      launchArgs: [
        fixtureDirectory,
        '--disable-workspace-trust',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        `--extensions-dir=${path.join(profile, 'extensions')}`,
      ],
    });
    if (exitCode !== 0) throw new Error(`${mode} benchmark host exited with code ${exitCode}.`);
    results.push(JSON.parse(await fs.readFile(resultPath, 'utf8')));
  }
  console.log(JSON.stringify({
    fixtureBytes: Buffer.byteLength(source),
    vscodeExecutable: executable,
    samples: results.map(result => ({
      editor: result.note.includes('native source editor') ? 'native' : 'Live Markdown',
      samplesRequested: result.samplesRequested,
      samplesCaptured: result.samplesCaptured,
      inputsWithVisibleSourceMutation: result.inputsWithVisibleSourceMutation,
      inputsWithCompositorFrame: result.inputsWithCompositorFrame,
      inputIntervalMs: result.inputIntervalMs,
      inputBytes: result.inputBytes,
      longTaskApiSupported: result.longTaskApiSupported,
      observedLongTasks: result.observedLongTasks,
      maxObservedLongTaskMs: result.maxObservedLongTaskMs,
      system: result.system,
      measurements: result.measurements,
    })),
    caveat: 'Each run uses a fresh VS Code profile and the same 100 KiB fixture. DOM mutation and compositor timestamps are rendering evidence, not physical-display confirmation.',
  }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
