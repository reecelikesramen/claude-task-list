import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const REQUEST = 'mcp__task-list__task_list_request'
const UPDATE = 'mcp__task-list__task_update'
const PANE = {
  plugin: 'task-list',
  component: 'Pane',
  requestId: 'task-list',
  props: {
    title: 'Tasks',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

// The world beneath the plugin: a store in memory, a project root, a person
// who answers every question with `answer`, and a record of what was asked.
const world = (on: On, answer: string, kept: Readonly<Record<string, unknown>> = {}) => {
  const asked: string[] = []
  const submitted: string[] = []
  const focused: (true | undefined)[] = []
  // The docked width each open of the pane asked for.
  const widths: (number | undefined)[] = []
  // What `$.ui.panes()` answers, and where the pane's focus ring was put.
  const panes: { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[] = []
  const ring: (string | undefined)[] = []
  // The scrolls that reached the engine.
  const scrolled: number[] = []
  // The dim lines the mod put in the transcript.
  const logged: string[] = []
  // The files on disk, by path: the person's keybindings.json when a test has one.
  const files: Record<string, string> = {}

  mock.store(on, kept)
  on('session.root', () => ({ value: '/proj' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  // A prompt reaching the engine: its text, and the notes riding on it.
  const prompts: { text: string; context: readonly string[] }[] = []
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__task-list__${e.name}` } }))
  on('ui.open', (_$, e) => {
    focused.push(e.focus)
    widths.push(e.columns)

    return { value: { isPlaced: true } }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '' } as never }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: panes }))
  on('env.get', (_$, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? '/cfg' : undefined }))
  on('fs.stat', (_$, e) => {
    if (files[e.path] === undefined) {
      throw new Error('missing')
    }

    return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_$, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_$, e) => {
    files[e.path] = e.text

    return { value: undefined }
  })
  // The ring's moves: the person's (an `element`) and the plugin's own
  // `$.ui.focus` (a `key`).
  on('ui.focus', (_$, e) => {
    const move = e as { element?: string; key?: string }
    ring.push(move.element ?? move.key)

    return ('key' in move ? { value: {} } : {}) as never
  })
  on('ui.scroll', (_$, e) => {
    scrolled.push(e.by)

    return {}
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', (_$, e) => {
    logged.push(e.text)

    return { value: undefined }
  })
  on('prompt.section', (_$, e) => ({ text: e.text }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const question = e.questions[0]?.question ?? ''
    asked.push(question)

    return { result: { questions: e.questions, answers: { [question]: answer } } }
  })
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    prompts.push({ text: e.text, context: e.context ?? [] })

    return { text: e.text }
  })

  const clock = mock.clock(on)

  return { asked, submitted, prompts, logged, focused, widths, panes, ring, scrolled, files, clock }
}

const start = ($: Engine) =>
  $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

const tasklist = ($: Engine, args: string) =>
  $.command.run({
    command: 'tasklist',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

// The environment section of the system prompt, as the plugin leaves it.
const promptText = async ($: Engine) => (await $.prompt.section({ name: 'env_info_simple', text: 'env' })).text ?? ''

test('off: the tool refuses and the prompt says nothing', async ($, on) => {
  world(on, 'Allow')
  await start($)

  const added = await $.tool.call({ tool: UPDATE, action: 'add', text: 'one' })

  expect(added.deny).toContain('not enabled')
  expect(await promptText($)).toBe('env')
})

test('the agent asks, the user declines: stays off', async ($, on) => {
  const { asked } = world(on, 'Not now')
  await start($)

  const answer = await $.tool.call({ tool: REQUEST, reason: 'the refactor' })

  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('the refactor')
  expect(String(answer.result)).toContain('declined')
  expect(await promptText($)).toBe('env')
})

test('the agent asks, the user allows: tasks add, complete and remove', async ($, on) => {
  world(on, 'Allow')
  await start($)

  await $.tool.call({ tool: REQUEST, reason: 'the refactor' })
  expect(await promptText($)).toContain('A persistent task list is active')

  await $.tool.call({ tool: UPDATE, action: 'add', text: 'one' })
  await $.tool.call({ tool: UPDATE, action: 'add', text: 'two' })
  await $.tool.call({ tool: UPDATE, action: 'complete', id: 't1' })
  await $.tool.call({ tool: UPDATE, action: 'remove', id: 't2' })
  const listed = await $.tool.call({ tool: UPDATE, action: 'list' })

  expect(listed.result).toBe('t1 [x] one (completed by agent)')

  const missing = await $.tool.call({ tool: UPDATE, action: 'complete', id: 't9' })
  const off = await $.tool.call({ tool: UPDATE, action: 'off' })

  expect(missing.deny).toContain('No task has id')
  expect(off.deny).toContain('action must be')
})

test('request_clear is the user\'s call', async ($, on) => {
  const { asked } = world(on, 'Keep')
  await start($)
  await tasklist($, 'on')
  await $.tool.call({ tool: UPDATE, action: 'add', text: 'one' })

  const kept = await $.tool.call({ tool: UPDATE, action: 'request_clear' })
  const listed = await $.tool.call({ tool: UPDATE, action: 'list' })

  expect(asked).toHaveLength(1)
  expect(String(kept.result)).toContain('kept')
  expect(listed.result).toBe('t1 [ ] one')
})

test('the pane checks a task off and tells the agent', { options: { autoContinue: true } }, async ($, on) => {
  const { submitted } = world(on, 'Allow')
  await start($)
  await tasklist($, 'on')
  await $.tool.call({ tool: UPDATE, action: 'add', text: 'one' })
  await $.tool.call({ tool: UPDATE, action: 'add', text: 'two' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /one/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /t1/ })).toBeDefined()
    expect(await ui.find({ key: 'hide' })).toBeDefined()

    // The keyboard is the terminal's: with no keys bound its hint says how to
    // get them. A desktop has neither the hint nor the focus button, and a
    // check glyph for a checkbox.
    const isTerminal = surface === 'terminal'
    expect((await ui.find({ type: 'Text', text: '(/tasklist keys install for hotkeys)' })) !== undefined).toBe(isTerminal)
    expect((await ui.find({ key: 'focus' })) !== undefined).toBe(isTerminal)
    expect((await ui.find({ key: 'task:t1' }))?.props.label).toBe(isTerminal ? '[ ]' : '☐')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'task:t1' })

  expect((await ui.find({ key: 'task:t1' }))?.props.label).toBe('[x]')
  expect(submitted).toEqual(['I checked off task t1: "one". 1 task(s) remain.'])

  await ui.press({ key: 'task:t1' })
  expect(submitted[1]).toBe(
    'I unchecked task t1: "one", which I had marked complete. It is open again. 2 task(s) remain.',
  )
  await ui.unmount()
})

test('/tasklist off clears the list; it comes back empty', async ($, on) => {
  world(on, 'Allow')
  await start($)
  await tasklist($, 'on')
  await $.tool.call({ tool: UPDATE, action: 'add', text: 'one' })

  const off = await tasklist($, 'off')

  expect(off.text).toBe('Task list disabled and cleared.')
  expect(await promptText($)).toBe('env')

  await tasklist($, 'on')
  const listed = await $.tool.call({ tool: UPDATE, action: 'list' })

  expect(listed.result).toBe('The task list is empty.')
})

test('a list kept for this project root comes back at session start', async ($, on) => {
  world(on, 'Allow', {
    'task-list:/proj': {
      isEnabled: true,
      isHidden: true,
      nextId: 2,
      tasks: [{ id: 't1', text: 'one', isDone: false }],
    },
    'task-list:/other': { isEnabled: true, isHidden: false, nextId: 1, tasks: [] },
  })
  await start($)

  const listed = await $.tool.call({ tool: UPDATE, action: 'list' })
  const added = await $.tool.call({ tool: UPDATE, action: 'add', text: 'two' })

  expect(listed.result).toBe('t1 [ ] one')
  expect(added.result).toBe('Added t2: two')
  expect(await promptText($)).toContain('A persistent task list is active')
})

test('unchecking what the agent completed tells the agent, and the list says who', { options: { autoContinue: true } }, async ($, on) => {
  const { submitted } = world(on, 'Allow')
  await start($)
  await tasklist($, 'on')
  await $.tool.call({ tool: UPDATE, action: 'add', text: 'one' })
  const done = await $.tool.call({ tool: UPDATE, action: 'complete', id: 't1' })

  expect(done.result).toBe('Completed t1: one\nAll tasks complete.')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'task:t1' })
  await ui.unmount()

  const listed = await $.tool.call({ tool: UPDATE, action: 'list' })

  expect(submitted).toEqual([
    'I unchecked task t1: "one", which you had marked complete. It is open again. 1 task(s) remain.',
  ])
  expect(listed.result).toBe('t1 [ ] one (reopened by user)')
})

test('bare /tasklist turns it on, then toggles the pane', async ($, on) => {
  world(on, 'Allow')
  await start($)

  expect((await tasklist($, '')).text).toBe('Task list enabled.')
  expect((await tasklist($, '')).text).toBe('Task pane hidden. The list stays active.')
  expect((await tasklist($, '')).text).toBe('Task pane shown.')
  expect(await promptText($)).toContain('A persistent task list is active')
})

test('/tasklist focus opens the pane with the keyboard, on the first open task', async ($, on) => {
  const { focused } = world(on, 'Allow')
  await start($)
  await tasklist($, 'on')
  await $.tool.call({ tool: UPDATE, action: 'add', text: 'one' })
  await $.tool.call({ tool: UPDATE, action: 'add', text: 'two' })
  await $.tool.call({ tool: UPDATE, action: 'complete', id: 't1' })

  expect((await tasklist($, 'focus')).text).toMatch(/^Task pane focused/)
  expect(focused).toEqual([undefined, true])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'task:t1' }))?.props.autoFocus).toBeUndefined()
  expect((await ui.find({ key: 'task:t2' }))?.props.autoFocus).toBe(true)
  await ui.unmount()
})

test('the agent\'s calls draw as one dim line and no result block', async ($, on) => {
  world(on, 'Allow')
  await start($)
  const row = {
    plugin: 'task-list',
    component: 'ToolUse',
    requestId: 'toolu_1',
    props: {
      tool_use_id: 'toolu_1',
      tool: UPDATE,
      input: { action: 'add', text: 'one' },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      output: 'Completed t1: one\n2 task(s) remain.',
    },
  } as const

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...row, surface })

    expect(await ui.drawn()).toMatchObject({ type: 'Markdown', props: { dimColor: true } })
    expect(await ui.find({ type: 'Markdown', text: 'Completed t1: one' })).toBeDefined()
    await ui.unmount()

    const result = await $.ui.mount({
      plugin: 'task-list',
      surface,
      component: 'ToolResult',
      requestId: 'toolu_1',
      props: { tool_use_id: 'toolu_1', tool: UPDATE, output: row.props.output, isErrored: false },
    })

    expect(await result.drawn()).toMatchObject({ type: 'Box', props: { display: 'none' } })
    await result.unmount()
  }
})

test('a task added while the pane is hidden raises a chip, fullscreen only', async ($, on) => {
  const { clock } = world(on, 'Allow')
  const band = {
    plugin: 'task-list',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 5,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 5 },
      view: {},
    },
  } as const
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)

    return <Text>nothing</Text>
  })
  await start($)
  await tasklist($, 'on')
  await tasklist($, 'hide')
  await $.tool.call({ tool: UPDATE, action: 'add', text: 'one' })
  await $.tool.call({ tool: UPDATE, action: 'add', text: 'two' })

  const main = await $.ui.mount({ ...band, viewport: { columns: 80, rows: 40, isFullscreen: false } })
  expect(await main.find({ key: 'open-tasks' })).toBeUndefined()
  // Hidden, the band keeps a count for the toggle chord to press.
  const count = await main.find({ key: 'show-tasks' })
  expect(count?.props.label).toBe('tasks 0/2')
  expect(count?.props.action).toBe('app:toggleReplTab')
  await main.unmount()

  const full = await $.ui.mount({ ...band, viewport: { columns: 80, rows: 40, isFullscreen: true } })
  expect((await full.find({ key: 'open-tasks' }))?.props.label).toBe('2 new tasks · open')

  await full.press({ key: 'open-tasks' })
  expect(await full.find({ key: 'open-tasks' })).toBeUndefined()
  expect((await tasklist($, '')).text).toBe('Task pane hidden. The list stays active.')

  await $.tool.call({ tool: UPDATE, action: 'add', text: 'three' })
  expect(await full.find({ key: 'open-tasks' })).toBeDefined()
  await clock.advance(10_000)
  expect(await full.find({ key: 'open-tasks' })).toBeUndefined()
  await full.unmount()
})

test('the user deletes a task from the pane or by command, and the agent is told', { options: { autoContinue: true } }, async ($, on) => {
  const { submitted, clock } = world(on, 'Allow')
  await start($)
  await tasklist($, 'on')
  await $.tool.call({ tool: UPDATE, action: 'add', text: 'one' })
  await $.tool.call({ tool: UPDATE, action: 'add', text: 'two' })
  await $.tool.call({ tool: UPDATE, action: 'add', text: 'three' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'remove:t1' })
  expect(await ui.find({ key: 'task:t1' })).toBeUndefined()
  await ui.unmount()

  expect((await tasklist($, 'remove 2')).text).toBe('Deleted t2: two')
  expect((await tasklist($, 'remove t9')).text).toBe('No task t9.')
  expect((await tasklist($, 'check t3')).text).toBe('Checked off t3: three')
  expect((await tasklist($, 'check t3')).text).toBe('t3 is already checked off.')
  expect((await tasklist($, 'uncheck t3')).text).toBe('Reopened t3: three')
  // A command's notice goes out a moment after the command returns.
  await clock.advance(1)

  expect(submitted).toEqual([
    'I deleted task t1: "one". 2 task(s) remain.',
    'I deleted task t2: "two". 1 task(s) remain.',
    'I checked off task t3: "three". All tasks complete.',
    'I unchecked task t3: "three", which I had marked complete. It is open again. 1 task(s) remain.',
  ])
  expect((await $.tool.call({ tool: UPDATE, action: 'list' })).result).toBe('t3 [ ] three (reopened by user)')
})

test('mid-turn, what the user did rides on the next tool result, else on the turn\'s end', { options: { autoContinue: true } }, async ($, on) => {
  const { submitted, clock } = world(on, 'Allow')
  await start($)
  await tasklist($, 'on')
  await $.tool.call({ tool: UPDATE, action: 'add', text: 'one' })
  await $.tool.call({ tool: UPDATE, action: 'add', text: 'two' })

  await $.turn.start({ text: 'go', turnId: 'turn_1' })
  await tasklist($, 'check t1')
  expect(submitted).toEqual([])

  const ran = await $.tool.call({ tool: 'Bash', command: 'true' })
  expect(ran.context).toEqual(['User checked off task t1: "one". 1 task(s) remain.'])
  expect((await $.tool.call({ tool: 'Bash', command: 'true' })).context).toBeUndefined()

  await tasklist($, 'remove t2')
  expect(submitted).toEqual([])
  await $.turn.complete({ turnId: 'turn_1', reason: 'answer', answer: 'done', durationMs: 1, isAborted: false })
  expect(submitted).toEqual(['I deleted task t2: "two". All tasks complete.'])

  await tasklist($, 'uncheck t1')
  await clock.advance(1)
  expect(submitted).toHaveLength(2)
})

test('a notice draws as one dim line in the transcript', async ($, on) => {
  world(on, 'Allow')
  await start($)
  const row = {
    plugin: 'task-list',
    surface: 'terminal',
    component: 'UserMessage',
    props: {
      text: 'The task-list plugin sent a message:\nUser unchecked task t7: "Ship it", which you had marked complete. It is open again. 2 task(s) remain.\n\nThis is how Claude Code surfaces a prompt.',
      origin: { kind: 'plugin', name: 'task-list' },
      isExpanded: true,
    },
  } as const

  const ui = await $.ui.mount(row)
  const line = await ui.find({ type: 'Text', text: /unchecked/ })
  expect(line?.props.dimColor).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^You unchecked task t7: "Ship it"$/ })).toBeDefined()
  await ui.unmount()
})

const SHOWN = { id: 'task-list', title: 'Tasks', isShown: true, isPlaced: true }

test('hiding remembers whether the pane had the keyboard; the focus button takes and returns it', async ($, on) => {
  const { focused, panes } = world(on, 'Allow')
  await start($)
  await tasklist($, 'on')
  expect(focused).toEqual([undefined])

  // Hidden unfocused, it comes back unfocused.
  await tasklist($, '')
  await tasklist($, '')
  expect(focused).toEqual([undefined, undefined])

  // The focus button of a shown, unfocused pane takes the keyboard.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'focus' }))?.props.action).toBe('app:toggleDiffNoiseFilter')
  await ui.press({ key: 'focus' })
  expect(focused).toEqual([undefined, undefined, true])

  // Hidden focused, it comes back focused.
  panes.push({ ...SHOWN, isFocused: true })
  await ui.press({ key: 'hide' })
  await tasklist($, '')
  expect(focused).toEqual([undefined, undefined, true, true])

  // Focused, the button hands the keyboard back: reopened without it.
  await ui.press({ key: 'focus' })
  expect(focused).toEqual([undefined, undefined, true, true, undefined])
  await ui.unmount()
})

test('arrows walk the checkboxes; right and left reach the row\'s × and back', async ($, on) => {
  const { panes, ring, scrolled } = world(on, 'Allow')
  await start($)
  await tasklist($, 'on')
  await $.tool.call({ tool: UPDATE, action: 'add', text: 'one' })
  await $.tool.call({ tool: UPDATE, action: 'add', text: 'two' })
  panes.push({ ...SHOWN, isFocused: true })
  const person = { component: 'Pane', requestId: 'task-list', plugin: 'task-list', origin: { kind: 'person' } } as const
  const keys = { ...person, offset: 0, bodyRows: 2, contentRows: 3 } as const

  // The ring's next stop after a checkbox is its ×: the step goes on a row.
  await $.ui.focus({ ...person, element: 'task:t1' })
  await $.ui.focus({ ...person, element: 'remove:t1' })
  expect(ring).toEqual(['task:t1', 'task:t2'])
  // And back up: the previous stop before task:t2 is remove:t1.
  await $.ui.focus({ ...person, element: 'remove:t1' })
  expect(ring).toEqual(['task:t1', 'task:t2', 'task:t1'])
  // Past the last row is the footer.
  await $.ui.focus({ ...person, element: 'task:t2' })
  await $.ui.focus({ ...person, element: 'remove:t2' })
  expect(ring.at(-1)).toBe('hide')
  // A click on a × from elsewhere lands on it.
  await $.ui.focus({ ...person, element: 'remove:t1' })
  expect(ring.at(-1)).toBe('remove:t1')

  // With the ring on a row, End (right), Home (left) and a one-row arrow are
  // the mod's to answer, so none of them scrolls; a page key still does. (The
  // ring's own move is `$.ui.focus`, which the test engine has no site for.)
  await $.ui.focus({ ...person, element: 'task:t2' })
  await $.ui.scroll({ ...keys, by: 3 })
  await $.ui.scroll({ ...keys, by: -3 })
  await $.ui.scroll({ ...keys, by: -1 })
  expect(scrolled).toEqual([])
  await $.ui.scroll({ ...keys, by: 2 })
  expect(scrolled).toEqual([2])
})

test('open tasks come first; completed ones follow, struck through, the latest first', async ($, on) => {
  world(on, 'Allow')
  await start($)
  await tasklist($, 'on')

  for (const text of ['one', 'two', 'three']) {
    await $.tool.call({ tool: UPDATE, action: 'add', text })
  }

  await $.tool.call({ tool: UPDATE, action: 'complete', id: 't1' })
  await tasklist($, 'check t2')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const boxes = (await ui.findAll({ type: 'Button' })).map(box => String(box.props.key))
  expect(boxes.filter(key => key.startsWith('task:'))).toEqual(['task:t3', 'task:t2', 'task:t1'])
  expect((await ui.find({ type: 'Text', text: /two/ }))?.props.strikethrough).toBe(true)
  expect(await ui.find({ type: 'Markdown', text: 'three' })).toBeDefined()
  await ui.unmount()
  // The agent still reads the list in the order it was written.
  expect(String((await $.tool.call({ tool: UPDATE, action: 'list' })).result).split('\n')[0]).toMatch(/^t1 \[x\]/)
})

test(
  'settings: the pane asks for its width and shows only so many completed tasks',
  { options: { paneWidth: 52, maxCompleted: 1 } },
  async ($, on) => {
    const { widths } = world(on, 'Allow')
    await start($)
    await tasklist($, 'on')
    expect(widths).toEqual([52])

    for (const text of ['one', 'two', 'three']) {
      await $.tool.call({ tool: UPDATE, action: 'add', text })
    }

    await $.tool.call({ tool: UPDATE, action: 'complete', id: 't1' })
    await $.tool.call({ tool: UPDATE, action: 'complete', id: 't2' })

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const boxes = (await ui.findAll({ type: 'Button' })).map(box => String(box.props.key))
    expect(boxes.filter(key => key.startsWith('task:'))).toEqual(['task:t3', 'task:t2'])
    expect(await ui.find({ type: 'Text', text: /\+1 more done/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2\/3 done/ })).toBeDefined()
    await ui.unmount()
  },
)

test('the footer is one row: down stops at hide, up from focus returns to the tasks', async ($, on) => {
  const { panes, ring, scrolled } = world(on, 'Allow')
  await start($)
  await tasklist($, 'on')
  await $.tool.call({ tool: UPDATE, action: 'add', text: 'one' })
  panes.push({ ...SHOWN, isFocused: true })
  const person = { component: 'Pane', requestId: 'task-list', plugin: 'task-list', origin: { kind: 'person' } } as const

  await $.ui.focus({ ...person, element: 'hide' })
  // Down or Tab from `hide` would step onto `focus`: the ring stays.
  await $.ui.focus({ ...person, element: 'focus' })
  expect(ring).toEqual(['hide'])
  // Left and right are the mod's to answer there too, so nothing scrolls.
  await $.ui.scroll({ ...person, offset: 0, bodyRows: 2, contentRows: 3, by: 3 })
  expect(scrolled).toEqual([])
})

test('/tasklist keys lists the bindings; keys install adds the missing and keeps the person\'s own', async ($, on) => {
  const { files } = world(on, 'Allow')
  const path = '/cfg/keybindings.json'
  files[path] = JSON.stringify({
    bindings: [{ context: 'Pane', bindings: { left: 'pane:grow', 'ctrl+x q': 'pane:close' } }],
  })
  await start($)

  // Works with the list off, and only reports.
  const listed = (await tasklist($, 'keys')).text ?? ''
  expect(listed).toContain('`ctrl+x t` (Global): show or hide the pane — missing')
  expect(listed).toContain('`left` (Pane): move back to the row\'s checkbox — taken (pane:grow)')
  expect(listed).toContain('add the 4 missing')
  expect(JSON.parse(files[path] ?? '{}').bindings).toHaveLength(1)

  expect((await tasklist($, 'keys install')).text).toContain('Added 4 key binding(s) to /cfg/keybindings.json')
  expect(JSON.parse(files[path] ?? '{}').bindings).toEqual([
    {
      context: 'Pane',
      bindings: { right: 'pane:bottom', left: 'pane:grow', space: 'abovePrompt:press', 'ctrl+x q': 'pane:close' },
    },
    { context: 'Global', bindings: { 'ctrl+x t': 'app:toggleReplTab', 'ctrl+x f': 'app:toggleDiffNoiseFilter' } },
  ])
  expect((await tasklist($, 'keys install')).text).toContain('Nothing to add.')

  // The hints name the keys as bound: the pane's own, and the band's when hidden.
  await tasklist($, 'on')
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: '(ctrl+x f to focus · ctrl+x t to hide)' })).toBeDefined()
  await pane.unmount()
  const focused = await $.ui.mount({ ...PANE, props: { ...PANE.props, isFocused: true }, surface: 'terminal' })
  // `left` is the person's own here, so the arrows to the × are not offered.
  expect(await focused.find({ type: 'Text', text: '(↑↓ move · enter/space press)' })).toBeDefined()
  expect(await focused.find({ type: 'Text', text: '(esc/ctrl+x f to unfocus · ctrl+x t to hide)' })).toBeDefined()
  await focused.unmount()
})

test('add with before inserts a step where it belongs in the order', async ($, on) => {
  world(on, 'Allow')
  await start($)
  await tasklist($, 'on')
  await $.tool.call({ tool: UPDATE, action: 'add', text: 'migrate' })
  await $.tool.call({ tool: UPDATE, action: 'add', text: 'deploy' })

  const added = await $.tool.call({ tool: UPDATE, action: 'add', text: 'snapshot', before: 't2' })
  expect(added.result).toBe('Added t3 before t2: snapshot')
  expect((await $.tool.call({ tool: UPDATE, action: 'list' })).result).toBe('t1 [ ] migrate\nt3 [ ] snapshot\nt2 [ ] deploy')
  expect(String((await $.tool.call({ tool: UPDATE, action: 'add', text: 'x', before: 't9' })).deny)).toContain('No task has id "t9"')
})

test('move reorders an existing task', async ($, on) => {
  world(on, 'Allow')
  await start($)
  await tasklist($, 'on')

  for (const text of ['one', 'two', 'three']) {
    await $.tool.call({ tool: UPDATE, action: 'add', text })
  }

  expect((await $.tool.call({ tool: UPDATE, action: 'move', id: 't3', before: 't1' })).result).toBe('Moved t3 before t1: three')
  expect((await $.tool.call({ tool: UPDATE, action: 'move', id: 't1' })).result).toBe('Moved t1 to the end: one')
  expect((await $.tool.call({ tool: UPDATE, action: 'list' })).result).toBe('t3 [ ] three\nt2 [ ] two\nt1 [ ] one')
  expect(String((await $.tool.call({ tool: UPDATE, action: 'move', id: 't9' })).deny)).toContain('move needs')
})

test('quietly by default: a tick starts no turn, logs one dim line and rides on the next prompt', async ($, on) => {
  const { submitted, prompts, logged } = world(on, 'Allow')
  await start($)
  await tasklist($, 'on')
  await $.tool.call({ tool: UPDATE, action: 'add', text: 'one' })
  await $.tool.call({ tool: UPDATE, action: 'add', text: 'two' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'task:t1' })
  await ui.unmount()
  expect(submitted).toEqual([])
  expect(logged).toEqual(['You completed t1: one'])

  await $.prompt.submit({ text: 'what next?', origin: { kind: 'composer' }, wait: false })
  expect(prompts.at(-1)).toEqual({ text: 'what next?', context: ['User checked off task t1: "one". 1 task(s) remain.'] })
  await $.prompt.submit({ text: 'and then?', origin: { kind: 'composer' }, wait: false })
  expect(prompts.at(-1)?.context).toEqual([])
})

test('task text is drawn as markdown while open, plain and struck through once done', async ($, on) => {
  world(on, 'Allow')
  await start($)
  await tasklist($, 'on')
  await $.tool.call({ tool: UPDATE, action: 'add', text: 'Run `npm test` on **main**' })
  await $.tool.call({ tool: UPDATE, action: 'add', text: 'Edit _README_' })
  await $.tool.call({ tool: UPDATE, action: 'complete', id: 't2' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Markdown', text: 'Run `npm test` on **main**' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: 'Edit README' }))?.props.strikethrough).toBe(true)
  await ui.unmount()
})
