/** Coalesces presentation changes until an active IME composition has finished. */
export class CompositionGate {
  private composing = false;
  private refreshPending = false;

  isActive(): boolean { return this.composing; }

  start(): void { this.composing = true; }

  requestRefresh(): boolean {
    if (this.composing) {
      this.refreshPending = true;
      return false;
    }
    return true;
  }

  finish(): boolean {
    this.composing = false;
    const refresh = this.refreshPending;
    this.refreshPending = false;
    return refresh;
  }
}
