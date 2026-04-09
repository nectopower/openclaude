export type TerminalTransportEvent =
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string }

export interface TerminalTransport {
  readonly id: string
  attach(listener: (event: TerminalTransportEvent) => void): () => void
  writeInput(data: string): void
  resize(cols: number, rows: number): void
  close(): void
}
