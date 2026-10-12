import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'cockpit',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 140,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'cockpit',
  component: 'Pane',
  requestId: 'cockpit',
  props: {
    title: '✈ Cockpit',
    isFocused: true,
    bodyColumns: 130,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
  viewport: { columns: 200, rows: 60 },
} as const

test('the band draws and its arrows move the effort level', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: /Cockpit/ })).toBeDefined()
    await ui.press({ key: 'effort-high' })
    expect(await ui.find({ text: /^High$/ })).toBeDefined()
    await ui.press({ key: 'effort-up' })
    expect(await ui.find({ text: /X-High/ })).toBeDefined()
    await ui.press({ key: 'effort-down' })
    await ui.press({ key: 'effort-down' })
    expect(await ui.find({ text: /Medium/ })).toBeDefined()
    await ui.press({ key: 'effort-low' })
    expect(await ui.find({ text: /^Low$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a finished turn and a spawned subagent show in the cockpit', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'agent-1' }))

  await $.turn.start({ text: 'fix the bug', turnId: 't1' })
  await $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: 'Find the bug',
    description: 'find the bug',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })
  await $.turn.complete({
    answer: 'Fixed it.',
    durationMs: 1500,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: {
      model: 'claude-opus-5-5',
      input_tokens: 1200,
      output_tokens: 300,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /done/ })).toBeDefined()
    await ui.press({ key: 'tab-agents' })
    expect(await ui.find({ text: /Explore/ })).toBeDefined()
    await ui.press({ key: 'tab-usage' })
    expect(await ui.find({ text: /1\.5k/ })).toBeDefined()
    await ui.press({ key: 'tab-logs' })
    await ui.press({ key: 'filter-all' })
    expect(await ui.find({ text: /fix the bug/ })).toBeDefined()
    await ui.press({ key: 'filter-error' })
    expect(await ui.find({ text: /No events for this filter/ })).toBeDefined()
    await ui.press({ key: 'tab-git' })
    expect(await ui.find({ key: 'git-refresh' })).toBeDefined()
    await ui.press({ key: 'tab-terminal' })
    expect(await ui.find({ key: 'term-input' })).toBeDefined()
    await ui.press({ key: 'tab-settings' })
    await ui.press({ key: 'sub-model:haiku' })
    expect((await ui.find({ key: 'sub-model:haiku' }))?.props.variant).toBe('primary')
    expect(await ui.find({ key: 'preset-scout' })).toBeDefined()
    await ui.press({ key: 'tab-overview' })
    await ui.unmount()
  }
})
