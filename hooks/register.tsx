import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Chords, Task, TaskList } from '../types'

const PANE = 'task-list'
const PROMPT_SECTION = 'env_info_simple'
const GUIDE =
  'A persistent task list is active and visible to the user in a pane. Use the task_update tool to add, complete, and remove items as you work. Do NOT print status updates or progress checklists in chat: the user sees them in the task pane. The user may check items off, uncheck ones marked complete, or delete tasks, and you are told when they do (as a note with their next message or after a tool result, or as a message of its own); an unchecked task is open again, a deleted one is no longer wanted. The list is in the order the work should happen; insert a new step where it belongs with `before`, and reorder with the move action. Task text may use inline markdown (**bold**, _italic_, `code`) where it helps, such as a command or a file name in code. The pane shows the id of each task (t1, t2, ...) beside its text; when you mention a task in chat, give its id together with a few words of its text, never the id alone. You cannot clear or disable the list; when all tasks are complete, call task_update with action "request_clear" to ask the user.'
const REQUEST = 'mcp__task-list__task_list_request'
const UPDATE = 'mcp__task-list__task_update'
const NUDGE_MS = 10_000
// A mod cannot add a keybinding action, so each chord borrows an engine one
// that has no default key: the chord the person binds to it presses whichever
// of the mod's Buttons carrying it is mounted (the pane's, or the band's).
const TOGGLE_ACTION = 'app:toggleReplTab'
const FOCUS_ACTION = 'app:toggleDiffNoiseFilter'
const USAGE =
  'Usage: /tasklist [on|off|clear|hide|show|focus], /tasklist check|uncheck|remove <id>, or /tasklist keys [install]'
const NO_CHORDS: Chords = { toggle: '', focus: '', hasArrows: false, hasSpace: false }
const EMPTY: TaskList = { isEnabled: false, isHidden: false, nextId: 1, tasks: [] }

// The bindings `/tasklist keys install` adds to the person's keybindings.json,
// by context, each with what it does. A mod cannot ship bindings of its own.
const KEYS: Readonly<Record<string, Readonly<Record<string, readonly [action: string, does: string]>>>> = {
  Global: {
    'ctrl+x t': [TOGGLE_ACTION, 'show or hide the pane'],
    'ctrl+x f': [FOCUS_ACTION, 'give the pane the keyboard, or take it back'],
  },
  Pane: {
    right: ['pane:bottom', "move to the row's ×"],
    left: ['pane:top', "move back to the row's checkbox"],
    space: ['abovePrompt:press', 'press, as Enter does'],
  },
}

// The mod's settings (plugin.json `userConfig`), set as the module registers;
// a change in /config reloads the module with the new values.
let paneColumns = 0
let maxCompleted = 5
let autoContinue = false

const list = atom({ plugin: 'task-list', key: 'list' } as const, EMPTY)
// Tasks the agent added while the pane was out of sight; the session's alone.
const unseen = atom({ plugin: 'task-list', key: 'unseen' } as const, 0)
// True from a turn's start to its end; while it is, what the user did to the
// list waits in `pending` for the next tool result rather than for the turn.
const working = atom({ plugin: 'task-list', key: 'working' } as const, false)
const pending = atom({ plugin: 'task-list', key: 'pending' } as const, [] as string[])
// The keys the person has bound to the mod's actions, as their keybindings.json
// has them ('' when unbound): what the hints on screen name.
const chords = atom({ plugin: 'task-list', key: 'chords' } as const, NO_CHORDS)
// The key of the pane's element under the focus ring, '' before it has one.
const cursor = atom({ plugin: 'task-list', key: 'cursor' } as const, '')

// Keyed by project root so different projects have independent lists.
const storeKey = async ($: EngineInterface) =>
  `task-list:${await $.session.root()}`

const isTaskList = (value: unknown): value is TaskList =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as TaskList).isEnabled === 'boolean' &&
  Array.isArray((value as TaskList).tasks)

// Every change goes through here: $.state redraws the pane, $.store keeps it.
const write = async ($: EngineInterface, change: (now: TaskList) => TaskList) => {
  const before = await read($, list)
  const now = await update($, list, change)
  await $.store.set(await storeKey($), now)

  if (before.isEnabled !== now.isEnabled) {
    $.ui.invalidate('tool.describe')
  }

  return now
}

// `focus` asks for the keyboard too: Tab and the arrows walk the rows, Enter
// checks one, Escape hands the keys back. The engine grants it only over an
// empty composer, so it never takes keys from a prompt being typed.
const openPane = async ($: EngineInterface, focus = false) => {
  void refreshChords($)
  const opened = await $.ui.open({
    id: PANE,
    title: 'Tasks',
    ...(focus && { focus: true }),
    // The docked width asked for; one the person dragged the dock to wins.
    ...(paneColumns > 0 && { columns: paneColumns }),
  })

  if (!opened.isPlaced) {
    $.ui.toast('Task list is on. Run /tasklist show to see it.')
  }
}

const enable = async ($: EngineInterface, focus = false) => {
  await write($, now => ({ ...now, isEnabled: true, isHidden: false }))
  await update($, unseen, () => 0)
  await openPane($, focus)
}

