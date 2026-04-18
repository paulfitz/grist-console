/**
 * Undo/redo stack for edits made during this session.
 *
 * Mirrors the web client's UndoStack (grist-core app/client/components/UndoStack.ts)
 * in behavior: track ActionGroup broadcasts from our own client, issue
 * applyUserActionsById RPCs with undo=true/false.
 *
 * The stack lives on AppState.undoStack / AppState.undoPointer so it survives
 * across renders. This module owns the pointer-advancement rules and the
 * race-handling flag.
 */

import { AppState } from "./ConsoleAppState.js";
import { ConsoleConnection } from "./ConsoleConnection.js";

// Subset of ActionGroup relevant to undo stack bookkeeping.
interface UndoActionGroup {
  actionNum: number;
  actionHash: string;
  isUndo?: boolean;
  otherId?: number;
}

/**
 * Record an action-group broadcast that originated from our own client
 * (fromSelf=true). Mirrors `pushAction` in the web client's UndoStack:
 * the broadcast is authoritative for both stack contents AND pointer
 * position, so executeUndo / executeRedo never touch the pointer
 * themselves. This keeps the local state consistent even when the user
 * fires a fresh edit while an undo/redo is still in flight (the server
 * orders the broadcasts causally, and we replay that ordering verbatim).
 *
 * `ag.otherId` echoes back the actionNum that an undo/redo targeted;
 * fresh edits leave it 0/undefined.
 */
export function handleOwnActionGroup(state: AppState, ag: UndoActionGroup): void {
  if (!ag.actionNum || !ag.actionHash) { return; }
  const otherIndex = ag.otherId
    ? state.undoStack.findIndex(e => e.actionNum === ag.otherId)
    : -1;

  if (otherIndex >= 0) {
    // Undo/redo of an action this session knows about. Pointer goes to
    // the entry index for an undo (so the next undo would step further
    // back), or just past it for a redo.
    state.undoPointer = ag.isUndo ? otherIndex : otherIndex + 1;
    return;
  }

  // Fresh edit, or undo/redo of an action no longer in our stack
  // (off the bottom after capping, or trimmed by a more recent edit).
  // Bury any redo entries -- a fresh edit invalidates the redo tail --
  // then push only when this isn't itself an undo/redo we can't track.
  state.undoStack = state.undoStack.slice(0, state.undoPointer);
  if (!ag.otherId) {
    state.undoStack.push({ actionNum: ag.actionNum, actionHash: ag.actionHash });
  }
  state.undoPointer = state.undoStack.length;
  // Cap stack size to avoid unbounded growth
  const MAX = 100;
  if (state.undoStack.length > MAX) {
    const drop = state.undoStack.length - MAX;
    state.undoStack = state.undoStack.slice(drop);
    state.undoPointer = state.undoStack.length;
  }
}

export async function executeUndo(state: AppState, conn: ConsoleConnection): Promise<void> {
  // Clamp pointer defensively in case something got out of sync
  if (state.undoPointer > state.undoStack.length) {
    state.undoPointer = state.undoStack.length;
  }
  if (state.undoPointer <= 0) {
    state.statusMessage = "Nothing to undo";
    return;
  }
  const entry = state.undoStack[state.undoPointer - 1];
  if (!entry) {
    state.statusMessage = "Nothing to undo";
    return;
  }
  try {
    // The pointer move happens in handleOwnActionGroup when the broadcast
    // arrives with isUndo=true and otherId=entry.actionNum. Trusting the
    // broadcast keeps state consistent even if the user fires a fresh
    // edit while this RPC is still in flight.
    await conn.applyUserActionsById(
      [entry.actionNum], [entry.actionHash], true, { otherId: entry.actionNum },
    );
    state.statusMessage = "Undone";
  } catch (e: any) {
    state.statusMessage = `Undo failed: ${e.message}`;
  }
}

export async function executeRedo(state: AppState, conn: ConsoleConnection): Promise<void> {
  if (state.undoPointer > state.undoStack.length) {
    state.undoPointer = state.undoStack.length;
  }
  if (state.undoPointer >= state.undoStack.length) {
    state.statusMessage = "Nothing to redo";
    return;
  }
  const entry = state.undoStack[state.undoPointer];
  if (!entry) {
    state.statusMessage = "Nothing to redo";
    return;
  }
  try {
    // The redo's broadcast carries otherId=entry.actionNum, so the handler
    // can identify it by content (no need to flag "next-arriving" anything).
    // The pointer advance happens in handleOwnActionGroup when the broadcast
    // arrives, race-free with respect to concurrent fresh edits.
    await conn.applyUserActionsById(
      [entry.actionNum], [entry.actionHash], false, { otherId: entry.actionNum },
    );
    state.statusMessage = "Redone";
  } catch (e: any) {
    state.statusMessage = `Redo failed: ${e.message}`;
  }
}
