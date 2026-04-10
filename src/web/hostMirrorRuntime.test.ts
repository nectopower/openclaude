import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { PassThrough } from 'node:stream'

import {
  attachHostRuntimeListener,
  closeHostRuntime,
  createHostMirrorRuntime,
  resizeHostRuntime,
  writeHostRuntimeInput,
} from './hostMirrorRuntime.ts'
import {
  clearHostSession,
  getCurrentHostSession,
  registerHostSession,
} from './hostSessionRegistry.ts'
import type { TerminalTransportEvent } from './terminalTransport.ts'

function createInputStream(): NodeJS.ReadStream {
  const stream = new PassThrough() as PassThrough & NodeJS.ReadStream
  stream.isTTY = true
  stream.setRawMode = () => stream
  return stream
}

function createOutputStream(): NodeJS.WriteStream {
  const stream = new PassThrough() as PassThrough & NodeJS.WriteStream
  stream.isTTY = true
  stream.columns = 120
  stream.rows = 40
  stream.getColorDepth = () => 24
  return stream
}

beforeEach(() => {
  clearHostSession()
})

afterEach(() => {
  clearHostSession()
})

test('createHostMirrorRuntime fans out mirrored stdout and stderr to host listeners', () => {
  const stdout = createOutputStream()
  const stderr = createOutputStream()
  const runtime = createHostMirrorRuntime({
    stdin: createInputStream(),
    stdout,
    stderr,
  })

  const events: TerminalTransportEvent[] = []
  const detach = attachHostRuntimeListener('host-session-1', event => {
    events.push(event)
  })

  runtime.renderOptions.stdout?.write('hello from stdout')
  runtime.renderOptions.stderr?.write(Buffer.from('hello from stderr'))

  expect(stdout.read()?.toString()).toBe('hello from stdout')
  expect(stderr.read()?.toString()).toBe('hello from stderr')
  expect(events).toEqual([
    { type: 'output', data: 'hello from stdout' },
    { type: 'output', data: 'hello from stderr' },
  ])

  detach()
  runtime.dispose()
})

test('createHostMirrorRuntime forwards local stdin and injected host input into mirrored stdin', () => {
  const stdin = createInputStream()
  const runtime = createHostMirrorRuntime({ stdin })

  const received: string[] = []
  runtime.renderOptions.stdin?.on('data', chunk => {
    received.push(chunk.toString())
  })

  stdin.write('local input')
  writeHostRuntimeInput('host-session-1', 'remote input')

  expect(received).toEqual(['local input', 'remote input'])

  runtime.dispose()
})

test('createHostMirrorRuntime delegates ref and unref to the real stdin', () => {
  const stdin = createInputStream()
  const ref = mock(() => stdin)
  const unref = mock(() => stdin)
  stdin.ref = ref
  stdin.unref = unref

  const runtime = createHostMirrorRuntime({ stdin })

  runtime.renderOptions.stdin?.ref?.()
  runtime.renderOptions.stdin?.unref?.()

  expect(ref).toHaveBeenCalledTimes(1)
  expect(unref).toHaveBeenCalledTimes(1)

  runtime.dispose()
})

test('resizeHostRuntime updates mirrored terminal dimensions', () => {
  const runtime = createHostMirrorRuntime({
    stdin: createInputStream(),
    stdout: createOutputStream(),
    stderr: createOutputStream(),
  }, 'host-session-1')

  expect(runtime.renderOptions.stdout.columns).toBe(120)
  expect(runtime.renderOptions.stdout.rows).toBe(40)

  resizeHostRuntime('host-session-1', 150, 55)

  expect(runtime.renderOptions.stdout.columns).toBe(150)
  expect(runtime.renderOptions.stdout.rows).toBe(55)
  expect(runtime.renderOptions.stderr.columns).toBe(150)
  expect(runtime.renderOptions.stderr.rows).toBe(55)

  runtime.dispose()
})

test('closeHostRuntime emits exit and invalidates the active host session', () => {
  const session = registerHostSession({
    cwd: '/workspace/demo',
    localUrl: 'http://localhost:3080',
    publicUrl: 'https://demo.trycloudflare.com',
  })

  const runtime = createHostMirrorRuntime({
    stdin: createInputStream(),
    stdout: createOutputStream(),
    stderr: createOutputStream(),
  }, session.id)

  const events: TerminalTransportEvent[] = []
  attachHostRuntimeListener(session.id, event => {
    events.push(event)
  })

  closeHostRuntime(session.id)

  expect(events).toEqual([{ type: 'exit', code: 0 }])
  expect(getCurrentHostSession()).toBeNull()

  runtime.dispose()
})

test('closeHostRuntime disposes the runtime and prevents further output leaks', () => {
  const session = registerHostSession({
    cwd: '/workspace/demo',
    localUrl: 'http://localhost:3080',
    publicUrl: 'https://demo.trycloudflare.com',
  })
  const stdout = createOutputStream()
  const runtime = createHostMirrorRuntime({
    stdin: createInputStream(),
    stdout,
    stderr: createOutputStream(),
  }, session.id)

  const events: TerminalTransportEvent[] = []
  attachHostRuntimeListener(session.id, event => {
    events.push(event)
  })

  closeHostRuntime(session.id)
  runtime.renderOptions.stdout?.write('after-close')

  expect(events).toEqual([{ type: 'exit', code: 0 }])
})