const isPaneFocused = async ($: EngineInterface) =>
  (await $.ui.panes()).some(pane => pane.id === PANE && pane.isFocused)

// Hiding remembers whether the pane had the keyboard, and showing gives it back.
const hide = async ($: EngineInterface) => {
  const wantsFocus = await isPaneFocused($)
  await write($, now => ({ ...now, isHidden: true, wantsFocus }))
  await $.ui.close({ id: PANE })
}

const show = async ($: EngineInterface) => enable($, (await read($, list)).wantsFocus === true)

// The focus chord: the pane takes the keyboard (shown first when hidden), or
// hands it back. An open pane is closed and opened anew either way: no call
// hands the keyboard back, and a second open of an open pane is not given it.
const toggleFocus = async ($: EngineInterface) => {
  const { isHidden } = await read($, list)

  if (isHidden) {
    await enable($, true)

    return
  }

  const isFocused = await isPaneFocused($)
  await $.ui.close({ id: PANE })
  await openPane($, !isFocused)
}

type KeysFile = { bindings: { context: string; bindings: Record<string, string | null> }[] } & Record<string, unknown>

const isKeysFile = (value: unknown): value is KeysFile =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as KeysFile).bindings) &&
  (value as KeysFile).bindings.every(
    one => typeof one === 'object' && one !== null && typeof one.context === 'string' && typeof one.bindings === 'object',
  )

const keysPath = async ($: EngineInterface) =>
  `${(await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? '~'}/.claude`}/keybindings.json`

// The person's keybindings.json: parsed, `missing`, or `invalid` (unreadable
// as one, so never written over).
const readKeys = async ($: EngineInterface, path: string): Promise<KeysFile | 'missing' | 'invalid'> => {
  const exists = await $.fs.stat(path).then(
    stat => stat.kind === 'file',
    () => false,
  )

  if (!exists) {
    return 'missing'
  }

  const parsed: unknown = await $.fs.read(path).then(
    text => JSON.parse(text) as unknown,
    () => undefined,
  )

  return isKeysFile(parsed) ? parsed : 'invalid'
}

// Looks up which keys press the mod's actions, for the hints the pane and
// the band draw. A key bound in Global wins; any context's otherwise.
const refreshChords = async ($: EngineInterface) => {
  const file = await keysPath($)
    .then(path => readKeys($, path))
    .catch(() => 'missing' as const)
  const blocks = typeof file === 'string' ? [] : file.bindings
  const ordered = [...blocks.filter(one => one.context === 'Global'), ...blocks.filter(one => one.context !== 'Global')]
  const keyOf = (action: string) =>
    ordered.flatMap(one => Object.entries(one.bindings)).find(([, bound]) => bound === action)?.[0] ?? ''
  const pane = blocks.find(one => one.context === 'Pane')?.bindings ?? {}

  await update($, chords, () => ({
    toggle: keyOf(TOGGLE_ACTION),
    focus: keyOf(FOCUS_ACTION),
    hasArrows: pane.right === 'pane:bottom' && pane.left === 'pane:top',
    hasSpace: pane.space === 'abovePrompt:press',
  }))
}

// Says, binding by binding, where the mod's stand in the person's
// keybindings.json: `bound` already, `missing`, or `taken` (the key does
// something else there, which is theirs to keep). With `install`, the missing
// are written; nothing a person bound is ever changed.
const keys = async ($: EngineInterface, install: boolean) => {
  const path = await keysPath($)
  const read = await readKeys($, path)

  if (read === 'invalid') {
    return `${path} is not a keybindings file this command can read (it needs a "bindings" array). Nothing was changed.`
  }

  const file: KeysFile =
    read === 'missing'
      ? {
          $schema: 'https://www.schemastore.org/claude-code-keybindings.json',
          $docs: 'https://code.claude.com/docs/en/keybindings',
          bindings: [],
        }
      : read

  const lines: string[] = []
  let missing = 0

  for (const [context, wanted] of Object.entries(KEYS)) {
    const block = file.bindings.find(one => one.context === context)

    for (const [key, [action, does]] of Object.entries(wanted)) {
      const has = block?.bindings[key]
      const state = has === action ? 'bound' : has === undefined ? 'missing' : `taken (${has ?? 'unbound'})`
      missing += has === undefined ? 1 : 0
      lines.push(`- \`${key}\` (${context}): ${does} — ${state === 'missing' && install ? 'added' : state}`)
    }
  }

  if (!install || missing === 0) {
    const next = missing > 0 ? `Run \`/tasklist keys install\` to add the ${missing} missing.` : 'Nothing to add.'

    return [`Task list keys, in ${path}:`, ...lines, next].join('\n')
  }

  const merged: KeysFile = {
    ...file,
    bindings: [
      ...file.bindings.map(one =>
        KEYS[one.context] === undefined
          ? one
          : {
              ...one,
              bindings: {
                ...Object.fromEntries(Object.entries(KEYS[one.context] ?? {}).map(([key, [action]]) => [key, action])),
                ...one.bindings,
              },
            },
      ),
      ...Object.entries(KEYS)
        .filter(([context]) => !file.bindings.some(one => one.context === context))
        .map(([context, wanted]) => ({
          context,
          bindings: Object.fromEntries(Object.entries(wanted).map(([key, [action]]) => [key, action])),
        })),
    ],
  }
  await $.fs.write(path, `${JSON.stringify(merged, null, 2)}\n`)
  await refreshChords($)

  return [
    `Added ${missing} key binding(s) to ${path}:`,
    ...lines,
    'Claude Code picks the file up within a few seconds. If a key still does nothing, restart Claude Code.',
  ].join('\n')
}

