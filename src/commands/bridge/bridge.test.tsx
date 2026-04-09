import { afterEach, expect, mock, test } from 'bun:test'
import { runWithCwdOverride } from '../../utils/cwd.js'

function mockBridgeMode(enabled: boolean) {
  mock.module('bun:bundle', () => ({
    feature(name: string) {
      return name === 'BRIDGE_MODE' ? enabled : false
    },
  }))
}

afterEach(() => {
  mock.restore()
})

test('built-in command registry includes remote-control as a local JSX command', async () => {
  mockBridgeMode(true)

  const cacheBust = `ts=${Date.now()}-${Math.random()}`
  const { default: bridgeCommand } = await import(`./index.ts?${cacheBust}`)

  expect(bridgeCommand.name).toBe('remote-control')
  expect(bridgeCommand.aliases).toEqual(['rc'])
  expect(bridgeCommand.name).toBe('remote-control')
  expect(bridgeCommand.aliases).toEqual(['rc'])
  expect(bridgeCommand.type).toBe('local-jsx')
  expect(bridgeCommand.description).toBe(
    'Launch or reveal the local remote-control web app',
  )
  expect(bridgeCommand.argumentHint).toBe('')
  expect(bridgeCommand.isEnabled?.()).toBe(true)
  expect(bridgeCommand.isHidden).toBe(false)
})

test('returns the default launcher contract and respects cwd overrides', async () => {
  const cacheBust = `ts=${Date.now()}-${Math.random()}`
  const { clearRemoteControlState } = await import(
    `../../web/remoteControlState.ts?${cacheBust}`
  )

  mock.module('../../web/server.js', () => ({
    ensureRemoteControlServer: mock(async (port: number) => ({
      port,
      localUrl: `http://localhost:${port}`,
    })),
  }))
  mock.module('../../web/tunnel.js', () => ({
    startTunnel: mock(async () => ({
      status: 'error' as const,
      message: 'cloudflared not found. Place cloudflared.exe in bin/ or install globally.',
    })),
  }))

  const { startOrRevealRemoteControl } = await import(
    `../../web/remoteControlLauncher.ts?${cacheBust}`
  )

  clearRemoteControlState()

  const result = await runWithCwdOverride('/workspace/task-2', () =>
    startOrRevealRemoteControl(),
  )

  expect(result).toEqual({
    status: 'running',
    localUrl: 'http://localhost:3080',
    publicUrl: null,
    hostUrl: null,
    hostToken: expect.any(String),
    hostSessionId: expect.stringContaining('host-'),
    port: 3080,
    defaultCwd: '/workspace/task-2',
    maxSessions: 3,
    message: 'cloudflared not found. Place cloudflared.exe in bin/ or install globally.',
  })
})


test('formats already-running startup output with persisted launcher details', async () => {
  const cacheBust = `ts=${Date.now()}-${Math.random()}`
  const { formatRemoteControlStartupMessage } = await import(
    `./bridge.tsx?${cacheBust}`
  )

  expect(
    formatRemoteControlStartupMessage({
      status: 'already-running',
      localUrl: 'http://localhost:3080',
      publicUrl: null,
      hostUrl: null,
      hostToken: 'token-123',
      hostSessionId: 'host-1',
      port: 3080,
      defaultCwd: '/workspace/demo',
      maxSessions: 3,
    }),
  ).toBe(
    [
      'Remote Control already running.',
      'Local URL: http://localhost:3080',
      'Public URL: Tunnel unavailable',
      'Mirror URL: Unavailable',
      'Default directory: /workspace/demo',
      'Sessions max: 3',
    ].join('\n'),
  )
})

 test('formats startup output with a tokenized mirror url', async () => {
  const cacheBust = `ts=${Date.now()}-${Math.random()}`
  const { formatRemoteControlStartupMessage } = await import(
    `./bridge.tsx?${cacheBust}`
  )

  expect(
    formatRemoteControlStartupMessage({
      status: 'running',
      localUrl: 'http://localhost:3080',
      publicUrl: 'https://remote-control-3080.example',
      hostUrl: 'https://remote-control-3080.example/token-123',
      hostToken: 'token-123',
      hostSessionId: 'host-1',
      port: 3080,
      defaultCwd: '/workspace/demo',
      maxSessions: 3,
    }),
  ).toBe(
    [
      'Remote Control running.',
      'Local URL: http://localhost:3080',
      'Public URL: https://remote-control-3080.example',
      'Mirror URL: https://remote-control-3080.example/token-123',
      'Default directory: /workspace/demo',
      'Sessions max: 3',
    ].join('\n'),
  )
})

test('formats running startup output with local launcher details', async () => {
  const cacheBust = `ts=${Date.now()}-${Math.random()}`
  const { formatRemoteControlStartupMessage } = await import(
    `./bridge.tsx?${cacheBust}`
  )

  expect(
    formatRemoteControlStartupMessage({
      status: 'running',
      localUrl: 'http://localhost:3080',
      publicUrl: null,
      port: 3080,
      defaultCwd: '/workspace/demo',
      maxSessions: 3,
    }),
  ).toBe(
    [
      'Remote Control running.',
      'Local URL: http://localhost:3080',
      'Public URL: Tunnel unavailable',
      'Mirror URL: Unavailable',
      'Default directory: /workspace/demo',
      'Sessions max: 3',
    ].join('\n'),
  )
})

test('formats missing public url as tunnel unavailable', async () => {
  const cacheBust = `ts=${Date.now()}-${Math.random()}`
  const { formatRemoteControlStartupMessage } = await import(
    `./bridge.tsx?${cacheBust}`
  )

  expect(
    formatRemoteControlStartupMessage({
      status: 'starting',
      localUrl: 'http://localhost:3080',
      defaultCwd: '/workspace/demo',
      maxSessions: 3,
    }),
  ).toBe(
    [
      'Remote Control starting.',
      'Local URL: http://localhost:3080',
      'Public URL: Tunnel unavailable',
      'Mirror URL: Unavailable',
      'Default directory: /workspace/demo',
      'Sessions max: 3',
    ].join('\n'),
  )
})

test('formats launcher errors with the required prefix', async () => {
  const cacheBust = `ts=${Date.now()}-${Math.random()}`
  const { formatRemoteControlStartupMessage } = await import(
    `./bridge.tsx?${cacheBust}`
  )

  expect(
    formatRemoteControlStartupMessage({
      status: 'error',
      defaultCwd: '/workspace/demo',
      maxSessions: 3,
      message: 'port 3080 is unavailable',
    }),
  ).toBe('Remote Control error: port 3080 is unavailable')
})
