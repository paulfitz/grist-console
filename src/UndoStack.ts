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
 * (fromSelf=true).
 *
 * Identifies what kind of confirmation this is by the broadcast's own fields,
 * not by a "next-arriving" flag -- otherwise a fresh edit's broadcast that
 * raced ahead of a pending redo's broadcast would be misclassified. Grist's
 * applyUserActionsById echoes back the original action's number as
 * `otherId`; fresh applyUserActions calls leave it 0/undefined.
 */
export function handleOwnActionGroup(state: AppState, ag: UndoActionGroup): void {
  if (!ag.actionNum || !ag.actionHash) { return; }
  if (ag.isUndo) {
    // Undo confirmation. executeUndo already decremented the pointer.
    return;
  }
  if (ag.otherId && ag.otherId > 0) {
    // Redo confirmation -- find the matching stack entry by its actionNum
    // and advance the pointer past it. Race-free: identity-based, not
    // arrival-order based.
    const idx = state.undoStack.findIndex(e => e.actionNum === ag.otherId);
    if (idx >= 0) {
      state.undoPointer = Math.max(state.undoPointer, idx + 1);
    }
    // If the otherId isn't in our stack, drop it -- it's neither a fresh
    // edit nor a redo we issued, so we shouldn't push it.
    return;
  }
  // New edit: trim any redo entries (they've been invalidated) and push
  state.undoStack = state.undoStack.slice(0, state.undoPointer);
  state.undoStack.push({ actionNum: ag.actionNum, actionHash: ag.actionHash });
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
    await conn.applyUserActionsById(
      [entry.actionNum], [entry.actionHash], true, { otherId: entry.actionNum },
    );
    // The undo broadcast has isUndo=true so the handler doesn't touch the
    // stack; we manage the pointer here.
    state.undoPointer--;
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
