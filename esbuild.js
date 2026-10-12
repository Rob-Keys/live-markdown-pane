const esbuild = require('esbuild');
const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
};

async function build() {
  const host = {
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  };
  const webview = {
    ...shared,
    entryPoints: ['src/webview/editor.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
  };
  if (watch) {
    const contexts = await Promise.all([esbuild.context(host), esbuild.context(webview)]);
    await Promise.all(contexts.map(context => context.watch()));
    console.log('Watching host and webview bundles…');
  } else {
    await Promise.all([esbuild.build(host), esbuild.build(webview)]);
  }
}

build().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
