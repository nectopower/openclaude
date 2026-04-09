import { PassThrough } from 'node:stream'

import { getCurrentHostSession, invalidateHostSession } from './hostSessionRegistry.js'
import type { TerminalTransportEvent } from './terminalTransport.js'

export type HostMirrorRuntime = {
  renderOptions: {
    stdin: NodeJS.ReadStream
    stdout: NodeJS.WriteStream
    stderr: NodeJS.WriteStream
  }
  dispose(): void
}

type HostRuntimeListener = (event: TerminalTransportEvent) => void

type HostMirrorRuntimeOptions = {
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream
  stderr?: NodeJS.WriteStream
}

type MirroredInput = {
  stream: NodeJS.ReadStream
  write(data: string): void
  dispose(): void
}

type MirroredOutput = {
  stream: NodeJS.WriteStream
  resize(cols: number, rows: number): void
  dispose(): void
}

type ActiveRuntime = HostMirrorRuntime & {
  sessionId?: string
  writeInput(data: string): void
  resize(cols: number, rows: number): void
  close(code?: number): void
}

const listeners = new Map<string, Set<HostRuntimeListener>>()
let activeRuntime: ActiveRuntime | null = null

function getTargetListenerSets(sessionId?: string): Set<HostRuntimeListener>[] {
  const resolvedSessionId = sessionId ?? getCurrentHostSession()?.id
  if (resolvedSessionId) {
    const sessionListeners = listeners.get(resolvedSessionId)
    return sessionListeners ? [sessionListeners] : []
  }

  return Array.from(listeners.values())
}

function emitRuntimeEvent(event: TerminalTransportEvent, sessionId?: string): void {
  for (const listenerSet of getTargetListenerSets(sessionId)) {
    for (const listener of listenerSet) {
      listener(event)
    }
  }
}

function clearRuntimeListeners(sessionId?: string): void {
  const resolvedSessionId = sessionId ?? getCurrentHostSession()?.id
  if (resolvedSessionId) {
    listeners.delete(resolvedSessionId)
    return
  }

  listeners.clear()
}

function createMirroredInput(
  source: NodeJS.ReadStream,
  sessionId?: string,
): MirroredInput {
  const proxy = new PassThrough() as PassThrough & NodeJS.ReadStream

  proxy.isTTY = source.isTTY
  proxy.setRawMode = (value: boolean) => {
    source.setRawMode?.(value)
    return proxy
  }
  proxy.ref = () => {
    source.ref?.()
    return proxy
  }
  proxy.unref = () => {
    source.unref?.()
    return proxy
  }
  proxy.resume = () => {
    source.resume()
    return PassThrough.prototype.resume.call(proxy) as typeof proxy
  }
  proxy.pause = () => {
    source.pause()
    return PassThrough.prototype.pause.call(proxy) as typeof proxy
  }

  Object.defineProperty(proxy, 'fd', {
    configurable: true,
    enumerable: false,
    get: () => (source as NodeJS.ReadStream & { fd?: number }).fd,
  })

  const forwardData = (chunk: string | Buffer) => {
    proxy.write(chunk)
  }
  const forwardEnd = () => {
    proxy.end()
  }
  const forwardError = (error: Error) => {
    emitRuntimeEvent({ type: 'error', message: error.message }, sessionId)
    proxy.destroy()
  }

  source.on('data', forwardData)
  source.on('end', forwardEnd)
  source.on('error', forwardError)

  return {
    stream: proxy,
    write(data: string) {
      proxy.write(data)
    },
    dispose() {
      source.off('data', forwardData)
      source.off('end', forwardEnd)
      source.off('error', forwardError)
      proxy.end()
      proxy.destroy()
    },
  }
}

