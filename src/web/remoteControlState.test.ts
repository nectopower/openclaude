import { afterEach, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { runWithCwdOverride } from '../utils/cwd.js'
import {
  clearRemoteControlState,
  readRemoteControlState,
  writeRemoteControlState,
} from './remoteControlState.js'

const originalWebPort = process.env.WEB_PORT
const originalCloudflaredDownloadUrl = process.env.CLOUDFLARED_DOWNLOAD_URL
const originalFetch = globalThis.fetch

async function importRemoteControlLauncher() {
  return import(`./remoteControlLauncher.ts?ts=${Date.now()}-${Math.random()}`)
}

async function importTunnelModule() {
  return import(`./tunnel.ts?ts=${Date.now()}-${Math.random()}`)
}

afterEach(() => {
  mock.restore()
  clearRemoteControlState()
  globalThis.fetch = originalFetch

  if (originalWebPort === undefined) {
    delete process.env.WEB_PORT
  } else {
    process.env.WEB_PORT = originalWebPort
  }

  if (originalCloudflaredDownloadUrl === undefined) {
    delete process.env.CLOUDFLARED_DOWNLOAD_URL
  } else {
    process.env.CLOUDFLARED_DOWNLOAD_URL = originalCloudflaredDownloadUrl
  }
})

test('startTunnel provisions cloudflared when the local binary is missing', async () => {
  const downloadedBytes = new Uint8Array([1, 2, 3, 4])
  const writeFileSync = mock(() => undefined)
  const mkdirSync = mock(() => undefined)
  const chmodSync = mock(() => undefined)
  const existsSync = mock((targetPath: string) => !targetPath.includes('cloudflared'))
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof mock>
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = mock(() => true)

  const spawn = mock((command: string, args: string[]) => {
    queueMicrotask(() => {
      child.stderr.emit(
        'data',
        'INF +------------------------------------------------------------+\n' +
          'INF |  https://demo.trycloudflare.com                        |\n',
      )
    })

    return Object.assign(child, {
      command,
      args,
      once: child.once.bind(child),
      on: child.on.bind(child),
      removeListener: child.removeListener.bind(child),
    })
  })

  globalThis.fetch = mock(async (input: string | URL | Request) => ({
    ok: true,
    url: typeof input === 'string' ? input : input.toString(),
    arrayBuffer: async () => downloadedBytes.buffer,
  })) as typeof fetch

  process.env.CLOUDFLARED_DOWNLOAD_URL =
    'https://downloads.example/cloudflared.exe'

  mock.module('node:fs', () => ({
    chmodSync,
    existsSync,
    mkdirSync,
    writeFileSync,
  }))
  mock.module('node:child_process', () => ({ spawn }))
  mock.module('../utils/which.js', () => ({ which: mock(async () => null) }))

  const tunnel = await importTunnelModule()
  const result = await tunnel.startTunnel(3080)

  expect(result).toEqual({
    status: 'running',
    url: 'https://demo.trycloudflare.com',
  })
  expect(globalThis.fetch).toHaveBeenCalledWith(
    'https://downloads.example/cloudflared.exe',
  )
  expect(mkdirSync).toHaveBeenCalledWith(expect.stringContaining(`${path.sep}bin`), {
    recursive: true,
  })
  expect(writeFileSync).toHaveBeenCalledWith(
    expect.stringMatching(new RegExp(`cloudflared(?:\\.exe)?$`)),
    Buffer.from(downloadedBytes),
  )
  expect(spawn).toHaveBeenCalledWith(
    expect.stringMatching(new RegExp(`cloudflared(?:\\.exe)?$`)),
    ['tunnel', '--url', 'http://127.0.0.1:3080', '--no-autoupdate'],
    expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
  )
})

test('reads a healthy persisted remote control state from project config', async () => {
  const state = {
    pid: 4242,
    port: 3080,
    localUrl: 'http://localhost:3080',
    publicUrl: 'https://remote-control.example',
  }

  writeRemoteControlState(state)

  await expect(readRemoteControlState()).resolves.toEqual(state)
})

test('returns already-running launcher details from persisted state', async () => {
  writeRemoteControlState({
    pid: 4242,
    port: 3080,
    localUrl: 'http://localhost:3080',
    publicUrl: null,
  })

  mock.module('./hostSessionRegistry.js', () => ({
    getCurrentHostSession: mock(() => ({
      id: 'host-1',
      kind: 'host' as const,
      label: 'Live CLI',
      cwd: '/workspace/task-3',
      token: 'token-123',
      localUrl: 'http://localhost:3080',
      publicUrl: null,
      createdAt: 1,
      isAlive: true,
    })),
    registerHostSession: mock(() => {
      throw new Error('should not register')
    }),
    invalidateHostSession: mock(() => undefined),
    clearHostSession: mock(() => undefined),
    resolveHostSessionByToken: mock(() => null),
  }))

  globalThis.fetch = mock(async () => ({ ok: true })) as typeof fetch

  const { startOrRevealRemoteControl } = await importRemoteControlLauncher()
  const result = await runWithCwdOverride('/workspace/task-3', () =>
    startOrRevealRemoteControl(),
  )

  expect(result).toEqual({
    status: 'already-running',
    localUrl: 'http://localhost:3080',
    publicUrl: null,
    hostUrl: null,
    hostToken: 'token-123',
    hostSessionId: 'host-1',
    port: 3080,
    defaultCwd: '/workspace/task-3',
    maxSessions: 3,
  })
})

 test('returns a tokenized host URL for the live CLI after successful startup', async () => {
  process.env.WEB_PORT = '4310'

  const ensureRemoteControlServer = mock(async (port: number, host: string) => ({
    port,
    localUrl: `http://localhost:${port}`,
  }))
  const startTunnel = mock(async (port: number) => ({
    status: 'running' as const,
    url: `https://remote-control-${port}.example`,
  }))
  const getCurrentHostSession = mock(() => null)
  const registerHostSession = mock(() => ({
    id: 'host-1',
    kind: 'host' as const,
    label: 'Live CLI',
    cwd: '/workspace/task-6',
    token: 'token-123',
    localUrl: 'http://localhost:4310',
    publicUrl: 'https://remote-control-4310.example',
    createdAt: 1,
    isAlive: true,
  }))

  mock.module('./server.js', () => ({ ensureRemoteControlServer }))
  mock.module('./tunnel.js', () => ({ startTunnel }))
  mock.module('./hostSessionRegistry.js', () => ({
    getCurrentHostSession,
    registerHostSession,
    invalidateHostSession: mock(() => undefined),
    clearHostSession: mock(() => undefined),
    resolveHostSessionByToken: mock(() => null),
  }))

  const { startOrRevealRemoteControl } = await importRemoteControlLauncher()
  const result = await runWithCwdOverride('/workspace/task-6', () =>
    startOrRevealRemoteControl(),
  )

  expect(result).toEqual({
    status: 'running',
    localUrl: 'http://localhost:4310',
    publicUrl: 'https://remote-control-4310.example',
    hostUrl: 'https://remote-control-4310.example/token-123',
    hostToken: 'token-123',
    hostSessionId: 'host-1',
    port: 4310,
    defaultCwd: '/workspace/task-6',
    maxSessions: 3,
  })
  expect(getCurrentHostSession.mock.calls).toEqual([[]])
  expect(registerHostSession.mock.calls).toEqual([
    [{
      cwd: '/workspace/task-6',
      localUrl: 'http://localhost:4310',
      publicUrl: 'https://remote-control-4310.example',
    }],
  ])
})

 test('reuses the current host session when the launcher starts successfully', async () => {
  const ensureRemoteControlServer = mock(async () => ({
    port: 3080,
    localUrl: 'http://localhost:3080',
  }))
  const startTunnel = mock(async () => ({
    status: 'running' as const,
    url: 'https://remote-control-3080.example',
  }))
  const getCurrentHostSession = mock(() => ({
    id: 'host-9',
    kind: 'host' as const,
    label: 'Live CLI',
    cwd: process.cwd(),
    token: 'token-live',
    localUrl: 'http://localhost:3080',
    publicUrl: 'https://remote-control-3080.example',
    createdAt: 1,
    isAlive: true,
  }))
  const registerHostSession = mock(() => {
    throw new Error('should not register')
  })

  mock.module('./server.js', () => ({ ensureRemoteControlServer }))
  mock.module('./tunnel.js', () => ({ startTunnel }))
  mock.module('./hostSessionRegistry.js', () => ({
    getCurrentHostSession,
    registerHostSession,
    invalidateHostSession: mock(() => undefined),
    clearHostSession: mock(() => undefined),
    resolveHostSessionByToken: mock(() => null),
  }))

  const { startOrRevealRemoteControl } = await importRemoteControlLauncher()
  const result = await startOrRevealRemoteControl()

  expect(result.hostUrl).toBe('https://remote-control-3080.example/token-live')
  expect(result.hostToken).toBe('token-live')
  expect(result.hostSessionId).toBe('host-9')
  expect(registerHostSession.mock.calls).toEqual([])
})

 test('refreshes the host session when startup metadata changes', async () => {
  const ensureRemoteControlServer = mock(async () => ({
    port: 3080,
    localUrl: 'http://localhost:3080',
  }))
  const startTunnel = mock(async () => ({
    status: 'running' as const,
    url: 'https://remote-control-3080.example',
  }))
  const getCurrentHostSession = mock(() => ({
    id: 'host-stale',
    kind: 'host' as const,
    label: 'Live CLI',
    cwd: '/workspace/old',
    token: 'old-token',
    localUrl: 'http://localhost:9999',
    publicUrl: 'https://old.example',
    createdAt: 1,
    isAlive: true,
  }))
  const registerHostSession = mock(() => ({
    id: 'host-fresh',
    kind: 'host' as const,
    label: 'Live CLI',
    cwd: process.cwd(),
    token: 'fresh-token',
    localUrl: 'http://localhost:3080',
    publicUrl: 'https://remote-control-3080.example',
    createdAt: 2,
    isAlive: true,
  }))

  mock.module('./server.js', () => ({ ensureRemoteControlServer }))
  mock.module('./tunnel.js', () => ({ startTunnel }))
  mock.module('./hostSessionRegistry.js', () => ({
    getCurrentHostSession,
    registerHostSession,
    invalidateHostSession: mock(() => undefined),
    clearHostSession: mock(() => undefined),
    resolveHostSessionByToken: mock(() => null),
  }))

  const { startOrRevealRemoteControl } = await importRemoteControlLauncher()
  const result = await startOrRevealRemoteControl()

  expect(result.hostUrl).toBe('https://remote-control-3080.example/fresh-token')
  expect(result.hostToken).toBe('fresh-token')
  expect(result.hostSessionId).toBe('host-fresh')
  expect(registerHostSession.mock.calls).toEqual([
    [{
      cwd: process.cwd(),
      localUrl: 'http://localhost:3080',
      publicUrl: 'https://remote-control-3080.example',
    }],
  ])
})

 test('does not persist host token metadata in remote control state', async () => {
  writeRemoteControlState({
    pid: 4242,
    port: 3080,
    localUrl: 'http://localhost:3080',
    publicUrl: 'https://remote-control.example',
  })

  await expect(readRemoteControlState()).resolves.toEqual({
    pid: 4242,
    port: 3080,
    localUrl: 'http://localhost:3080',
    publicUrl: 'https://remote-control.example',
  })
})

test('writes healthy remote control state after successful startup', async () => {
  process.env.WEB_PORT = '4310'

  const ensureRemoteControlServer = mock(async (port: number, host: string) => ({
    port,
    localUrl: `http://localhost:${port}`,
  }))
  const startTunnel = mock(async (port: number) => ({
    status: 'running' as const,
    url: `https://remote-control-${port}.example`,
  }))

  mock.module('./server.js', () => ({
    ensureRemoteControlServer,
  }))
  mock.module('./tunnel.js', () => ({
    startTunnel,
  }))

  const { startOrRevealRemoteControl } = await importRemoteControlLauncher()
  const result = await runWithCwdOverride('/workspace/task-6', () =>
    startOrRevealRemoteControl(),
  )

  expect(ensureRemoteControlServer.mock.calls).toEqual([[4310, '127.0.0.1']])
  expect(startTunnel.mock.calls).toEqual([[4310]])
  expect(result).toEqual({
    status: 'running',
    localUrl: 'http://localhost:4310',
    publicUrl: 'https://remote-control-4310.example',
    hostUrl: expect.stringContaining('https://remote-control-4310.example/'),
    hostToken: expect.any(String),
    hostSessionId: expect.stringContaining('host-'),
    port: 4310,
    defaultCwd: '/workspace/task-6',
    maxSessions: 3,
  })
  await expect(readRemoteControlState()).resolves.toEqual({
    pid: process.pid,
    port: 4310,
    localUrl: 'http://localhost:4310',
    publicUrl: 'https://remote-control-4310.example',
  })
})

test('ignores stale persisted state and relaunches the local service', async () => {
  writeRemoteControlState({
    pid: 4242,
    port: 3080,
    localUrl: 'http://localhost:3080',
    publicUrl: 'https://stale.example',
  })

  globalThis.fetch = mock(async () => {
    throw new Error('connect ECONNREFUSED')
  }) as typeof fetch

  const ensureRemoteControlServer = mock(async (port: number, host: string) => ({
    port,
    localUrl: `http://localhost:${port}`,
  }))
  const startTunnel = mock(async () => ({
    status: 'error' as const,
    message: 'tunnel unavailable',
  }))

  mock.module('./server.js', () => ({
    ensureRemoteControlServer,
  }))
  mock.module('./tunnel.js', () => ({
    startTunnel,
  }))

  const { startOrRevealRemoteControl } = await importRemoteControlLauncher()
  const result = await startOrRevealRemoteControl()

  expect(ensureRemoteControlServer.mock.calls).toEqual([[3080, '127.0.0.1']])
  expect(result).toEqual({
    status: 'running',
    localUrl: 'http://localhost:3080',
    publicUrl: null,
    hostUrl: null,
    hostToken: expect.any(String),
    hostSessionId: expect.stringContaining('host-'),
    port: 3080,
    defaultCwd: process.cwd(),
    maxSessions: 3,
    message: 'tunnel unavailable',
  })
  await expect(readRemoteControlState()).resolves.toEqual({
    pid: process.pid,
    port: 3080,
    localUrl: 'http://localhost:3080',
    publicUrl: null,
  })
})

test('returns error status when local server startup fails', async () => {
  mock.module('./server.js', () => ({
    ensureRemoteControlServer: mock(async () => {
      throw new Error('port 3080 is unavailable')
    }),
  }))
  mock.module('./tunnel.js', () => ({
    startTunnel: mock(async () => ({
      status: 'running' as const,
      url: 'https://unused.example',
    })),
  }))

  const { startOrRevealRemoteControl } = await importRemoteControlLauncher()
  const result = await startOrRevealRemoteControl()

  expect(result).toEqual({
    status: 'error',
    defaultCwd: process.cwd(),
    maxSessions: 3,
    message: 'port 3080 is unavailable',
  })
})


test('clears persisted remote control state', async () => {
  writeRemoteControlState({
    pid: 4242,
    port: 3080,
    localUrl: 'http://localhost:3080',
    publicUrl: null,
  })

  clearRemoteControlState()

  await expect(readRemoteControlState()).resolves.toBeNull()
})
