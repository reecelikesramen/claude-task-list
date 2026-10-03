export type Actor = 'agent' | 'user'

// `changedBy` is who last checked or unchecked the task; unset until then.
// `doneOrder` grows with each completion, so the latest completed sorts first.
export type Task = { id: string; text: string; isDone: boolean; changedBy?: Actor; doneOrder?: number }

export type TaskList = {
  isEnabled: boolean
  isHidden: boolean
  // Whether the pane had the keyboard when it was last hidden.
  wantsFocus?: boolean
  nextId: number
  tasks: Task[]
}

// The keys bound to the mod's actions ('' when unbound) and whether the
// pane's arrow and space bindings are in place.
export type Chords = { toggle: string; focus: string; hasArrows: boolean; hasSpace: boolean }

declare module 'claude-code' {
  interface PluginState {
    'task-list': { list: TaskList; unseen: number; working: boolean; pending: string[]; cursor: string; chords: Chords }
  }
}
