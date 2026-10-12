import { EditorState, StateField } from '@codemirror/state';
import { SourceChange } from '../protocol';

export const REDUCED_RENDERING_BYTES = 1024 * 1024;
export const SOURCE_MODE_BYTES = 5 * 1024 * 1024;
const encoder = new TextEncoder();

export function utf8ByteLength(text: string): number { return encoder.encode(text).byteLength; }

export function sourceChangesByteSize(changes: readonly SourceChange[], readSource: (from: number, to: number) => string): number {
  return changes.reduce((size, change) => size + utf8ByteLength(change.insert) + utf8ByteLength(readSource(change.from, change.to)), 0);
}

export const documentByteSize = StateField.define<number>({
  create: state => utf8ByteLength(state.doc.toString()),
  update: (size, transaction) => {
    if (!transaction.docChanged) return size;
    let updatedSize = size;
    transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
      updatedSize += utf8ByteLength(inserted.toString()) - utf8ByteLength(transaction.startState.sliceDoc(from, to));
    });
    return updatedSize;
  },
});

export function documentBytes(state: EditorState): number {
  return state.field(documentByteSize, false) ?? utf8ByteLength(state.doc.toString());
}

export function shouldReduceRendering(state: EditorState): boolean {
  return documentBytes(state) > REDUCED_RENDERING_BYTES || state.doc.lines > 20000;
}

export function shouldOpenInSourceMode(text: string): boolean {
  return utf8ByteLength(text) > SOURCE_MODE_BYTES;
}

/** Large documents open as source to avoid parsing the whole buffer on every edit. */
export function shouldUseMarkdownLanguage(largeDocument: boolean, sourceMode: boolean): boolean {
  return !largeDocument || !sourceMode;
}
