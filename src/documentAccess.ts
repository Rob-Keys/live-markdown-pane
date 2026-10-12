import * as vscode from 'vscode';
import { stat } from 'node:fs/promises';

export async function isDocumentReadonly(uri: vscode.Uri): Promise<boolean> {
  if (uri.scheme === 'untitled') return false;
  if (await vscode.workspace.fs.isWritableFileSystem(uri.scheme) === false) return true;
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (((stat.permissions ?? 0) & vscode.FilePermission.Readonly) !== 0) return true;
  } catch {
    if (uri.scheme !== 'file') return false;
  }
  if (uri.scheme === 'file') {
    try { return ((await stat(uri.fsPath)).mode & 0o222) === 0; }
    catch { return false; }
  }
  return false;
}
