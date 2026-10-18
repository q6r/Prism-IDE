const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')

function fixture() {
  return load('src/renderer/src/components/terminal/model.ts')
}

function layout(groups, activeGroup, activePane) {
  return { groups, activeGroup, activePane }
}

// removeTerminalPane

test('removeTerminalPane: removing the active pane in a group with siblings selects the new last pane in the active group', () => {
  const m = fixture()
  const l = layout([{ id: 'g1', panes: ['a', 'b', 'c'] }], 'g1', 'b')
  const result = m.removeTerminalPane(l, 'b')
  assert.deepEqual(result.groups, [{ id: 'g1', panes: ['a', 'c'] }])
  assert.equal(result.activeGroup, 'g1')
  assert.equal(result.activePane, 'c')
})

test('removeTerminalPane: removing a background (non-active) pane does not move the active pane', () => {
  const m = fixture()
  const l = layout(
    [
      { id: 'g1', panes: ['a', 'b'] },
      { id: 'g2', panes: ['c'] }
    ],
    'g2',
    'c'
  )
  const result = m.removeTerminalPane(l, 'a')
  assert.deepEqual(result.groups, [
    { id: 'g1', panes: ['b'] },
    { id: 'g2', panes: ['c'] }
  ])
  assert.equal(result.activeGroup, 'g2')
  assert.equal(result.activePane, 'c')
})

test('removeTerminalPane: removing the last pane of a split group drops the empty group and keeps other groups intact', () => {
  const m = fixture()
  const l = layout(
    [
      { id: 'g1', panes: ['a'] },
      { id: 'g2', panes: ['b'] }
    ],
    'g2',
    'b'
  )
  const result = m.removeTerminalPane(l, 'b')
  assert.deepEqual(result.groups, [{ id: 'g1', panes: ['a'] }])
  assert.equal(result.activeGroup, 'g1')
  assert.equal(result.activePane, 'a')
})

test('removeTerminalPane: removing the active pane when its own group still has panes left stays in that group', () => {
  const m = fixture()
  const l = layout([{ id: 'g1', panes: ['a', 'b'] }], 'g1', 'a')
  const result = m.removeTerminalPane(l, 'a')
  assert.deepEqual(result.groups, [{ id: 'g1', panes: ['b'] }])
  assert.equal(result.activeGroup, 'g1')
  assert.equal(result.activePane, 'b')
})

test('removeTerminalPane: removing the active pane when its group becomes empty falls back to the first remaining group', () => {
  const m = fixture()
  const l = layout(
    [
      { id: 'g1', panes: ['a'] },
      { id: 'g2', panes: ['b', 'c'] }
    ],
    'g1',
    'a'
  )
  const result = m.removeTerminalPane(l, 'a')
  assert.deepEqual(result.groups, [{ id: 'g2', panes: ['b', 'c'] }])
  assert.equal(result.activeGroup, 'g2')
  assert.equal(result.activePane, 'c')
})

test('removeTerminalPane: removing the very last pane in the whole layout produces an empty layout with cleared selection', () => {
  const m = fixture()
  const l = layout([{ id: 'g1', panes: ['a'] }], 'g1', 'a')
  const result = m.removeTerminalPane(l, 'a')
  assert.deepEqual(result, { groups: [], activeGroup: '', activePane: '' })
})

test('removeTerminalPane: removing a pane id that does not exist in any group returns the layout unchanged (same reference)', () => {
  const m = fixture()
  const l = layout([{ id: 'g1', panes: ['a', 'b'] }], 'g1', 'a')
  const result = m.removeTerminalPane(l, 'missing')
  assert.equal(result, l)
})

test('removeTerminalPane: the input layout object is never mutated', () => {
  const m = fixture()
  const l = layout([{ id: 'g1', panes: ['a', 'b'] }], 'g1', 'a')
  const snapshot = JSON.parse(JSON.stringify(l))
  m.removeTerminalPane(l, 'a')
  assert.deepEqual(l, snapshot)
})

test('removeTerminalPane: active group lookup falls back to the first group when the stored activeGroup id no longer exists', () => {
  const m = fixture()
  const l = layout(
    [
      { id: 'g1', panes: ['a'] },
      { id: 'g2', panes: ['b'] }
    ],
    'ghost',
    'a'
  )
  const result = m.removeTerminalPane(l, 'a')
  assert.deepEqual(result.groups, [{ id: 'g2', panes: ['b'] }])
  assert.equal(result.activeGroup, 'g2')
  assert.equal(result.activePane, 'b')
})

