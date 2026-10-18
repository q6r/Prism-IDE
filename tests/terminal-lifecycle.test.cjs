const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')

function makeIpcMain() {
  const handlers = {}
  return {
    handle(channel, fn) {
      handlers[channel] = fn
    },
    on(channel, fn) {
      handlers[channel] = fn
    },
    handlers
  }
}

function makeEvent() {
  const sends = []
  return {
    sender: {
      isDestroyed: () => false,
      send(channel, payload) {
        sends.push([channel, payload])
      }
    },
    sends
  }
}

function makePtyInstance() {
  const dataCallbacks = []
  const exitCallbacks = []
  return {
    writes: [],
    resizes: [],
    kills: 0,
    write(data) {
      this.writes.push(data)
    },
    resize(cols, rows) {
      this.resizes.push([cols, rows])
    },
    kill() {
      this.kills++
      exitCallbacks.slice().forEach((cb) => cb())
    },
    onData(cb) {
      dataCallbacks.push(cb)
      return { dispose() {} }
    },
    onExit(cb) {
      exitCallbacks.push(cb)
      return { dispose() {} }
    },
    dataCallbacks,
    exitCallbacks
  }
}

function setup() {
  const ipcMain = makeIpcMain()
  const instances = []
  const ptyModule = {
    spawn() {
      const inst = makePtyInstance()
      instances.push(inst)
      return inst
    }
  }
  const mod = load('src/main/ipc/terminal.ts', {
    electron: { ipcMain },
    '@homebridge/node-pty-prebuilt-multiarch': ptyModule,
    fs: { existsSync: () => true },
    os: { homedir: () => 'C:\\home' }
  })
  mod.registerTerminalHandlers()
  return { handlers: ipcMain.handlers, instances }
}

// terminal:create / terminal:data / terminal:exit ownership

test('terminal lifecycle: a natural exit by the current owner sends exactly one terminal:exit and drops the id', () => {
  const { handlers, instances } = setup()
  const event = makeEvent()
  handlers['terminal:create'](event, { id: 'A', cols: 80, rows: 24 })
  const ptyA = instances[0]

  ptyA.exitCallbacks[0]()

  assert.deepEqual(event.sends, [['terminal:exit', { id: 'A' }]])
  // The id is free again: a new create spawns a fresh PTY rather than reusing ptyA.
  handlers['terminal:create'](event, { id: 'A', cols: 80, rows: 24 })
  assert.equal(instances.length, 2)
})

test('terminal lifecycle: live data from the current owner is forwarded to the sender', () => {
  const { handlers, instances } = setup()
  const event = makeEvent()
  handlers['terminal:create'](event, { id: 'A', cols: 80, rows: 24 })
  const ptyA = instances[0]

  ptyA.dataCallbacks[0]('hello')

  assert.deepEqual(event.sends, [['terminal:data', { id: 'A', data: 'hello' }]])
})

test('terminal lifecycle: explicit kill releases ownership first, so a synchronous onExit from kill() is never reported', () => {
  const { handlers, instances } = setup()
  const event = makeEvent()
  handlers['terminal:create'](event, { id: 'A', cols: 80, rows: 24 })
  const ptyA = instances[0]

  handlers['terminal:kill'](undefined, { id: 'A' })

  assert.equal(ptyA.kills, 1)
  assert.deepEqual(event.sends, [])
})

