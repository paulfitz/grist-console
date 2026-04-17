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

import { AppState } from "./ConsoleRenderer.js";
import { ConsoleConnection } from "./ConsoleConnection.js";

// Subset of ActionGroup relevant to undo stack bookkeeping.
interface UndoActionGroup {
  actionNum: number;
  actionHash: string;
  isUndo?: boolean;
  otherId?: number;
}

// Module flag used by handleOwnActionGroup to differentiate a redo broadcast
// (which shouldn't add to the stack -- just advance the pointer) from a fresh
// edit (which should trim and push).
let _expectingRedo = false;

/** Test-only: set _expectingRedo to simulate the executeRedo path. */
export function _setExpectingRedo(v: boolean): void { _expectingRedo = v; }

/**
 * Record an action-group broadcast that originated from our own client
 * (fromSelf=true). Pushes new edits to the stack, ignores undo confirmations,
 * and advances the pointer for redo confirmations without duplicating entries.
 */
export function handleOwnActionGroup(state: AppState, ag: UndoActionGroup): void {
  if (!ag.actionNum || !ag.actionHash) { return; }
  if (ag.isUndo) {
    // Undo confirmation. executeUndo already decremented the pointer.
    return;
  }
  if (_expectingRedo) {
    // Confirmation of a redo we just issued. The stack already has this
    // entry (at state.undoPointer). Just advance the pointer.
    _expectingRedo = false;
    if (state.undoPointer < state.undoStack.length) {
      state.undoPointer++;
    }
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
    // Mark that the next fromSelf non-undo broadcast is a redo, so the handler
    // doesn't push a duplicate entry. The redo's docUserAction broadcast may
    // arrive before OR after this await resolves, so we can't safely do
    // pointer++ here -- let the handler advance the pointer.
    _expectingRedo = true;
    await conn.applyUserActionsById(
      [entry.actionNum], [entry.actionHash], false, { otherId: entry.actionNum },
    );
    state.statusMessage = "Redone";
  } catch (e: any) {
    state.statusMessage = `Redo failed: ${e.message}`;
    _expectingRedo = false;
  }
}
