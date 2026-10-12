const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const version = process.env.VSCODE_VERSION || process.argv.find(arg => arg.startsWith('--version='))?.slice('--version='.length);
  const code = process.env.VSCODE_EXECUTABLE || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  const codePath = path.resolve(__dirname, '..');
  const testPath = path.resolve(__dirname, '..', '.test-dist', 'test', 'suite', 'index.js');
  const fixturePath = path.resolve(__dirname, 'fixtures');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'live-markdown-test-'));
  try {
    await runTests({
      ...(version ? { version } : { vscodeExecutablePath: code }),
      extensionDevelopmentPath: codePath,
      extensionTestsPath: testPath,
      launchArgs: [
        fixturePath,
        '--disable-workspace-trust',
        `--user-data-dir=${path.join(profile, 'user')}`,
        `--extensions-dir=${path.join(profile, 'extensions')}`,
      ],
    });
  } finally {
    await fs.rm(profile, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
