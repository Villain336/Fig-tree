/**
 * What this user is looking at and pointing at: the page, the selection,
 * the hovered node, and the text being edited. It is local state, never
 * stored in the document, and shaped as a plain JSON object so module 8 can
 * publish it unchanged as the user's Yjs awareness state (other people's
 * selections then render from the same structure).
 */
export interface PresenceState {
  readonly page: string;
  /** Selected node ids, in selection order. */
  readonly selection: readonly string[];
  readonly hover: string | null;
  /** The text node being edited and its caret/selection (UTF-16 indices), if any. */
  readonly text: { readonly id: string; readonly anchor: number; readonly focus: number } | null;
  /** Cursor in world coordinates, or null when the pointer is off the canvas. */
  readonly cursor: { readonly x: number; readonly y: number } | null;
}

export type PresenceKey = keyof PresenceState;

/** A small observable store for {@link PresenceState}. */
export class LocalPresence {
  private _state: PresenceState;
  private readonly listeners = new Set<(state: PresenceState, changed: ReadonlySet<PresenceKey>) => void>();

  constructor(page: string) {
    this._state = { page, selection: [], hover: null, text: null, cursor: null };
  }

  get state(): PresenceState {
    return this._state;
  }

  get selection(): readonly string[] {
    return this._state.selection;
  }

  get hover(): string | null {
    return this._state.hover;
  }

  /** Merges a partial update; listeners hear about keys whose value changed. */
  update(patch: Partial<PresenceState>): void {
    const changed = new Set<PresenceKey>();
    const next = { ...this._state } as { -readonly [K in PresenceKey]: PresenceState[K] };
    for (const key of Object.keys(patch) as PresenceKey[]) {
      const value = patch[key];
      if (value === undefined) continue;
      if (sameValue(this._state[key], value)) continue;
      (next as Record<string, unknown>)[key] = value;
      changed.add(key);
    }
    if (changed.size === 0) return;
    this._state = Object.freeze(next);
    for (const l of this.listeners) l(this._state, changed);
  }

  setSelection(ids: readonly string[]): void {
    this.update({ selection: dedupe(ids) });
  }

  setHover(id: string | null): void {
    this.update({ hover: id });
  }

  subscribe(listener: (state: PresenceState, changed: ReadonlySet<PresenceKey>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The state as JSON for an awareness protocol. */
  toJSON(): PresenceState {
    return this._state;
  }
}

function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  if (a && b && typeof a === "object" && typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return false;
}
