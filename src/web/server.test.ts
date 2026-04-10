import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

import {
  clearHostSession,
  registerHostSession,
} from './hostSessionRegistry.ts'

type Session = {
  id: string
  label: string
  source: 'cwd' | 'worktree'
  cwd: string
  status: 'idle' | 'running' | 'closed'
  createdAt: number
}

function createStubService() {
  const sessions: Session[] = [
    {
      id: 'session-1',
      label: 'existing',
      source: 'cwd',
      cwd: 'D:/A01Bosta/openfork/openclaude',
      status: 'idle',
      createdAt: 1,
    },
  ]

  return {
    listSessions() {
      return sessions.map(session => ({ ...session }))
    },
    async createSession(input: { label: string; source: 'cwd' | 'worktree' }) {
      const session: Session = {
        id: 'session-2',
        label: input.label,
        source: input.source,
        cwd: 'D:/A01Bosta/openfork/openclaude',
        status: 'idle',
        createdAt: 2,
      }
      sessions.push(session)
      return { ...session }
    },
    async closeSession(_id: string) {},
  }
}

async function importServer() {
  return import(`./server.ts?ts=${Date.now()}-${Math.random()}`)
}

beforeEach(() => {
  clearHostSession()
})

afterEach(() => {
  clearHostSession()
  mock.restore()
})

test('createRemoteControlApiHandlers exposes session list and create routes', async () => {
  const { createRemoteControlApiHandlers } = await importServer()
  const handlers = createRemoteControlApiHandlers(createStubService())

  const listResponse = await handlers.handleJson('GET', '/api/sessions')
  expect(listResponse).toMatchObject({
    statusCode: 200,
    body: [
      {
        id: 'session-1',
        label: 'existing',
      },
    ],
  })

  const createResponse = await handlers.handleJson('POST', '/api/sessions', {
    label: 'new session',
    source: 'cwd',
  })
  expect(createResponse).toMatchObject({
    statusCode: 200,
    body: {
      id: 'session-2',
      label: 'new session',
      source: 'cwd',
    },
  })
})

test('createRemoteControlApiHandlers closes a session by id', async () => {
  const closedIds: string[] = []
  const { createRemoteControlApiHandlers } = await importServer()
  const handlers = createRemoteControlApiHandlers({
    listSessions: () => [],
    createSession: async () => ({
      id: 'ignored',
      label: 'ignored',
      source: 'cwd',
      cwd: 'D:/repo',
      status: 'idle',
      createdAt: 1,
    }),
    closeSession: async (id: string) => {
      closedIds.push(id)
    },
  })

  const response = await handlers.handleJson(
    'POST',
    '/api/sessions/session-123/close',
  )

  expect(response).toEqual({
    statusCode: 200,
    body: { ok: true },
  })
  expect(closedIds).toEqual(['session-123'])
})

test('createRemoteControlApiHandlers rejects invalid session create input', async () => {
  const { createRemoteControlApiHandlers } = await importServer()
  const handlers = createRemoteControlApiHandlers(createStubService())

  const response = await handlers.handleJson('POST', '/api/sessions', {
    label: '',
    source: 'invalid',
  })

  expect(response).toEqual({
    statusCode: 400,
    body: { error: 'Invalid session payload' },
  })
})

test('createRemoteControlApiHandlers resolves a host session by token', async () => {
  const hostSession = registerHostSession({
    cwd: '/workspace/demo',
    localUrl: 'http://localhost:3080',
    publicUrl: 'https://demo.trycloudflare.com',
  })

  const { createRemoteControlApiHandlers } = await importServer()
  const handlers = createRemoteControlApiHandlers(createStubService())

  const response = await handlers.handleJson(
    'GET',
    `/api/host-session?token=${encodeURIComponent(hostSession.token)}`,
  )

  expect(response).toEqual({
    statusCode: 200,
    body: {
      id: hostSession.id,
      kind: 'host',
      label: hostSession.label,
      cwd: hostSession.cwd,
      token: hostSession.token,
    },
  })
})

