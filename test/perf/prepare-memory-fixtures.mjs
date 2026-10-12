import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [directory, countValue, sizeValue] = process.argv.slice(2);
if (!directory || !countValue || !sizeValue) {
  throw new Error('Usage: node test/perf/prepare-memory-fixtures.mjs <directory> <count> <bytes-per-file>');
}

const count = Number(countValue);
const bytesPerFile = Number(sizeValue);
if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw new Error('Count must be an integer from 1 to 1000.');
if (!Number.isSafeInteger(bytesPerFile) || bytesPerFile < 256 || bytesPerFile > 5 * 1024 * 1024) throw new Error('Bytes per file must be from 256 bytes to 5 MiB.');

const root = path.resolve(directory);
await mkdir(root, { recursive: true });
const prefix = '# Memory sample\n\nParagraph with **bold**, `code`, and a [link](https://example.com).\n\n';
const line = 'Repeated source sentence with Unicode café 😀 for editor-state measurement.\n';
if (Buffer.byteLength(prefix) > bytesPerFile) throw new Error('Fixture size is too small for the Markdown header.');

let source = prefix;
while (Buffer.byteLength(source + line) <= bytesPerFile) source += line;
source += 'x'.repeat(bytesPerFile - Buffer.byteLength(source));
const content = Buffer.from(source, 'utf8');
if (content.byteLength !== bytesPerFile) throw new Error('Could not produce the requested byte size.');

await Promise.all(Array.from({ length: count }, (_, index) => {
  const name = `doc-${String(index).padStart(3, '0')}.md`;
  return writeFile(path.join(root, name), content);
}));
console.log(`Created ${count} Markdown fixtures (${bytesPerFile} bytes each) in ${root}`);