// Moves the pane's focus ring, and records where it went: the mod's own
// moves do not come back through its `ui.focus` hook.
const focusKey = async ($: EngineInterface, key: string) => {
  const moved = await $.ui.focus({ requestId: PANE, key }).catch(() => ({ deny: 'not moved' }))

  if (moved.deny === undefined) {
    await update($, cursor, () => key)
  }
}

// A task's text without its inline markdown marks, for a row drawn struck
// through: `**bold**`, `_italic_`, `` `code` `` and `[label](url)`.
const plain = (text: string) =>
  text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_]+)[*_](?=$|[^\w*])/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')

// The pane's rows: open tasks as listed, then the completed ones, the latest
// first and `maxCompleted` of them at most; `more` counts the rest.
const laidOut = (tasks: readonly Task[]) => {
  const done = tasks.filter(task => task.isDone).sort((a, b) => (b.doneOrder ?? 0) - (a.doneOrder ?? 0))

  return {
    rows: [...tasks.filter(task => !task.isDone), ...done.slice(0, maxCompleted)],
    more: Math.max(0, done.length - maxCompleted),
  }
}

// What the next completion is stamped with, so the latest sorts first.
const nextDoneOrder = (tasks: readonly Task[]) => Math.max(0, ...tasks.map(task => task.doneOrder ?? 0)) + 1

// The pane's focus ring, in the order its Buttons are drawn.
const ringOf = (rows: readonly Task[]) => [
  ...rows.flatMap(task => [`task:${task.id}`, `remove:${task.id}`]),
  'hide',
  'focus',
]

// A move `landing` refuses: the ring stays where it is.
const STAY = ''

// Where a move of the person's lands. Tab and the arrows walk the ring one
// element at a time, which would stop on every `×`; a step onto one from its
// neighbour goes on to the next checkbox (or the footer) instead, so a `×` is
// reached only by the right arrow or a click. The footer's two buttons are
// one row the same way: `focus` is right of `hide`, not below it.
const landing = (from: string, to: string | undefined, rows: readonly Task[]) => {
  if (to === 'focus' && from === 'hide') {
    return STAY
  }

  if (to === 'hide' && from === 'focus') {
    const last = rows.at(-1)

    return last === undefined ? STAY : `task:${last.id}`
  }

  if (to === undefined || !to.startsWith('remove:')) {
    return to
  }

  const ring = ringOf(rows)
  const at = ring.indexOf(to)

  if (ring[at - 1] === from) {
    return ring[at + 1]
  }

  return ring[at + 1] === from ? ring[at - 1] : to
}

const remainText = (tasks: readonly Task[]) => {
  if (tasks.length === 0) {
    return 'The list is now empty.'
  }

  const remaining = tasks.filter(task => !task.isDone).length

  return remaining > 0 ? `${remaining} task(s) remain.` : 'All tasks complete.'
}

// A notice as a prompt of the user's own: sent `asUser`, it reads in the
// transcript as one line of theirs, without the frame the engine puts around
// a plugin's prompt for the agent.
const ownWords = (text: string) => text.replace(/^User /gm, 'I ').replace(/which they had marked/g, 'which I had marked')

// Tells the agent what the user did to the list.
//
// Quietly, by default: the notice waits in `pending` and rides on the agent's
// next tool result (the `tool.call` hook) or the person's next prompt (the
// `prompt.submit` hook), so a tick starts no turn and adds no prompt to the
// transcript. Mid-turn it waits the same way whatever the setting, since a
// plugin's prompt would only run once the turn ends.
//
// With the `autoContinue` setting, an idle agent is sent the notice as a
// prompt at once, so it carries on. `later` is for a `command.run` hook, where
// the engine refuses a submit (it would wait on the turn the hook holds): the
// prompt goes out a moment after.
//
// `line` is what the transcript shows for it: one dim line, not sent to the
// agent.
const notify = async ($: EngineInterface, text: string, line: string, later = false) => {
  if (!autoContinue || (await read($, working))) {
    await update($, pending, now => [...now, text])

    // From the pane, the transcript gets one dim line for it, as the agent's
    // own changes do (a typed command prints its own row).
    if (!later) {
      $.ui.log(line)
    }

    return
  }

  // Resolves only once that turn starts.
  const send = () => void $.prompt.submit({ text: ownWords(text), asUser: true }).catch(() => {})

  if (later) {
    $.clock.after(1, send)
  } else {
    send()
  }
}

