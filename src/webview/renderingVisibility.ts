/** Build rendering extensions only when the host panel and webview are visible. */
export function renderingWhenVisible<T>(visible: boolean, build: () => T[]): T[] {
  return visible ? build() : [];
}

export function effectiveSyntaxVisibility(
  sourceMode: boolean,
  screenReaderMode: boolean,
  configured: 'activeLine' | 'activeBlock' | 'always',
): 'activeLine' | 'activeBlock' | 'always' {
  return sourceMode || screenReaderMode ? 'always' : configured;
}

/** Table widgets must yield to source editing when syntax is always visible, including screen-reader mode. */
export function shouldRenderTableWidget(
  sourceMode: boolean,
  screenReaderMode: boolean,
  configured: 'activeLine' | 'activeBlock' | 'always',
  inActiveRange: boolean,
  selected: boolean,
): boolean {
  return effectiveSyntaxVisibility(sourceMode, screenReaderMode, configured) !== 'always' && !inActiveRange && !selected;
}
