export const PROGRESS_EDIT_INTERVAL_MS = 2_000;

export function progressEditDelayMs(
  lastEditAt: number,
  intervalMs = PROGRESS_EDIT_INTERVAL_MS,
  now = Date.now(),
): number {
  if (lastEditAt <= 0) return 0;
  return Math.max(0, intervalMs - (now - lastEditAt));
}

/**
 * Coalesces streaming events into serialized Discord message edits.
 * Prevents Discord 429 rate limits by enforcing a minimum interval between edits.
 */
export class ProgressEditGate {
  private dirty = false;
  private scheduled = false;
  private editing = false;
  private lastEditAt = 0;
  private readonly intervalMs: number;

  constructor(intervalMs = PROGRESS_EDIT_INTERVAL_MS) {
    this.intervalMs = intervalMs;
  }

  markDirty(): void {
    this.dirty = true;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  releaseSchedule(): void {
    this.scheduled = false;
  }

  scheduleDelay(now = Date.now()): number | null {
    if (!this.dirty || this.scheduled || this.editing) return null;
    this.scheduled = true;
    return progressEditDelayMs(this.lastEditAt, this.intervalMs, now);
  }

  beginEdit(): boolean {
    if (!this.scheduled || this.editing || !this.dirty) return false;
    this.scheduled = false;
    this.editing = true;
    this.dirty = false;
    return true;
  }

  finishEdit(now = Date.now(), committed = true, retry = !committed): void {
    this.editing = false;
    if (committed || retry) this.lastEditAt = now;
    if (retry) this.dirty = true;
  }

  recordEdit(now = Date.now()): void {
    this.lastEditAt = now;
  }
}
