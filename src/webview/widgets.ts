import { WidgetType } from '@codemirror/view';

export class TaskCheckbox extends WidgetType {
  constructor(readonly from: number, readonly to: number, readonly checked: boolean, readonly description: string, readonly isEditable: boolean, private readonly dispatch: (from: number, to: number, value: string) => void, private readonly enterSource: (position: number) => void) { super(); }
  eq(other: TaskCheckbox): boolean { return other.from === this.from && other.to === this.to && other.checked === this.checked && other.description === this.description && other.isEditable === this.isEditable; }
  toDOM(): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.className = 'lm-task-widget';
    wrapper.dataset.lmPosition = String(this.from);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.checked;
    input.disabled = !this.isEditable;
    const state = this.checked ? 'Completed' : 'Incomplete';
    input.setAttribute('aria-label', this.description ? `${state} task: ${this.description}` : `${state} task`);
    input.addEventListener('change', () => this.dispatch(this.from, this.to, input.checked ? '[x]' : '[ ]'));
    input.addEventListener('keydown', event => {
      if (event.key === 'Tab') { event.preventDefault(); this.enterSource(event.shiftKey ? this.from : this.to); }
    });
    wrapper.append(input);
    return wrapper;
  }
  ignoreEvent(event: Event): boolean { return event.target instanceof HTMLInputElement; }
}

export class ListMarker extends WidgetType {
  constructor(readonly value: string) { super(); }
  eq(other: ListMarker): boolean { return other.value === this.value; }
  toDOM(): HTMLElement {
    const marker = document.createElement('span');
    marker.className = 'lm-list-marker';
    marker.textContent = this.value;
    marker.setAttribute('aria-label', /^\d/.test(this.value) ? `List item ${this.value}` : 'List item');
    return marker;
  }
}

export class TextWidget extends WidgetType {
  constructor(readonly value: string) { super(); }
  eq(other: TextWidget): boolean { return other.value === this.value; }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'lm-entity';
    span.textContent = this.value;
    return span;
  }
  ignoreEvent(): boolean { return false; }
}

export type TableTextRun = { text: string; marks: Array<'strong' | 'emphasis' | 'code' | 'strike' | 'link'>; linkTarget?: string };
export type TableAlignment = 'left' | 'center' | 'right' | undefined;
export type TableLinkKeyboardIntent = 'edit' | 'follow' | undefined;

export function tableLinkKeyboardIntent(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey'>): TableLinkKeyboardIntent {
  if (event.key !== 'Enter' && event.key !== 'F2') return undefined;
  return event.key === 'Enter' && (event.ctrlKey || event.metaKey) ? 'follow' : 'edit';
}

