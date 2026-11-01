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
    const userDataPath = path.join(profile, 'user');
    await fs.mkdir(path.join(userDataPath, 'User'), { recursive: true });
    // These integration tests exercise local editor behavior, not extension proxy routing.
    await fs.writeFile(path.join(userDataPath, 'User', 'settings.json'), JSON.stringify({ 'http.proxySupport': 'off' }, null, 2));
    await runTests({
      ...(version ? { version } : { vscodeExecutablePath: code }),
      extensionDevelopmentPath: codePath,
      extensionTestsPath: testPath,
      launchArgs: [
        fixturePath,
        '--disable-workspace-trust',
        `--user-data-dir=${userDataPath}`,
        `--extensions-dir=${path.join(profile, 'extensions')}`,
      ],
    });
  } finally {
    await fs.rm(profile, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
