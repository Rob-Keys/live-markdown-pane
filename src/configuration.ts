import * as vscode from 'vscode';
import { EditorSettings } from './protocol';
import { documentDirectory, isUriWithin } from './resources';

export type SettingsScopeChoice = vscode.QuickPickItem & { target: vscode.ConfigurationTarget; scopeUri?: vscode.Uri };

export function settingsScopeChoices(
  hasWorkspaceFile: boolean,
  workspaceFolders: readonly Pick<vscode.WorkspaceFolder, 'name' | 'uri'>[],
  selectedFolderUri?: vscode.Uri,
): SettingsScopeChoice[] {
  const choices: SettingsScopeChoice[] = [];
  const singleFolderWorkspace = !hasWorkspaceFile && workspaceFolders.length === 1;
  if (hasWorkspaceFile || singleFolderWorkspace) {
    choices.push({
      label: 'Workspace',
      description: singleFolderWorkspace ? `Applies to ${workspaceFolders[0].name}` : 'Applies to this multi-root or saved workspace',
      target: vscode.ConfigurationTarget.Workspace,
    });
  }
  const folderChoices = hasWorkspaceFile || workspaceFolders.length > 1
    ? selectedFolderUri
      ? workspaceFolders.filter(folder => folder.uri.toString() === selectedFolderUri.toString())
      : workspaceFolders
    : [];
  for (const folder of folderChoices) {
    choices.push({
      label: `Workspace Folder: ${folder.name}`,
      description: 'Applies to this folder',
      target: vscode.ConfigurationTarget.WorkspaceFolder,
      scopeUri: folder.uri,
    });
  }
  choices.push({ label: 'User', description: 'Applies across VS Code workspaces', target: vscode.ConfigurationTarget.Global });
  return choices;
}

export function readSettings(uri: vscode.Uri): EditorSettings {
  const config = vscode.workspace.getConfiguration('liveMarkdown', uri);
  const screenReaderMode = screenReaderModeEnabled(vscode.workspace.getConfiguration('editor').get<unknown>('accessibilitySupport'));
  const configuredWidth = config.get<unknown>('contentWidth', null);
  const contentWidth = configuredWidth === 'full'
    ? 'full'
    : typeof configuredWidth === 'number' && Number.isFinite(configuredWidth) && configuredWidth >= 40 && configuredWidth <= 120
      ? configuredWidth
      : null;
  const fontFamily = config.get<unknown>('fontFamily', 'inherit');
  const lineNumberStart = config.get<unknown>('lineNumberStart', 1);
  return {
    syntaxVisibility: enumSetting(config.get<unknown>('syntaxVisibility', 'activeLine'), ['activeLine', 'activeBlock', 'always'], 'activeLine'),
    readingPreset: enumSetting(config.get<unknown>('readingPreset', 'default'), ['default', 'compact', 'comfortable'], 'default'),
    fontFamily: typeof fontFamily === 'string' && fontFamily.trim() && fontFamily.length <= 4096 ? fontFamily : 'inherit',
    fontSize: boundedNumber(config.get<unknown>('fontSize', null), 10, 32),
    lineHeight: boundedNumber(config.get<unknown>('lineHeight', null), 1.2, 2.2),
    contentWidth,
    showLineNumbers: booleanSetting(config.get<unknown>('showLineNumbers', false), false),
    renderImages: booleanSetting(config.get<unknown>('renderImages', true), true),
    renderTables: booleanSetting(config.get<unknown>('renderTables', true), true),
    allowRemoteImages: booleanSetting(config.get<unknown>('allowRemoteImages', false), false),
    isTrusted: vscode.workspace.isTrusted,
    screenReaderMode,
    lineNumberStart: Number.isSafeInteger(lineNumberStart) && (lineNumberStart as number) >= 1 ? lineNumberStart as number : 1,
  };
}

/** VS Code exposes explicit screen-reader mode through editor.accessibilitySupport. */
export function screenReaderModeEnabled(value: unknown): boolean {
  return value === 'on';
}

export function restrictedWorkspaceCssPath(userValue: unknown): string {
  if (typeof userValue !== 'string') return '';
  const path = userValue.trim();
  return isAbsoluteLocalPath(path) ? path : '';
}

export function isAbsoluteLocalPath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path);
}

export function readCustomCssPath(
  uri: vscode.Uri,
  workspace: vscode.WorkspaceFolder | undefined = vscode.workspace.getWorkspaceFolder(uri),
  trusted = vscode.workspace.isTrusted,
): string {
  const config = vscode.workspace.getConfiguration('liveMarkdown', uri);
  if (!trusted && workspace) return restrictedWorkspaceCssPath(config.inspect<unknown>('customCss')?.globalValue);
  const value = config.get<unknown>('customCss', '');
  return typeof value === 'string' ? value.trim() : '';
}

