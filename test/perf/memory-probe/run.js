const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { runTests } = require('@vscode/test-electron');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(q * sorted.length) - 1] : null;
}

function summarize(samples, missedSnapshots) {
  return Object.fromEntries(['blank', 'open', 'closed'].map(phase => {
    const phaseSamples = samples.filter(sample => sample.phase === phase);
    const rss = phaseSamples.map(sample => sample.aggregateRssMiB);
    const processCounts = [...new Set(phaseSamples.map(sample => sample.processCount))].sort((a, b) => a - b);
    const footprintSamples = phaseSamples.filter(sample => Number.isFinite(sample.footprint?.aggregatePhysicalFootprintMiB));
    const footprint = footprintSamples.map(sample => sample.footprint.aggregatePhysicalFootprintMiB);
    const footprintTypes = [...new Set(footprintSamples.flatMap(sample => Object.keys(sample.footprint.processTypes ?? {})))];
    return [phase, {
      sampleCount: phaseSamples.length,
      missedSnapshots: missedSnapshots[phase],
      rssMiB: { min: rss.length ? Math.min(...rss) : null, p50: quantile(rss, 0.5), p95: quantile(rss, 0.95), max: rss.length ? Math.max(...rss) : null },
      processCounts,
      footprintSampleCount: footprintSamples.length,
      missedFootprintSamples: phaseSamples.filter(sample => sample.footprintSampled && sample.footprint?.error).length,
      physicalFootprintMiB: { min: footprint.length ? Math.min(...footprint) : null, p50: quantile(footprint, 0.5), p95: quantile(footprint, 0.95), max: footprint.length ? Math.max(...footprint) : null },
      processTypePhysicalFootprintMiB: Object.fromEntries(footprintTypes.map(type => {
        const values = footprintSamples.map(sample => sample.footprint.processTypes[type]?.physicalFootprintMiB).filter(Number.isFinite);
        return [type, { sampleCount: values.length, p50: quantile(values, 0.5), p95: quantile(values, 0.95) }];
      })),
      samples: phaseSamples,
    }];
  }));
}

async function main() {
  const fixtureDirectory = process.argv[2];
  if (!fixtureDirectory) throw new Error('Pass the generated Markdown fixture directory.');
  const mode = process.env.LIVE_MARKDOWN_MEMORY_MODE ?? 'live';
  if (!['live', 'native'].includes(mode)) throw new Error('LIVE_MARKDOWN_MEMORY_MODE must be live or native.');
  const repository = path.resolve(__dirname, '../../..');
  const probe = __dirname;
  const executable = process.env.VSCODE_EXECUTABLE
    ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'live-markdown-memory-probe-'));
  const userDataDir = path.join(profile, 'user');
  const phaseFile = path.join(profile, 'sample-phase.json');
  const { readProcessTreeSnapshot } = await import('./sample-process-tree.mjs');
  const samples = [];
  const missedSnapshots = { blank: 0, open: 0, closed: 0 };
  let stopSampling = false;
  let samplingSequence = 0;
  const sampleLoop = (async () => {
    while (!stopSampling) {
      try {
        const state = JSON.parse(await fs.readFile(phaseFile, 'utf8'));
        if (Object.hasOwn(missedSnapshots, state.phase)) {
          try {
            const includeFootprint = process.platform === 'darwin' && samplingSequence++ % 5 === 0;
            samples.push({ phase: state.phase, count: state.count, ...(includeFootprint ? { footprintSampled: true } : {}), ...(await readProcessTreeSnapshot(userDataDir, includeFootprint)) });
          } catch {
            missedSnapshots[state.phase]++;
          }
        }
      } catch {
        // The Extension Host creates the phase marker after the profile starts.
      }
      await delay(1000);
    }
  })();
  console.log(`Memory probe profile: ${profile}`);
  try {
    const exitCode = await runTests({
      vscodeExecutablePath: executable,
      extensionDevelopmentPath: mode === 'live' ? [repository, probe] : [probe],
      extensionTestsPath: path.join(probe, 'suite.js'),
      extensionTestsEnv: {
        LIVE_MARKDOWN_MEMORY_MODE: mode,
        LIVE_MARKDOWN_MEMORY_PHASE_FILE: phaseFile,
        ...(process.env.LIVE_MARKDOWN_MEMORY_BLANK_HOLD_MS
          ? { LIVE_MARKDOWN_MEMORY_BLANK_HOLD_MS: process.env.LIVE_MARKDOWN_MEMORY_BLANK_HOLD_MS }
          : {}),
        ...(process.env.LIVE_MARKDOWN_MEMORY_HOLD_MS
          ? { LIVE_MARKDOWN_MEMORY_HOLD_MS: process.env.LIVE_MARKDOWN_MEMORY_HOLD_MS }
          : {}),
        ...(process.env.LIVE_MARKDOWN_MEMORY_CLOSED_HOLD_MS
          ? { LIVE_MARKDOWN_MEMORY_CLOSED_HOLD_MS: process.env.LIVE_MARKDOWN_MEMORY_CLOSED_HOLD_MS }
          : {}),
      },
      launchArgs: [
        path.resolve(fixtureDirectory),
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${path.join(profile, 'extensions')}`,
      ],
    });
    if (exitCode !== 0) process.exitCode = exitCode;
  } finally {
    stopSampling = true;
    await sampleLoop;
    const summary = { mode, ...summarize(samples, missedSnapshots) };
    if (process.env.LIVE_MARKDOWN_MEMORY_SUMMARY_FILE) {
      const summaryPath = path.resolve(process.env.LIVE_MARKDOWN_MEMORY_SUMMARY_FILE);
      await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
      console.log(`Memory probe summary saved: ${summaryPath}`);
    }
    const consoleSummary = process.env.LIVE_MARKDOWN_MEMORY_SUMMARY_FILE
      ? Object.fromEntries(Object.entries(summary).map(([phase, value]) => [phase,
        phase === 'mode' ? value : Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'samples')),
      ]))
      : summary;
    console.log(`LIVE_MARKDOWN_MEMORY_SUMMARY ${JSON.stringify(consoleSummary)}`);
    await fs.rm(profile, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
