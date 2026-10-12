import type { Actor, Command, FigDocument, TypedCommand } from "@fig-tree/document";
import { CommandError } from "@fig-tree/document";

/**
 * The user's edits: every change goes through `doc.apply` with the user's
 * actor, so undo and redo are per user. A gesture (a drag, a scrub) applies
 * many batches; {@link begin} and {@link end} merge them into one undo step
 * using the actor's undo manager capture window. A run of typing is a
 * "soft" group: it stays open until any other edit (or a caret move) closes it.
 */
export class History {
  private depth = 0;
  private soft: string | null = null;
  /** Undo stack length when the outermost group began (to tell whether the group recorded anything). */
  private stackAtBegin = 0;
  /** The last rejected batch's error (for diagnostics). */
  lastError: CommandError | null = null;

  constructor(
    readonly doc: FigDocument,
    readonly actor: Actor,
  ) {}

  private get um() {
    return this.doc.undoManager(this.actor);
  }

  /**
   * Applies a batch as the user. Returns null (and changes nothing) when the
   * batch is rejected. `group` names a soft group (a run of typing): batches
   * of the same soft group merge into one undo step until a batch from
   * anywhere else, or {@link closeSoftGroup}, ends it.
   */
  apply(commands: readonly (Command | TypedCommand)[], options: { group?: string } = {}): ReturnType<FigDocument["apply"]> | null {
    if (commands.length === 0) return null;
    if (this.soft !== null && options.group !== this.soft) this.closeSoftGroup();
    if (options.group !== undefined && this.soft === null && this.depth === 0) {
      this.begin();
      this.soft = options.group;
    }
    try {
      return this.doc.apply(commands, this.actor);
    } catch (e) {
      if (e instanceof CommandError) {
        this.lastError = e;
        return null;
      }
      throw e;
    }
  }

  /** Like {@link apply}, but throws the CommandError of a rejected batch. */
  applyOrThrow(commands: readonly (Command | TypedCommand)[]): ReturnType<FigDocument["apply"]> {
    if (this.soft !== null) this.closeSoftGroup();
    return this.doc.apply(commands, this.actor);
  }

  /** Ends the open soft group, if any (the next typing starts a new undo step). */
  closeSoftGroup(): void {
    if (this.soft === null) return;
    this.soft = null;
    this.end();
  }

  /** Starts merging the user's batches into one undo step (nestable). */
  begin(): void {
    // A gesture starting while a run of typing is open closes the typing step first.
    if (this.soft !== null) this.closeSoftGroup();
    if (this.depth++ === 0) {
      const um = this.um;
      um.stopCapturing();
      um.captureTimeout = Number.POSITIVE_INFINITY;
      this.stackAtBegin = um.undoStack.length;
    }
  }

  /** Ends a merge started with {@link begin}. */
  end(): void {
    if (this.depth === 0) return;
    if (--this.depth === 0) {
      const um = this.um;
      um.captureTimeout = 0;
      um.stopCapturing();
    }
  }

  /** Ends every open group and reverts what it applied (Escape during a drag), leaving nothing to redo. */
  abort(): void {
    const recorded = this.depth > 0 && this.um.undoStack.length > this.stackAtBegin;
    this.endAll();
    if (recorded && this.doc.undo(this.actor)) this.um.redoStack.pop();
  }

  /** How many undo steps the user has (to tell later whether a step is still the latest). */
  get undoDepth(): number {
    return this.um.undoStack.length;
  }

  /**
   * Reverts the user's latest undo step and drops it from the redo stack
   * (taking back the last point while drawing). With `expectedDepth`, only
   * when the stack still has that many steps, i.e. the step is still the latest.
   */
  revertLast(expectedDepth?: number): boolean {
    this.endAll();
    const um = this.um;
    if (expectedDepth !== undefined && um.undoStack.length !== expectedDepth) return false;
    if (um.undoStack.length === 0 || !this.doc.undo(this.actor)) return false;
    um.redoStack.pop();
    return true;
  }

  /** Whether a merge is open. */
  get grouping(): boolean {
    return this.depth > 0;
  }

  /** Runs `fn` with its batches merged into one undo step. */
  group<T>(fn: () => T): T {
    this.begin();
    try {
      return fn();
    } finally {
      this.end();
    }
  }

  undo(): boolean {
    this.endAll();
    return this.doc.undo(this.actor);
  }

  redo(): boolean {
    this.endAll();
    return this.doc.redo(this.actor);
  }

  canUndo(): boolean {
    return this.doc.canUndo(this.actor);
  }

  canRedo(): boolean {
    return this.doc.canRedo(this.actor);
  }

  private endAll(): void {
    this.soft = null;
    while (this.depth > 0) this.end();
  }
}