// The user's check or uncheck, from the pane or `/tasklist check|uncheck`.
const toggle = async ($: EngineInterface, id: string, later = false) => {
  const before = (await read($, list)).tasks.find(one => one.id === id)
  const now = await write($, state => ({
    ...state,
    tasks: state.tasks.map(task => {
      if (task.id !== id) {
        return task
      }

      const { doneOrder: _was, ...open } = task

      return task.isDone
        ? { ...open, isDone: false, changedBy: 'user' }
        : { ...task, isDone: true, changedBy: 'user', doneOrder: nextDoneOrder(state.tasks) }
    }),
  }))
  const task = now.tasks.find(one => one.id === id)

  if (before === undefined || task === undefined) {
    return undefined
  }

  const rest = remainText(now.tasks)
  await notify(
    $,
    task.isDone
      ? `User checked off task ${id}: "${task.text}". ${rest}`
      : `User unchecked task ${id}: "${task.text}", which ${before.changedBy === 'user' ? 'they' : 'you'} had marked complete. It is open again. ${rest}`,
    `You ${task.isDone ? 'completed' : 'reopened'} ${id}: ${plain(task.text)}`,
    later,
  )

  return task
}

// The user's delete, from the pane's `×` or `/tasklist remove`.
const removeByUser = async ($: EngineInterface, id: string, later = false) => {
  const task = (await read($, list)).tasks.find(one => one.id === id)

  if (task === undefined) {
    return undefined
  }

  const before = await read($, list)
  const row = laidOut(before.tasks).rows.findIndex(one => one.id === id)
  const now = await write($, state => ({ ...state, tasks: state.tasks.filter(one => one.id !== id) }))
  await notify(
    $,
    `User deleted task ${id}: "${task.text}". ${remainText(now.tasks)}`,
    `You deleted ${id}: ${plain(task.text)}`,
    later,
  )

  // Deleted from the keyboard, the ring moves to the row that took its place.
  if ((await read($, cursor)).endsWith(`:${id}`) && (await isPaneFocused($))) {
    const { rows } = laidOut(now.tasks)
    const heir = rows[row] ?? rows[row - 1]
    void focusKey($, heir === undefined ? 'hide' : `task:${heir.id}`)
  }

  return task
}

// A notice as the transcript shows it: what happened, less what is the agent's
// to read (the count that follows, and the frame the engine puts around a
// plugin's prompt). '' when the text holds no notice of the mod's.
const noticeRow = (text: string) =>
  text
    .split('\n')
    .filter(line => /^(User|I) (checked off|unchecked|deleted) task /.test(line))
    .map(line =>
      line
        .replace(/^(User|I) /, 'You ')
        .replace(
          /(\.|, which (you|they|I) had marked complete\. It is open again\.) (\d+ task\(s\) remain\.|All tasks complete\.|The list is now empty\.)$/,
          '',
        ),
    )
    .join('\n')

// A dismissed dialog, or a run with nobody to ask, counts as "no".
const confirm = async (
  $: EngineInterface,
  question: string,
  yes: string,
  no: string,
) => {
  try {
    const answer = await $.ui.ask(question, { options: [yes, no], header: 'Task list' })

    return answer === yes
  } catch {
    return false
  }
}

const who = (task: Task) =>
  task.changedBy === undefined
    ? ''
    : ` (${task.isDone ? 'completed' : 'reopened'} by ${task.changedBy})`

const format = (tasks: readonly Task[]) =>
  tasks.length === 0
    ? 'The task list is empty.'
    : tasks
        .map(task => `${task.id} ${task.isDone ? '[x]' : '[ ]'} ${task.text}${who(task)}`)
        .join('\n')

// The pane's own, dimmer telling of `who`, from the person's side.
const mark = (task: Task) => {
  if (task.changedBy === undefined) {
    return ''
  }

  if (task.changedBy === 'agent') {
    return ' · by claude'
  }

  return task.isDone ? ' · by you' : ' · reopened'
}

const textOf = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(textOf).join('\n')
  }

  if (typeof value === 'object' && value !== null) {
    const { text, content, result } = value as Record<string, unknown>

    return textOf(text ?? content ?? result ?? '')
  }

  return ''
}

// A tool call's whole transcript row: the first line of what the tool answered.
const rowText = (tool: string, input: unknown, output: unknown) => {
  if (output === undefined) {
    return tool === REQUEST ? 'Asking to use a task list…' : 'Updating the task list…'
  }

  if ((input as { action?: unknown } | null)?.action === 'list') {
    return 'Read the task list'
  }

  return textOf(output).split('\n')[0] || 'Updated the task list'
}

let nudge: Timer | undefined

// Raises the "new task" chip while the pane is out of sight, for a while.
const nudgeIfUnseen = async ($: EngineInterface, now: TaskList) => {
  const panes = await $.ui.panes()
  const isInSight =
    !now.isHidden && panes.some(pane => pane.id === PANE && pane.isPlaced && pane.isShown)

  if (isInSight) {
    return
  }

  await update($, unseen, count => count + 1)
  nudge?.cancel()
  nudge = $.clock.after(NUDGE_MS, () => void update($, unseen, () => 0))
}

