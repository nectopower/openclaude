import type {
  TerminalTransport,
  TerminalTransportEvent,
} from './terminalTransport.ts'
import {
  attachHostRuntimeListener,
  closeHostRuntime,
  resizeHostRuntime,
  writeHostRuntimeInput,
} from './hostMirrorRuntime.js'

type HostRuntimeEvent =
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string }

class HostSessionTransport implements TerminalTransport {
  readonly id: string

  private readonly listeners = new Set<(event: TerminalTransportEvent) => void>()
  private readonly detachRuntimeListener: () => void
  private closed = false

  constructor(sessionId: string) {
    this.id = sessionId
    this.detachRuntimeListener = attachHostRuntimeListener(
      sessionId,
      event => this.handleRuntimeEvent(event),
    )
  }

  attach(listener: (event: TerminalTransportEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  writeInput(data: string): void {
    if (!this.closed) {
      writeHostRuntimeInput(this.id, data)
    }
  }

  resize(cols: number, rows: number): void {
    if (!this.closed) {
      resizeHostRuntime(this.id, cols, rows)
    }
  }

  close(): void {
    if (this.closed) {
      return
    }

    this.closed = true
    this.detachRuntimeListener()
    closeHostRuntime(this.id)
  }

  private handleRuntimeEvent(event: HostRuntimeEvent): void {
    if (event.type === 'exit') {
      this.closed = true
    }

    this.emit(event)
  }

  private emit(event: TerminalTransportEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}

export function createHostSessionTransport(sessionId: string): TerminalTransport {
  return new HostSessionTransport(sessionId)
}