function enumSetting<T extends string>(value: unknown, valid: readonly T[], fallback: T): T {
  return typeof value === 'string' && valid.includes(value as T) ? value as T : fallback;
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum ? value : null;
}

function booleanSetting(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export async function readCustomCss(uri: vscode.Uri, workspace: vscode.WorkspaceFolder | undefined): Promise<string | undefined> {
  const configured = readCustomCssPath(uri, workspace);
  if (!configured) return undefined;
  try {
    let cssUri: vscode.Uri;
    if (isAbsoluteLocalPath(configured)) {
      cssUri = vscode.Uri.file(configured);
    } else {
      const root = workspace?.uri ?? documentDirectory(uri);
      cssUri = vscode.Uri.joinPath(root, configured);
      if (!await isUriWithin(root, cssUri)) return undefined;
    }
    const bytes = await vscode.workspace.fs.readFile(cssUri);
    if (bytes.byteLength > 256 * 1024) return undefined;
    const css = new TextDecoder().decode(bytes);
    // Prevent a local stylesheet from escaping its presentation-only role.
    return stripCssImports(css);
  } catch {
    return undefined;
  }
}

export function stripCssImports(css: string): string {
  let output = '';
  let position = 0;
  while (position < css.length) {
    if (css.startsWith('/*', position)) {
      const end = css.indexOf('*/', position + 2);
      const next = end < 0 ? css.length : end + 2;
      output += css.slice(position, next);
      position = next;
      continue;
    }
    const quote = css[position];
    if (quote === '"' || quote === "'") {
      const next = skipCssString(css, position);
      output += css.slice(position, next);
      position = next;
      continue;
    }
    if (css[position] === '@') {
      const identifier = readCssIdentifier(css, position + 1);
      if (identifier?.value.toLowerCase() === 'import') {
        position = skipCssImport(css, identifier.end);
        continue;
      }
    }
    output += css[position++];
  }
  return output;
}

function readCssIdentifier(css: string, start: number): { value: string; end: number } | undefined {
  let value = '';
  let position = start;
  while (position < css.length) {
    const character = css[position];
    if (character === '\\') {
      const escape = readCssEscape(css, position);
      if (!escape) break;
      value += escape.value;
      position = escape.end;
    } else if (/[-_a-z\d]/i.test(character) || character.charCodeAt(0) >= 0x80) {
      value += character;
      position++;
    } else {
      break;
    }
  }
  return value ? { value, end: position } : undefined;
}

function readCssEscape(css: string, start: number): { value: string; end: number } | undefined {
  let position = start + 1;
  if (position >= css.length || css[position] === '\n' || css[position] === '\r' || css[position] === '\f') return undefined;
  if (/[\da-f]/i.test(css[position])) {
    const digitsStart = position;
    while (position < css.length && position - digitsStart < 6 && /[\da-f]/i.test(css[position])) position++;
    const codePoint = Number.parseInt(css.slice(digitsStart, position), 16);
    if (css[position] === '\r' && css[position + 1] === '\n') position += 2;
    else if (/[\t\n\r\f ]/.test(css[position] ?? '')) position++;
    return { value: codePoint === 0 || codePoint > 0x10ffff ? '\uFFFD' : String.fromCodePoint(codePoint), end: position };
  }
  return { value: css[position], end: position + 1 };
}

function skipCssString(css: string, start: number): number {
  const quote = css[start];
  let position = start + 1;
  while (position < css.length) {
    if (css[position] === '\\') {
      position += Math.min(2, css.length - position);
    } else if (css[position++] === quote) {
      break;
    }
  }
  return position;
}

function skipCssImport(css: string, start: number): number {
  let position = start;
  let parentheses = 0;
  while (position < css.length) {
    if (css.startsWith('/*', position)) {
      const end = css.indexOf('*/', position + 2);
      position = end < 0 ? css.length : end + 2;
    } else if (css[position] === '"' || css[position] === "'") {
      position = skipCssString(css, position);
    } else if (css[position] === '\\') {
      position += Math.min(2, css.length - position);
    } else if (css[position] === '(') {
      parentheses++;
      position++;
    } else if (css[position] === ')') {
      parentheses = Math.max(0, parentheses - 1);
      position++;
    } else if (css[position] === ';' && parentheses === 0) {
      return position + 1;
    } else if (css[position] === '{' && parentheses === 0) {
      return position;
    } else {
      position++;
    }
  }
  return position;
}