test('createRemoteControlApiHandlers rejects an invalid host session token', async () => {
  const { createRemoteControlApiHandlers } = await importServer()
  const handlers = createRemoteControlApiHandlers(createStubService())

  const response = await handlers.handleJson(
    'GET',
    '/api/host-session?token=missing-token',
  )

  expect(response).toEqual({
    statusCode: 404,
    body: { error: 'Host session not found' },
  })
})

test('createWebServer websocket rejects an invalid host token', async () => {
  const { createWebServer } = await importServer()
  const server = createWebServer(0, '127.0.0.1')

  try {
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP server address')
    }

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}`)
    await once(ws, 'open')
    ws.send(JSON.stringify({ type: 'connect', token: 'missing-token' }))

    const [rawMessage] = await once(ws, 'message')
    expect(JSON.parse(rawMessage.toString())).toEqual({
      type: 'error',
      message: 'Host session not found',
    })

    ws.close()
    await once(ws, 'close')
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('session API returns source-tagged sessions and enforces the cap', async () => {
  const sessions = [
    {
      id: '1',
      label: 'root',
      source: 'cwd' as const,
      cwd: 'D:/repo',
      status: 'idle' as const,
      createdAt: 1,
    },
    {
      id: '2',
      label: 'wt1',
      source: 'worktree' as const,
      cwd: 'D:/repo/.claude/worktrees/remote-control-1',
      status: 'idle' as const,
      createdAt: 2,
    },
    {
      id: '3',
      label: 'wt2',
      source: 'worktree' as const,
      cwd: 'D:/repo/.claude/worktrees/remote-control-2',
      status: 'idle' as const,
      createdAt: 3,
    },
  ]

  const { createRemoteControlApiHandlers } = await importServer()
  const handlers = createRemoteControlApiHandlers({
    listSessions: () => sessions,
    createSession: async () => {
      throw new Error('Remote Control supports at most 3 sessions')
    },
    closeSession: async () => {},
  })

  const list = await handlers.handleJson('GET', '/api/sessions')
  expect(list).toMatchObject({ statusCode: 200 })
  expect(list.body).toEqual(sessions)

  const create = await handlers.handleJson('POST', '/api/sessions', {
    source: 'cwd',
    label: 'four',
  })
  expect(create).toEqual({
    statusCode: 409,
    body: { error: 'Remote Control supports at most 3 sessions' },
  })
})

test('createRemoteControlApiHandlers exposes tunnel start stop and status routes', async () => {
  // Mock the tunnel module to ensure deterministic results regardless of test
  // execution order (remoteControlState.test.ts may pollute the module cache).
  let tunnelState: Record<string, unknown> = { status: 'stopped' }
  mock.module('./tunnel.js', () => ({
    startTunnel: async () => {
      tunnelState = {
        status: 'error',
        message: 'cloudflared not found. Place cloudflared.exe in bin/ or install globally.',
      }
      return tunnelState
    },
    stopTunnel: () => {
      tunnelState = { status: 'stopped' }
      return tunnelState
    },
    getTunnelStatus: () => tunnelState,
  }))

  const { createRemoteControlApiHandlers } = await importServer()
  const handlers = createRemoteControlApiHandlers(createStubService())

  const start = await handlers.handleJson('POST', '/api/tunnel/start')
  expect(start).toEqual({
    statusCode: 200,
    body: {
      status: 'error',
      message: 'cloudflared not found. Place cloudflared.exe in bin/ or install globally.',
    },
  })

  const statusAfterStart = await handlers.handleJson('GET', '/api/tunnel/status')
  expect(statusAfterStart).toEqual({
    statusCode: 200,
    body: {
      status: 'error',
      message: 'cloudflared not found. Place cloudflared.exe in bin/ or install globally.',
    },
  })

  const stop = await handlers.handleJson('POST', '/api/tunnel/stop')
  expect(stop).toEqual({
    statusCode: 200,
    body: { status: 'stopped' },
  })

  const statusAfterStop = await handlers.handleJson('GET', '/api/tunnel/status')
  expect(statusAfterStop).toEqual({
    statusCode: 200,
    body: { status: 'stopped' },
  })

  mock.restore()
})

test('createWebServer serves the static index for root requests', async () => {
  const { createWebServer } = await importServer()
  const server = createWebServer(0, '127.0.0.1')

  try {
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP server address')
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const body = await response.text()
    expect(body).toContain('<title>OpenClaude</title>')
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('createWebServer websocket returns error for unknown session_id', async () => {
  const { createWebServer } = await importServer()
  const server = createWebServer(0, '127.0.0.1')

  try {
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP server address')
    }

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}`)
    await once(ws, 'open')
    ws.send(JSON.stringify({ type: 'connect', session_id: 'nonexistent-id' }))

    const [rawMessage] = await once(ws, 'message')
    expect(JSON.parse(rawMessage.toString())).toMatchObject({
      type: 'error',
      message: expect.stringContaining('nonexistent-id'),
    })

    ws.close()
    await once(ws, 'close')
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('createWebServer websocket connects to a host session by token', async () => {
  const hostSession = registerHostSession({
    cwd: '/workspace/demo',
    localUrl: 'http://localhost:3080',
    publicUrl: 'https://demo.trycloudflare.com',
  })
  const writes: Array<[string, string]> = []
  const resizes: Array<[string, number, number]> = []

  mock.module('./hostSessionTransport.js', () => ({
    createHostSessionTransport: (sessionId: string) => ({
      id: sessionId,
      attach: () => () => {},
      writeInput: (data: string) => {
        writes.push([sessionId, data])
      },
      resize: (cols: number, rows: number) => {
        resizes.push([sessionId, cols, rows])
      },
      close: () => {},
    }),
  }))

  const { createWebServer } = await importServer()
  const server = createWebServer(0, '127.0.0.1')

  try {
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP server address')
    }

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}`)
    const connectedMessage = once(ws, 'message')
    await once(ws, 'open')
    ws.send(JSON.stringify({
      type: 'connect',
      token: hostSession.token,
      cols: 120,
      rows: 30,
    }))

    const [connectedRaw] = await connectedMessage
    expect(JSON.parse(connectedRaw.toString())).toEqual({
      type: 'connected',
      session_id: hostSession.id,
      kind: 'host',
    })

    ws.send(JSON.stringify({ type: 'input', data: 'pwd\n' }))
    ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 25 }))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(writes).toContainEqual([hostSession.id, 'pwd\n'])
    expect(resizes).toContainEqual([hostSession.id, 120, 30])
    expect(resizes).toContainEqual([hostSession.id, 100, 25])

    ws.terminate()
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('createWebServer listens on 0.0.0.0 by default', async () => {
  const { createWebServer } = await importServer()
  const serverPrototype = Object.getPrototypeOf(createWebServer(0, '127.0.0.1'))
  const actualListen = serverPrototype.listen
  let capturedHost: string | undefined

  serverPrototype.listen = function (
    this: typeof serverPrototype,
    _port: number,
    host?: string,
  ) {
    capturedHost = host
    return this
  }

  try {
    const server = createWebServer(0)
    server.close()
  } finally {
    serverPrototype.listen = actualListen
  }

  expect(capturedHost).toBe('0.0.0.0')
})

test('tunnel state is a minimal stateful stub', async () => {
  const tunnel = await import(`./tunnel.ts?ts=${Date.now()}-${Math.random()}`)

  expect(tunnel.getTunnelStatus()).toEqual({ status: 'stopped' })
  expect(await tunnel.startTunnel(3080)).toEqual({
    status: 'error',
    message: 'cloudflared not found. Place cloudflared.exe in bin/ or install globally.',
  })
  expect(tunnel.getTunnelStatus()).toEqual({
    status: 'error',
    message: 'cloudflared not found. Place cloudflared.exe in bin/ or install globally.',
  })
  expect(tunnel.stopTunnel()).toEqual({ status: 'stopped' })
  expect(tunnel.getTunnelStatus()).toEqual({ status: 'stopped' })
})