export const register: Register = (on, options) => {
  paneColumns = typeof options.paneWidth === 'number' ? Math.max(0, Math.floor(options.paneWidth)) : 0
  maxCompleted = typeof options.maxCompleted === 'number' ? Math.max(0, Math.floor(options.maxCompleted)) : 5
  autoContinue = options.autoContinue === true

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tasklist',
      description: 'Toggle the task checklist; or turn it on or off, clear it, hide, show or focus its pane, check, uncheck or remove a task',
      argumentHint: '[on|off|clear|hide|show|focus|check <id>|uncheck <id>|remove <id>|keys [install]]',
      immediate: true,
    })
    await $.tool.register({
      name: 'task_list_request',
      description:
        'Request to enable the persistent task list for this session. Call this when you are about to work on a multi-step task (2+ distinct items) and would benefit from tracking progress in a user-visible checklist. The user must approve.',
      inputSchema: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'A few words on what the list would track, shown to the user',
          },
        },
      },
    })
    await $.tool.register({
      name: 'task_update',
      description:
        'Update the persistent task list visible to the user. Use add to create items, complete to mark done, remove to delete, move to reorder, list to read it back. The list is in the order the work should happen: add items in that order, use before to insert one ahead of another, and move (id, before) to put an existing one elsewhere. Call this whenever your plan changes. Only the user can clear or disable the list; request_clear asks them.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'complete', 'remove', 'move', 'list', 'request_clear'],
          },
          id: { type: 'string', description: 'Task id (for complete/remove/move)' },
          text: {
            type: 'string',
            description:
              'Task text (for add): one short line. Inline markdown is drawn: **bold**, _italic_, `code`, [links](https://example.com).',
          },
          before: {
            type: 'string',
            description: 'For add and move: the id of the task to put this one before. Left out, it goes last.',
          },
        },
        required: ['action'],
      },
    })

    await refreshChords($)
    const stored = await $.store.get(await storeKey($))

    if (isTaskList(stored)) {
      await update($, list, () => stored)

      if (stored.isEnabled && !stored.isHidden) {
        void openPane($)
      }
    }

    return next(e)
  })

  // A registered tool cannot be withdrawn. Once the list is on, the request
  // tool is put behind ToolSearch and says so. task_update stays in front
  // either way, saying when it is inactive: deferred, its schema would not be
  // loaded when the list is enabled mid-turn, and the first calls go wrong.
  on('tool.describe', { tool: 'mcp__task-list__task_list_request' }, async ($, e, next) => {
    const described = await next(e)
    const { isEnabled } = await read($, list)

    return isEnabled
      ? { description: 'Inactive: the task list is already on. Use task_update.', isDeferred: true }
      : { ...described, isDeferred: false }
  })

  on('tool.describe', { tool: 'mcp__task-list__task_update' }, async ($, e, next) => {
    const described = await next(e)
    const { isEnabled } = await read($, list)

    return isEnabled
      ? { ...described, isDeferred: false }
      : {
          ...described,
          description: `Inactive until the user enables the task list: call task_list_request first. ${described.description}`,
          isDeferred: false,
        }
  })

  on('tool.call', { tool: 'mcp__task-list__task_list_request' }, async ($, e) => {
    const { isEnabled } = await read($, list)

    if (isEnabled) {
      return { result: 'Task list is already on.\nUse task_update to add and track items: one call per item, in the order the work should happen.' }
    }

    const reason =
      typeof e.reason === 'string' && e.reason.trim() !== ''
        ? e.reason.trim().slice(0, 200)
        : 'a multi-step task'
    const isAllowed = await confirm(
      $,
      `Claude would like to use a task list for: ${reason}. Allow?`,
      'Allow',
      'Not now',
    )

    if (!isAllowed) {
      return {
        result:
          'Task list declined by the user.\nCarry on without it and do not ask again unless they bring it up.',
      }
    }

    await enable($)

    return { result: 'Task list enabled.\nUse task_update to add and track items: one call per item, in the order the work should happen.' }
  })

  on('tool.call', { tool: 'mcp__task-list__task_update' }, async ($, e) => {
    const state = await read($, list)

    if (!state.isEnabled) {
      return { deny: 'The task list is not enabled. Call task_list_request to ask the user to turn it on.' }
    }

    const id = typeof e.id === 'string' ? e.id.trim() : ''
    const text = typeof e.text === 'string' ? e.text.trim() : ''

    switch (e.action as string) {
      case 'add': {
        if (text === '') {
          return { deny: 'add needs a non-empty "text".' }
        }

        const before = typeof e.before === 'string' ? e.before.trim() : ''

        if (before !== '' && !state.tasks.some(task => task.id === before)) {
          return { deny: `No task has id "${before}" to insert before.\n${format(state.tasks)}` }
        }

        const added = `t${state.nextId}`
        const now = await write($, one => {
          const task = { id: `t${one.nextId}`, text, isDone: false }
          const at = before === '' ? -1 : one.tasks.findIndex(other => other.id === before)

          return {
            ...one,
            nextId: one.nextId + 1,
            tasks: at < 0 ? [...one.tasks, task] : [...one.tasks.slice(0, at), task, ...one.tasks.slice(at)],
          }
        })
        await nudgeIfUnseen($, now)

        return { result: `Added ${added}${before === '' ? '' : ` before ${before}`}: ${text}` }
      }

      case 'move': {
        const before = typeof e.before === 'string' ? e.before.trim() : ''
        const target = state.tasks.find(task => task.id === id)

        if (target === undefined || (before !== '' && !state.tasks.some(task => task.id === before)) || before === id) {
          return { deny: `move needs the "id" of a task and, to put it ahead of another, that task's id as "before".\n${format(state.tasks)}` }
        }

        await write($, one => {
          const rest = one.tasks.filter(task => task.id !== id)
          const at = before === '' ? -1 : rest.findIndex(task => task.id === before)

          return { ...one, tasks: at < 0 ? [...rest, target] : [...rest.slice(0, at), target, ...rest.slice(at)] }
        })

        return { result: `Moved ${id} ${before === '' ? 'to the end' : `before ${before}`}: ${target.text}` }
      }

      case 'complete':
      case 'remove': {
        const target = state.tasks.find(task => task.id === id)

        if (target === undefined) {
          return { deny: `No task has id "${id}".\n${format(state.tasks)}` }
        }

        if (e.action === 'complete' && target.isDone) {
          return { result: `${id} is already complete${who(target)}: ${target.text}\n${remainText(state.tasks)}` }
        }

        const now = await write($, one => ({
          ...one,
          tasks:
            e.action === 'remove'
              ? one.tasks.filter(task => task.id !== id)
              : one.tasks.map(task =>
                  task.id === id && !task.isDone
                    ? { ...task, isDone: true, changedBy: 'agent', doneOrder: nextDoneOrder(one.tasks) }
                    : task,
                ),
        }))

        return {
          result: `${e.action === 'remove' ? 'Removed' : 'Completed'} ${id}: ${target.text}\n${remainText(now.tasks)}`,
        }
      }

      case 'list':
        return { result: format(state.tasks) }

      case 'request_clear': {
        if (state.tasks.length === 0) {
          return { result: 'The task list is already empty.' }
        }

        const open = state.tasks.filter(task => !task.isDone).length
        const isCleared = await confirm(
          $,
          open === 0
            ? 'All tasks complete. Clear the task list?'
            : `${open} task(s) are still open. Clear the task list anyway?`,
          'Clear',
          'Keep',
        )

        if (!isCleared) {
          return { result: 'Task list kept by the user.' }
        }

        await write($, one => ({ ...one, tasks: [] }))

        return { result: 'Task list cleared by the user.' }
      }

      default:
        return { deny: 'action must be one of add, complete, remove, move, list, request_clear.' }
    }
  })

  on('command.run', { command: 'tasklist' }, async ($, e) => {
    const state = await read($, list)
    const [arg = '', given = ''] = e.args.trim().toLowerCase().split(/\s+/)
    // `7` is `t7`.
    const id = /^\d+$/.test(given) ? `t${given}` : given

    if (arg === 'on' || (arg === '' && !state.isEnabled)) {
      await enable($)

      return state.isEnabled
        ? { text: 'Task list is already on.' }
        : {
            text: 'Task list enabled.',
            context: ['The user enabled the task list. Use task_update to add and track items.'],
          }
    }

    if (arg === 'keys') {
      return given === '' || given === 'install' ? { text: await keys($, given === 'install') } : { text: USAGE }
    }

    if (!state.isEnabled) {
      return {
        text: arg === 'off' ? 'Task list is already off.' : 'Task list is off. Run /tasklist to turn it on.',
      }
    }

    switch (arg) {
      case 'off':
        nudge?.cancel()
        await update($, unseen, () => 0)
        await update($, list, () => EMPTY)
        await $.store.delete(await storeKey($))
        $.ui.invalidate('tool.describe')
        await $.ui.close({ id: PANE })

        return {
          text: 'Task list disabled and cleared.',
          context: ['The user turned the task list off. Stop using task_update and report progress in chat.'],
        }

      case 'clear':
        await write($, now => ({ ...now, tasks: [] }))

        return { text: 'Task list cleared.', context: ['The user cleared the task list.'] }

      case 'hide':
        await hide($)

        return { text: 'Task pane hidden. The list stays active.' }

      case 'show':
        await show($)

        return { text: 'Task pane shown.' }

      case 'focus':
        await enable($, true)

        return { text: 'Task pane focused: arrows or Tab to move, Enter to press, Esc to return.' }

      case 'check':
      case 'uncheck': {
        const task = state.tasks.find(one => one.id === id)

        if (task === undefined) {
          return { text: id === '' ? USAGE : `No task ${id}.` }
        }

        if (task.isDone === (arg === 'check')) {
          return { text: `${id} is already ${task.isDone ? 'checked off' : 'open'}.` }
        }

        await toggle($, id, true)

        return { text: `${arg === 'check' ? 'Checked off' : 'Reopened'} ${id}: ${task.text}` }
      }

      case 'remove': {
        const task = await removeByUser($, id, true)

        if (task === undefined) {
          return { text: id === '' ? USAGE : `No task ${id}.` }
        }

        return { text: `Deleted ${id}: ${task.text}` }
      }

      case '':
        if (state.isHidden) {
          await show($)

          return { text: 'Task pane shown.' }
        }

        await hide($)

        return { text: 'Task pane hidden. The list stays active.' }

      default:
        return { text: USAGE }
    }
  })

  // The person closing the pane by hand is a hide, so a reload leaves it shut.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const wantsFocus = e.origin.kind === 'person' && (await isPaneFocused($))
    const closed = await next(e)

    if (e.origin.kind === 'person') {
      await write($, now => (now.isEnabled ? { ...now, isHidden: true, wantsFocus } : now))
    }

    return closed
  })

  // The agent's standing instructions while the list is on, appended to the
  // environment section of the system prompt (`prompt.section` is in every
  // build that loads hooks modules; `prompt.compose`, which could add a
  // section of its own, is not). Off, the prompt is as the engine wrote it.
  on('prompt.section', { name: PROMPT_SECTION }, async ($, e, next) => {
    const section = await next(e)
    const { isEnabled } = await read($, list)

    return isEnabled && section.text !== null ? { text: `${section.text}\n\n${GUIDE}` } : section
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const { tasks } = await read($, list)
    const { rows, more } = laidOut(tasks)
    const bound = await read($, chords)
    const done = tasks.filter(task => task.isDone).length
    // The keyboard is the terminal's: its focus button, its key hints and its
    // bracket checkboxes. A desktop draws real buttons a pointer presses, so
    // it gets a check glyph and none of the rest.
    const isTerminal = e.surface === 'terminal'
    // The keys that work right now, as the person has them bound: how to move
    // (focused only), then how to leave or take the keyboard and hide the pane.
    const moves = e.props.isFocused
      ? ['↑↓ move', bound.hasArrows && '←/→ ×', `enter${bound.hasSpace ? '/space' : ''} press`]
          .filter(one => one !== false)
          .join(' · ')
      : ''
    const hint =
      [
        e.props.isFocused
          ? `esc${bound.focus === '' ? '' : `/${bound.focus}`} to unfocus`
          : bound.focus !== '' && `${bound.focus} to focus`,
        bound.toggle !== '' && `${bound.toggle} to hide`,
      ]
        .filter(one => one !== false)
        .join(' · ') || '/tasklist keys install for hotkeys'
    // Ids share one column, so `t6` and `t10` start their text in line.
    const idColumns = Math.max(0, ...rows.map(task => task.id.length)) + 1
    // Where the keyboard lands when the pane takes it: the first open task.
    const first = rows.find(task => !task.isDone)?.id

    return (
      <Box flexDirection="column">
        {tasks.length === 0 && <Text dimColor>No tasks yet</Text>}
        {rows.map(task => (
          <Box>
            <Box flexShrink={0}>
              <Button
                key={`task:${task.id}`}
                plain
                label={isTerminal ? (task.isDone ? '[x]' : '[ ]') : task.isDone ? '☑' : '☐'}
                dimColor={task.isDone}
                {...(task.id === first && { autoFocus: true })}
                onPress={() => toggle($, task.id)}
              />
            </Box>
            <Box flexShrink={0} width={idColumns + 1}>
              <Text dimColor> {task.id}</Text>
            </Box>
            {task.isDone ? (
              <Text dimColor strikethrough>
                {plain(task.text)}
              </Text>
            ) : (
              <Markdown text={task.text} />
            )}
            <Box flexShrink={0}>
              <Text dimColor>{mark(task)} </Text>
              <Button key={`remove:${task.id}`} plain dimColor label="×" onPress={() => removeByUser($, task.id)} />
            </Box>
          </Box>
        ))}
        {more > 0 && <Text dimColor>    +{more} more done</Text>}
        <Box marginTop={1}>
          <Text dimColor>
            {done}/{tasks.length} done{' '}
          </Text>
          <Button key="hide" label="hide" action={TOGGLE_ACTION} onPress={() => hide($)} />
          {isTerminal && <Text> </Text>}
          {isTerminal && (
            <Button
              key="focus"
              action={FOCUS_ACTION}
              label={e.props.isFocused ? 'unfocus' : 'focus'}
              onPress={() => toggleFocus($)}
            />
          )}
        </Box>
        {isTerminal && moves !== '' && <Text dimColor>({moves})</Text>}
        {isTerminal && <Text dimColor>({hint})</Text>}
      </Box>
    )
  })

  // The agent's calls are one dim line each, in place of the engine's
  // `task-list - task_update (MCP)(...)` row and the result block under it.
  for (const tool of [REQUEST, UPDATE]) {
    on('ui.render', { component: 'ToolUse', props: { tool } }, ($, e) => {
      const { Markdown } = $.ui.resolve(e)

      return <Markdown dimColor text={rowText(e.props.tool, e.props.input, e.props.output)} />
    })

    on('ui.render', { component: 'ToolResult', props: { tool } }, ($, e) => {
      const { Box } = $.ui.resolve(e)

      return <Box display="none" />
    })
  }

  // What the user did to the list mid-turn reaches the agent with the next
  // tool result of the main loop, as a note after it.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId !== undefined || result.deny !== undefined) {
      return result
    }

    const notices = await read($, pending)

    if (notices.length === 0) {
      return result
    }

    await update($, pending, () => [])

    return { ...result, context: [...(result.context ?? []), ...notices] }
  })

  // Quiet notices also ride on the person's next prompt, as a note the agent
  // reads with it and the transcript does not show.
  on('prompt.submit', async ($, e, next) => {
    const notices = await read($, pending)

    if (notices.length === 0 || (e.origin.kind === 'plugin' && e.origin.name === 'task-list')) {
      return next(e)
    }

    await update($, pending, () => [])

    return next({ ...e, context: [...(e.context ?? []), ...notices] })
  })

  on('turn.start', async ($, e, next) => {
    await update($, working, () => true)

    return next(e)
  })

  // With `autoContinue`, a turn that ended with no tool call after the notice
  // sends it as a prompt; quietly, it waits for the next prompt or tool call.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId !== undefined) {
      return result
    }

    await update($, working, () => false)
    const notices = autoContinue ? await read($, pending) : []

    if (notices.length > 0) {
      await update($, pending, () => [])
      void $.prompt.submit({ text: notices.map(ownWords).join('\n'), asUser: true }).catch(() => {})
    }

    return result
  })

  // The notice's row in the transcript: one dim line, in place of the prompt
  // as the engine frames it for the agent.
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    const { origin, text } = e.props

    const row = origin.kind === 'plugin' && origin.name === 'task-list' ? noticeRow(text) : ''

    if (row === '') {
      return next(e)
    }

    const { Text } = $.ui.resolve(e)

    return <Text dimColor>{row}</Text>
  })

  // The ring's moves, the person's redirected by `landing`; where it ends up
  // is kept for the arrow keys below and for a delete.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const { tasks } = await read($, list)
    const element =
      e.origin.kind === 'person' ? landing(await read($, cursor), e.element, laidOut(tasks).rows) : e.element

    if (element === STAY) {
      return {}
    }

    const moved = await next(element === e.element ? e : { ...e, element })

    if (moved.deny === undefined) {
      await update($, cursor, () => element ?? '')
    }

    return moved
  })

  // The pane has no key events of its own, but its scroll keys raise this.
  // With the ring on a row, Home and End (and left and right, once bound to
  // `pane:top` and `pane:bottom`) are the row's two ends, the checkbox and the
  // `×`; and an arrow that would scroll a long list moves a row instead.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    const at = await read($, cursor)

    if (e.origin.kind !== 'person' || e.pointer !== undefined || at === '' || !(await isPaneFocused($))) {
      return next(e)
    }

    const [, id] = at.split(':')

    if (Math.abs(e.by) === e.contentRows) {
      const isRight = e.by > 0

      // The footer is a row too: `hide`, then `focus`.
      await focusKey($, id === undefined ? (isRight ? 'focus' : 'hide') : `${isRight ? 'remove' : 'task'}:${id}`)

      return {}
    }

    const { rows } = laidOut((await read($, list)).tasks)
    const to = Math.abs(e.by) === 1 && id !== undefined ? rows[rows.findIndex(task => task.id === id) + e.by] : undefined

    if (to === undefined) {
      return next(e)
    }

    await focusKey($, `task:${to.id}`)
    void $.ui.scroll({ to: { key: `task:${to.id}` }, in: PANE }).catch(() => {})

    return {}
  })

  // While the pane is out of sight the band holds what opens it: the "new
  // task" chip (fullscreen only, for a while), else a dim count; with `focus`
  // beside it, they are there so the two chords have Buttons to press.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { isEnabled, isHidden, tasks } = await read($, list)
    const count = await read($, unseen)
    const isTerminal = e.surface === 'terminal'
    const isChip = count > 0 && (!isTerminal || e.viewport?.isFullscreen === true)

    if (e.props.hasSurvey || (!isChip && !(isEnabled && isHidden))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const done = tasks.filter(task => task.isDone).length
    const bound = await read($, chords)
    const toggleHint = !isTerminal || bound.toggle === '' ? '' : ` (${bound.toggle})`
    const focusHint = bound.focus === '' ? '' : ` (${bound.focus})`

    return (
      <Box width={e.props.bodyColumns} justifyContent="flex-end" paddingRight={4}>
        {isChip ? (
          <Button
            key="open-tasks"
            dimColor
            action={TOGGLE_ACTION}
            label={`${count} new task${count === 1 ? '' : 's'} · open${toggleHint}`}
            onPress={() => show($)}
          />
        ) : (
          <Button
            key="show-tasks"
            plain
            dimColor
            action={TOGGLE_ACTION}
            label={`tasks ${done}/${tasks.length}${toggleHint}`}
            onPress={() => show($)}
          />
        )}
        {isTerminal && <Text dimColor> · </Text>}
        {isTerminal && (
          <Button
            key="focus-tasks"
            plain
            dimColor
            action={FOCUS_ACTION}
            label={`focus${focusHint}`}
            onPress={() => toggleFocus($)}
          />
        )}
      </Box>
    )
  })
}