function createMirroredOutput(
  source: NodeJS.WriteStream,
  sessionId?: string,
): MirroredOutput {
  const proxy = new PassThrough() as PassThrough & NodeJS.WriteStream
  const size = {
    columns: source.columns,
    rows: source.rows,
  }

  proxy.isTTY = source.isTTY
  proxy.getColorDepth = env => source.getColorDepth?.(env) ?? 1
  proxy.hasColors = count => source.hasColors?.(count) ?? false
  proxy.clearLine = (dir, callback) => source.clearLine?.(dir, callback) ?? false
  proxy.clearScreenDown = callback => source.clearScreenDown?.(callback) ?? false
  proxy.cursorTo = (x, y, callback) => source.cursorTo?.(x, y, callback) ?? false
  proxy.moveCursor = (dx, dy, callback) => source.moveCursor?.(dx, dy, callback) ?? false

  Object.defineProperty(proxy, 'columns', {
    configurable: true,
    enumerable: false,
    get: () => size.columns,
  })
  Object.defineProperty(proxy, 'rows', {
    configurable: true,
    enumerable: false,
    get: () => size.rows,
  })
  Object.defineProperty(proxy, 'fd', {
    configurable: true,
    enumerable: false,
    get: () => (source as NodeJS.WriteStream & { fd?: number }).fd,
  })

  const forwardChunk = (chunk: string | Buffer) => {
    source.write(chunk)
    emitRuntimeEvent(
      {
        type: 'output',
        data: typeof chunk === 'string' ? chunk : chunk.toString('utf8'),
      },
      sessionId,
    )
  }
  const forwardError = (error: Error) => {
    emitRuntimeEvent({ type: 'error', message: error.message }, sessionId)
  }

  proxy.on('data', forwardChunk)
  proxy.on('error', forwardError)

  return {
    stream: proxy,
    resize(cols: number, rows: number) {
      size.columns = cols
      size.rows = rows
      proxy.emit('resize')
    },
    dispose() {
      proxy.off('data', forwardChunk)
      proxy.off('error', forwardError)
      proxy.end()
      proxy.destroy()
    },
  }
}

export function createHostMirrorRuntime(
  options: HostMirrorRuntimeOptions = {},
  sessionId?: string,
): HostMirrorRuntime {
  activeRuntime?.dispose()

  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr

  const mirroredInput = createMirroredInput(stdin, sessionId)
  const mirroredStdout = createMirroredOutput(stdout, sessionId)
  const mirroredStderr = createMirroredOutput(stderr, sessionId)

  let closed = false

  const close = (code: number = 0) => {
    if (closed) {
      return
    }

    closed = true
    const resolvedSessionId = sessionId ?? getCurrentHostSession()?.id
    emitRuntimeEvent({ type: 'exit', code }, resolvedSessionId)
    clearRuntimeListeners(resolvedSessionId)
    invalidateHostSession('host-runtime-closed')
  }

  const runtime: ActiveRuntime = {
    sessionId,
    renderOptions: {
      stdin: mirroredInput.stream,
      stdout: mirroredStdout.stream,
      stderr: mirroredStderr.stream,
    },
    writeInput(data: string) {
      if (!closed) {
        mirroredInput.write(data)
      }
    },
    resize(cols: number, rows: number) {
      if (!closed) {
        mirroredStdout.resize(cols, rows)
        mirroredStderr.resize(cols, rows)
      }
    },
    close,
    dispose() {
      close(0)
      mirroredInput.dispose()
      mirroredStdout.dispose()
      mirroredStderr.dispose()
      if (activeRuntime === runtime) {
        activeRuntime = null
      }
    },
  }

  activeRuntime = runtime
  return runtime
}

export function attachHostRuntimeListener(
  sessionId: string,
  listener: HostRuntimeListener,
): () => void {
  let sessionListeners = listeners.get(sessionId)
  if (!sessionListeners) {
    sessionListeners = new Set<HostRuntimeListener>()
    listeners.set(sessionId, sessionListeners)
  }

  sessionListeners.add(listener)

  return () => {
    const currentListeners = listeners.get(sessionId)
    if (!currentListeners) {
      return
    }

    currentListeners.delete(listener)
    if (currentListeners.size === 0) {
      listeners.delete(sessionId)
    }
  }
}

export function closeHostRuntime(sessionId: string): void {
  if (!activeRuntime) {
    return
  }

  if (activeRuntime.sessionId && activeRuntime.sessionId !== sessionId) {
    return
  }

  activeRuntime.dispose()
}

export function resizeHostRuntime(
  sessionId: string,
  cols: number,
  rows: number,
): void {
  if (!activeRuntime) {
    return
  }

  if (activeRuntime.sessionId && activeRuntime.sessionId !== sessionId) {
    return
  }

  activeRuntime.resize(cols, rows)
}

export function writeHostRuntimeInput(
  sessionId: string,
  data: string,
): void {
  if (!activeRuntime) {
    return
  }

  if (activeRuntime.sessionId && activeRuntime.sessionId !== sessionId) {
    return
  }

  activeRuntime.writeInput(data)
}