export class TableWidget extends WidgetType {
  constructor(readonly from: number, readonly to: number, readonly rows: TableTextRun[][][], readonly starts: number[], readonly alignments: TableAlignment[], private readonly enter: (position: number) => void, private readonly followLink: (target: string) => void = () => {}) { super(); }
  eq(other: TableWidget): boolean { return other.from === this.from && other.to === this.to && JSON.stringify(other.rows) === JSON.stringify(this.rows) && JSON.stringify(other.starts) === JSON.stringify(this.starts) && JSON.stringify(other.alignments) === JSON.stringify(this.alignments); }
  toDOM(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'lm-table-widget';
    wrapper.dataset.lmPosition = String(this.from);
    wrapper.setAttribute('role', 'group');
    wrapper.setAttribute('aria-label', 'Rendered Markdown table. Press Enter on a cell to edit its source row.');
    const table = document.createElement('table');
    this.rows.forEach((row, rowIndex) => {
      const tr = document.createElement('tr');
      row.forEach((cell, columnIndex) => {
        const cellElement = document.createElement(rowIndex === 0 ? 'th' : 'td');
        if (rowIndex === 0) cellElement.setAttribute('scope', 'col');
        const alignment = this.alignments[columnIndex];
        if (alignment) cellElement.style.textAlign = alignment;
        for (const run of cell) {
          let content: Node = document.createTextNode(run.text);
          for (const mark of run.marks) {
            const isLink = mark === 'link' && !!run.linkTarget;
            const tag = mark === 'strong' ? 'strong' : mark === 'emphasis' ? 'em' : mark === 'code' ? 'code' : mark === 'strike' ? 'del' : isLink ? 'a' : 'span';
            const wrapper = document.createElement(tag);
            if (mark === 'link') wrapper.className = 'lm-link';
            if (mark === 'code') wrapper.className = 'lm-inline-code';
            if (isLink) {
              wrapper.setAttribute('href', '#');
              wrapper.setAttribute('aria-label', `${run.text} (${run.linkTarget})`);
              wrapper.addEventListener('click', event => {
                const mouseEvent = event as MouseEvent;
                event.preventDefault();
                event.stopPropagation();
                if ((mouseEvent.ctrlKey || mouseEvent.metaKey) && run.linkTarget) this.followLink(run.linkTarget);
                else this.enter(this.starts[rowIndex] ?? this.from);
              });
              wrapper.addEventListener('keydown', event => {
                const keyboardEvent = event as KeyboardEvent;
                const intent = tableLinkKeyboardIntent(keyboardEvent);
                if (!intent) return;
                event.preventDefault();
                event.stopPropagation();
                if (intent === 'follow' && run.linkTarget) {
                  this.followLink(run.linkTarget);
                } else {
                  this.enter(this.starts[rowIndex] ?? this.from);
                }
              });
            }
            wrapper.append(content);
            content = wrapper;
          }
          cellElement.append(content);
        }
        cellElement.tabIndex = 0;
        cellElement.addEventListener('click', () => this.enter(this.starts[rowIndex] ?? this.from));
        cellElement.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); this.enter(this.starts[rowIndex] ?? this.from); }
          if (event.key === 'Escape') { event.preventDefault(); this.enter(this.to); }
          if (event.key === 'Tab') {
            event.preventDefault();
            const stops = Array.from(wrapper.querySelectorAll<HTMLElement>('th, td, a.lm-link[href]'));
            const next = stops.indexOf(event.target as HTMLElement) + (event.shiftKey ? -1 : 1);
            if (next >= 0 && next < stops.length) stops[next].focus();
            else this.enter(event.shiftKey ? this.from : this.to);
          }
        });
        tr.append(cellElement);
      });
      table.append(tr);
    });
    wrapper.append(table);
    return wrapper;
  }
  ignoreEvent(): boolean { return false; }
}

export class ImageWidget extends WidgetType {
  private requests = new WeakMap<HTMLElement, AbortController>();
  constructor(readonly from: number, readonly to: number, readonly alt: string, readonly src: string, readonly canLoad: boolean, private readonly request: (src: string, signal?: AbortSignal) => Promise<string | undefined>, private readonly enter: (position: number) => void, private readonly preserveViewport: (update: () => void) => void) { super(); }
  eq(other: ImageWidget): boolean { return other.from === this.from && other.to === this.to && other.alt === this.alt && other.src === this.src && other.canLoad === this.canLoad; }
  toDOM(): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.className = 'lm-image-widget';
    wrapper.dataset.lmPosition = String(this.from);
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'button');
    wrapper.setAttribute('aria-label', `Edit Markdown image source: ${this.alt || this.src || 'unavailable image'}`);
    const fallback = document.createElement('span');
    fallback.textContent = this.alt || (this.src ? `Image: ${this.src}` : 'Unavailable image');
    wrapper.append(fallback);
    wrapper.addEventListener('click', () => this.enter(this.from));
    wrapper.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); this.enter(this.from); }
      if (event.key === 'Tab') { event.preventDefault(); this.enter(event.shiftKey ? this.from : this.to); }
    });
    if (!this.canLoad || !this.src) return wrapper;
    const controller = new AbortController();
    this.requests.set(wrapper, controller);
    void this.request(this.src, controller.signal).then(uri => {
      // A request that began while visible may resolve after the tab is hidden.
      // Keep its result on the retained widget so it is ready when shown again.
      if (!uri || !wrapper.isConnected) return;
      const image = document.createElement('img');
      image.alt = this.alt;
      image.addEventListener('error', () => image.replaceWith(fallback));
      let shown = false;
      const showImage = () => {
        if (shown || !wrapper.isConnected) return;
        shown = true;
        this.preserveViewport(() => wrapper.replaceChildren(image));
      };
      image.addEventListener('load', showImage, { once: true });
      image.src = uri;
      if (image.complete && image.naturalWidth > 0) showImage();
    });
    return wrapper;
  }
  destroy(dom: HTMLElement): void {
    this.requests.get(dom)?.abort();
    this.requests.delete(dom);
  }
  ignoreEvent(): boolean { return false; }
}