test('terminal lifecycle: replacing a killed id ignores the old PTY\'s stale async exit and queued data, while input/resize/kill reach the new PTY', () => {
  const { handlers, instances } = setup()
  const event = makeEvent()

  handlers['terminal:create'](event, { id: 'A', cols: 80, rows: 24 })
  const ptyA = instances[0]
  const staleDataCb = ptyA.dataCallbacks[0]
  const staleExitCb = ptyA.exitCallbacks[0]

  handlers['terminal:kill'](undefined, { id: 'A' })
  assert.deepEqual(event.sends, [])

  handlers['terminal:create'](event, { id: 'A', cols: 80, rows: 24 })
  const ptyB = instances[1]
  assert.equal(instances.length, 2)

  // Simulate the old PTY's exit/data events finally arriving asynchronously,
  // after a new PTY already owns the id.
  staleExitCb()
  staleDataCb('stale output')
  assert.deepEqual(event.sends, [])

  handlers['terminal:input'](undefined, { id: 'A', data: 'ls\n' })
  handlers['terminal:resize'](undefined, { id: 'A', cols: 100, rows: 40 })

  assert.deepEqual(ptyA.writes, [])
  assert.deepEqual(ptyB.writes, ['ls\n'])
  assert.deepEqual(ptyB.resizes.at(-1), [100, 40])

  handlers['terminal:kill'](undefined, { id: 'A' })
  assert.equal(ptyB.kills, 1)
  assert.deepEqual(event.sends, [])
})

test('terminal lifecycle: a dead id accepts input/resize/kill silently (no throw, no PTY touched)', () => {
  const { handlers } = setup()
  assert.doesNotThrow(() => {
    handlers['terminal:input'](undefined, { id: 'ghost', data: 'x' })
    handlers['terminal:resize'](undefined, { id: 'ghost', cols: 10, rows: 10 })
    handlers['terminal:kill'](undefined, { id: 'ghost' })
  })
})

// createTerminalInputBuffer — components/terminal/startup-input.ts

function bufferFixture() {
  return load('src/renderer/src/components/terminal/startup-input.ts')
}

test('createTerminalInputBuffer: keystrokes and a bracketed paste written before readiness queue in FIFO order', () => {
  const m = bufferFixture()
  const buf = m.createTerminalInputBuffer()
  buf.write('a')
  buf.write('\x1b[200~paste\x1b[201~')
  buf.write('b')

  const sent = []
  buf.flush((data) => sent.push(data))

  assert.deepEqual(sent, ['a', '\x1b[200~paste\x1b[201~', 'b'])
})

test('createTerminalInputBuffer: flush is a one-time drain, a second flush call sends nothing again', () => {
  const m = bufferFixture()
  const buf = m.createTerminalInputBuffer()
  buf.write('a')
  buf.write('b')

  const first = []
  buf.flush((data) => first.push(data))
  assert.deepEqual(first, ['a', 'b'])

  const second = []
  buf.flush((data) => second.push(data))
  assert.deepEqual(second, [])
})

test('createTerminalInputBuffer: once ready, write(data, send) delivers immediately without duplicating earlier sends', () => {
  const m = bufferFixture()
  const buf = m.createTerminalInputBuffer()
  const sent = []
  const send = (data) => sent.push(data)

  buf.write('a')
  buf.flush(send)
  assert.deepEqual(sent, ['a'])

  buf.write('c', send)
  assert.deepEqual(sent, ['a', 'c'])
})

test('createTerminalInputBuffer: write(data, send) flushes any already-pending data ahead of the new write, in order', () => {
  const m = bufferFixture()
  const buf = m.createTerminalInputBuffer()
  buf.write('x')

  const sent = []
  buf.write('y', (data) => sent.push(data))

  assert.deepEqual(sent, ['x', 'y'])
})

test('createTerminalInputBuffer: data stays queued when the sender throws, and is delivered intact on a later flush', () => {
  const m = bufferFixture()
  const buf = m.createTerminalInputBuffer()
  buf.write('a')
  buf.write('b')

  assert.throws(() => {
    buf.flush(() => {
      throw new Error('sender not ready')
    })
  })

  const recovered = []
  buf.flush((data) => recovered.push(data))
  assert.deepEqual(recovered, ['a', 'b'])
})

test('createTerminalInputBuffer: the same instance preserves data queued across multiple not-ready attempts (retry)', () => {
  const m = bufferFixture()
  const buf = m.createTerminalInputBuffer()

  buf.write('attempt-1-key')
  buf.write('attempt-2-key')

  const sent = []
  buf.flush((data) => sent.push(data))
  assert.deepEqual(sent, ['attempt-1-key', 'attempt-2-key'])
})
