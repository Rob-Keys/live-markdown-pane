import * as vscode from 'vscode';
import { realpath } from 'node:fs/promises';
import { relative, sep } from 'node:path';

/** Checks both URI containment and, for local files, symlink-resolved containment. */
export async function isUriWithin(root: vscode.Uri, candidate: vscode.Uri): Promise<boolean> {
  if (candidate.scheme !== root.scheme || candidate.authority !== root.authority) return false;
  const rootPath = root.path.endsWith('/') ? root.path : `${root.path}/`;
  if (root.scheme !== 'file') return candidate.path === root.path || candidate.path.startsWith(rootPath);
  try {
    const [realRoot, realCandidate] = await Promise.all([realpath(root.fsPath), realpath(candidate.fsPath)]);
    const path = relative(realRoot, realCandidate);
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !relative(realRoot, realCandidate).startsWith(sep));
  } catch {
    return false;
  }
}

export function documentDirectory(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(uri, '..');
}
