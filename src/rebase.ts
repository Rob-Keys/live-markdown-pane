import { ChangeSet } from '@codemirror/state';
import { SourceChange } from './protocol';

/** Build a CodeMirror change set from source ranges based on the same document. */
export function sourceChangesToSet(changes: SourceChange[], length: number): ChangeSet {
  return ChangeSet.of(changes.map(change => ({ from: change.from, to: change.to, insert: change.insert })), length);
}

/** Convert a change set into the host protocol's JSON-safe source ranges. */
export function changeSetToSourceChanges(changeSet: ChangeSet): SourceChange[] {
  const changes: SourceChange[] = [];
  changeSet.iterChanges((from, to, _newFrom, _newTo, inserted) => {
    changes.push({ from, to, insert: inserted.toString() });
  });
  return changes;
}

/** Compose transactions queued against successive document states into one host edit. */
export function composeChangeSets(baseLength: number, changes: readonly ChangeSet[]): ChangeSet {
  let composed = ChangeSet.empty(baseLength);
  for (const change of changes) composed = composed.compose(change);
  return composed;
}

/** Describe a whole-text host update as one minimal range. */
export function diffChangeSet(before: string, after: string): ChangeSet {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  return ChangeSet.of([{ from: start, to: oldEnd, insert: after.slice(start, newEnd) }], before.length);
}

/** Only rebase edits whose replaced source ranges do not overlap. */
export function changesOverlap(first: ChangeSet, second: ChangeSet): boolean {
  const left: Array<[number, number]> = [];
  const right: Array<[number, number]> = [];
  first.iterChangedRanges((from, to) => left.push([from, to]), true);
  second.iterChangedRanges((from, to) => right.push([from, to]), true);
  for (const [leftFrom, leftTo] of left) {
    for (const [rightFrom, rightTo] of right) {
      if (leftFrom === leftTo && rightFrom === rightTo) continue;
      if (leftFrom === leftTo) {
        if (leftFrom > rightFrom && leftFrom < rightTo) return true;
      } else if (rightFrom === rightTo) {
        if (rightFrom > leftFrom && rightFrom < leftTo) return true;
      } else if (leftFrom < rightTo && rightFrom < leftTo) {
        return true;
      }
    }
  }
  return false;
}
