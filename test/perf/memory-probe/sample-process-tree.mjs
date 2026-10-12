import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function readProcessTreeSnapshot(userDataDir, collectFootprint = false) {
  if (!userDataDir) throw new Error('Pass the VS Code user-data directory.');
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { maxBuffer: 16 * 1024 * 1024 });
  const processes = stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]), command: match[4] }] : [];
  });
  const root = processes.find(item => item.command.includes(`--user-data-dir=${userDataDir}`)
    && /(?:^|\/)(?:Code|code)(?:\s|$)/.test(item.command));
  if (!root) throw new Error(`No VS Code process uses profile ${userDataDir}.`);

  const descendants = new Map();
  for (const item of processes) {
    const children = descendants.get(item.ppid) ?? [];
    children.push(item);
    descendants.set(item.ppid, children);
  }
  const tree = [];
  const visit = item => {
    tree.push(item);
    for (const child of descendants.get(item.pid) ?? []) visit(child);
  };
  visit(root);
  const rssKiB = tree.reduce((total, item) => total + item.rssKiB, 0);
  const processType = command => /Code Helper \(Plugin\)(?:\s|$)|(?:^|\s)--extensionHost(?:\s|$)/.test(command)
    ? 'extension-host'
    : /(?:^|\s)--type=([^\s]+)/.exec(command)?.[1] ?? 'main-or-other';
  const processTypes = {};
  for (const item of tree) {
    const type = processType(item.command);
    const group = processTypes[type] ?? { processCount: 0, rssMiB: 0 };
    group.processCount++;
    group.rssMiB += item.rssKiB / 1024;
    processTypes[type] = group;
  }
  for (const group of Object.values(processTypes)) group.rssMiB = Math.round(group.rssMiB * 10) / 10;
  const snapshot = {
    sampledAt: new Date().toISOString(),
    processCount: tree.length,
    aggregateRssMiB: Math.round((rssKiB / 1024) * 10) / 10,
    processTypes,
  };
  if (process.platform === 'darwin' && collectFootprint) snapshot.footprint = await readProcessFootprint(tree, processType);
  return snapshot;
}

async function readProcessFootprint(tree, processType) {
  const outputPath = path.join(os.tmpdir(), `live-markdown-footprint-${process.pid}-${Date.now()}.json`);
  try {
    const args = ['--json', outputPath];
    for (const item of tree) args.push('--pid', String(item.pid));
    await execFileAsync('footprint', args, { maxBuffer: 16 * 1024 * 1024 });
    const report = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    const processes = Array.isArray(report.processes) ? report.processes.flatMap(item => {
      const physicalBytes = item.auxiliary?.phys_footprint ?? item.footprint;
      const source = tree.find(processInfo => processInfo.pid === item.pid);
      return Number.isFinite(physicalBytes) && source
        ? [{ pid: item.pid, type: processType(source.command), physicalFootprintMiB: Math.round((physicalBytes / (1024 * 1024)) * 10) / 10 }]
        : [];
    }) : [];
    const processTypes = {};
    for (const item of processes) {
      const group = processTypes[item.type] ?? { processCount: 0, physicalFootprintMiB: 0 };
      group.processCount++;
      group.physicalFootprintMiB += item.physicalFootprintMiB;
      processTypes[item.type] = group;
    }
    for (const group of Object.values(processTypes)) group.physicalFootprintMiB = Math.round(group.physicalFootprintMiB * 10) / 10;
    return {
      sampledProcessCount: processes.length,
      aggregatePhysicalFootprintMiB: Math.round(processes.reduce((total, item) => total + item.physicalFootprintMiB, 0) * 10) / 10,
      processTypes,
      processes,
    };
  } catch {
    return { sampledProcessCount: 0, error: true };
  } finally {
    await fs.rm(outputPath, { force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const userDataDir = process.argv[2];
  if (!userDataDir) throw new Error('Pass the user-data directory printed by memory-probe/run.js.');
  console.log(JSON.stringify({ profile: userDataDir, ...(await readProcessTreeSnapshot(userDataDir)) }, null, 2));
}
