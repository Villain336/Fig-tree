/**
 * The UI anchor registry: every interactive control (toolbar buttons, panel
 * fields, menu items, canvas handles) registers a stable id and a way to
 * find its bounding rectangle on screen. Sprout, the AI teammate (module
 * 11), points at controls through these ids; tests use them to check that
 * no control is missing.
 *
 * Ids are dot-separated paths such as `toolbar.tool.rectangle`,
 * `design.position.x` or `canvas.handle.resize.se`. Rects are in client
 * (viewport) CSS pixels.
 */

export interface AnchorRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type AnchorKind = "button" | "field" | "menu-item" | "tab" | "toggle" | "list-item" | "handle" | "canvas" | "panel" | "slider";

export interface AnchorInfo {
  readonly id: string;
  readonly kind: AnchorKind;
  /** What the control does, in a few words (for agents and accessibility checks). */
  readonly label: string;
}

interface Entry extends AnchorInfo {
  readonly rect: () => AnchorRect | null;
  readonly token: number;
}

const ID = /^[a-z][a-zA-Z0-9-]*(\.[a-zA-Z0-9_-]+)*$/;

export class AnchorRegistry {
  private readonly entries = new Map<string, Entry>();
  private next = 1;
  private readonly listeners = new Set<() => void>();
  /** Ids registered twice while another registration was live (a bug in the UI). */
  readonly duplicates = new Set<string>();

  /**
   * Registers a control. Returns a function that unregisters it. A second
   * live registration of the same id is recorded in {@link duplicates} and
   * replaces the first.
   */
  register(id: string, kind: AnchorKind, label: string, rect: () => AnchorRect | null): () => void {
    if (!ID.test(id)) throw new Error(`invalid anchor id "${id}"`);
    if (this.entries.has(id)) this.duplicates.add(id);
    const token = this.next++;
    this.entries.set(id, { id, kind, label, rect, token });
    this.emit();
    return () => {
      if (this.entries.get(id)?.token === token) {
        this.entries.delete(id);
        this.emit();
      }
    };
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** The control's current rectangle, or null when it is not on screen. */
  rect(id: string): AnchorRect | null {
    const e = this.entries.get(id);
    if (!e) return null;
    const r = e.rect();
    return r && r.width >= 0 && r.height >= 0 ? r : null;
  }

  info(id: string): AnchorInfo | undefined {
    const e = this.entries.get(id);
    return e ? { id: e.id, kind: e.kind, label: e.label } : undefined;
  }

  /** Every registered anchor, optionally filtered by id prefix. */
  list(prefix = ""): AnchorInfo[] {
    const out: AnchorInfo[] = [];
    for (const e of this.entries.values()) if (e.id.startsWith(prefix)) out.push({ id: e.id, kind: e.kind, label: e.label });
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