// terminalTitle

test('terminalTitle: a Windows-style backslash path returns only the final segment', () => {
  const m = fixture()
  assert.equal(m.terminalTitle('C:\\Users\\dev\\project'), 'project')
})

test('terminalTitle: a Unix-style forward-slash path returns only the final segment', () => {
  const m = fixture()
  assert.equal(m.terminalTitle('/home/dev/project'), 'project')
})

test('terminalTitle: a plain name with no separators is returned trimmed', () => {
  const m = fixture()
  assert.equal(m.terminalTitle('  bash  '), 'bash')
})

test('terminalTitle: an empty or whitespace-only title returns null', () => {
  const m = fixture()
  assert.equal(m.terminalTitle(''), null)
  assert.equal(m.terminalTitle('   '), null)
})

test('terminalTitle: a path ending in a separator (trailing slash) returns null', () => {
  const m = fixture()
  assert.equal(m.terminalTitle('/home/dev/'), null)
  assert.equal(m.terminalTitle('C:\\Users\\dev\\'), null)
})

test('terminalTitle: mixed separators split on both and return the last segment', () => {
  const m = fixture()
  assert.equal(m.terminalTitle('C:/Users\\dev/project'), 'project')
})

// canFitTerminal

test('canFitTerminal: dimensions at or above the 48x48 threshold fit', () => {
  const m = fixture()
  assert.equal(m.canFitTerminal(48, 48), true)
  assert.equal(m.canFitTerminal(100, 200), true)
})

test('canFitTerminal: dimensions below the threshold on either axis do not fit', () => {
  const m = fixture()
  assert.equal(m.canFitTerminal(47, 48), false)
  assert.equal(m.canFitTerminal(48, 47), false)
  assert.equal(m.canFitTerminal(10, 10), false)
})

test('canFitTerminal: a hidden pane with zero dimensions does not fit', () => {
  const m = fixture()
  assert.equal(m.canFitTerminal(0, 0), false)
})

test('canFitTerminal: NaN or Infinity in either dimension does not fit', () => {
  const m = fixture()
  assert.equal(m.canFitTerminal(NaN, 100), false)
  assert.equal(m.canFitTerminal(100, NaN), false)
  assert.equal(m.canFitTerminal(Infinity, 100), false)
  assert.equal(m.canFitTerminal(100, Infinity), false)
})

test('canFitTerminal: negative dimensions do not fit', () => {
  const m = fixture()
  assert.equal(m.canFitTerminal(-48, 48), false)
})

// adoptTerminals

function counters() {
  let p = 0
  let g = 0
  return { newPane: () => `p${++p}`, newGroup: () => `g${++g}` }
}

test('adoptTerminals: one group per id in order, adopted maps pane to id, last adopted is active', () => {
  const m = fixture()
  const c = counters()
  const { layout: l, adopted } = m.adoptTerminals(['t1', 't2'], false, c.newPane, c.newGroup)
  assert.deepEqual(l.groups.map((g) => g.panes), [['p1'], ['p2']])
  assert.deepEqual(adopted, { p1: 't1', p2: 't2' })
  assert.equal(l.activeGroup, l.groups[1].id)
  assert.equal(l.activePane, 'p2')
})

test('adoptTerminals: withFresh appends a new unadopted active pane', () => {
  const m = fixture()
  const c = counters()
  const { layout: l, adopted } = m.adoptTerminals(['t1'], true, c.newPane, c.newGroup)
  assert.equal(l.groups.length, 2)
  assert.deepEqual(adopted, { p1: 't1' })
  assert.equal(l.activePane, 'p2')
  assert.equal(l.activeGroup, l.groups[1].id)
})

test('adoptTerminals: no ids yields a single fresh active pane', () => {
  const m = fixture()
  const c = counters()
  const { layout: l, adopted } = m.adoptTerminals([], false, c.newPane, c.newGroup)
  assert.equal(l.groups.length, 1)
  assert.deepEqual(adopted, {})
  assert.equal(l.activePane, l.groups[0].panes[0])
  assert.equal(l.activeGroup, l.groups[0].id)
})
