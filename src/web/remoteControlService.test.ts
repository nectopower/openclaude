import { afterEach, expect, mock, test } from 'bun:test'

afterEach(() => {
  mock.restore()
})

async function importRemoteControlService() {
  return import(`./remoteControlService.ts?ts=${Date.now()}-${Math.random()}`)
}

test('rejects creating a fourth remote session', async () => {
  const { createRemoteControlService } = await importRemoteControlService()
  const service = createRemoteControlService({
    defaultCwd: 'D:/A01Bosta/openfork/openclaude',
    maxSessions: 3,
  })

  await service.createSession({ source: 'cwd', label: 'one' })
  await service.createSession({ source: 'cwd', label: 'two' })
  await service.createSession({ source: 'cwd', label: 'three' })

  await expect(
    service.createSession({ source: 'cwd', label: 'four' }),
  ).rejects.toThrow('Remote Control supports at most 3 sessions')
})

test('rejects a fourth worktree session while three creations are in flight', async () => {
  const pendingResolvers: Array<
    (value: {
      worktreePath: string
      worktreeBranch?: string
      gitRoot?: string
      hookBased?: boolean
    }) => void
  > = []
  const createAgentWorktree = mock((_slug: string) => {
    return new Promise<{
      worktreePath: string
      worktreeBranch?: string
      gitRoot?: string
      hookBased?: boolean
    }>(resolve => {
      pendingResolvers.push(resolve)
    })
  })

  mock.module('../utils/worktree.js', () => ({ createAgentWorktree }))

  const { createRemoteControlService } = await importRemoteControlService()
  const service = createRemoteControlService({
    defaultCwd: 'D:/A01Bosta/openfork/openclaude',
    maxSessions: 3,
  })

  const one = service.createSession({ source: 'worktree', label: 'one' })
  const two = service.createSession({ source: 'worktree', label: 'two' })
  const three = service.createSession({ source: 'worktree', label: 'three' })

  await Promise.resolve()

  const fourthResult = await Promise.race([
    service
      .createSession({ source: 'worktree', label: 'four' })
      .then(() => 'resolved', error =>
        error instanceof Error ? error.message : String(error),
      ),
    new Promise(resolve => setTimeout(() => resolve('pending'), 0)),
  ])

  expect(fourthResult).toBe('Remote Control supports at most 3 sessions')
  expect(createAgentWorktree.mock.calls.map(([slug]) => slug)).toEqual([
    'remote-control-1',
    'remote-control-2',
    'remote-control-3',
  ])

  pendingResolvers[0]?.({
    worktreePath:
      'D:/A01Bosta/openfork/openclaude/.claude/worktrees/remote-control-1',
    worktreeBranch: 'worktree-remote-control-1',
    gitRoot: 'D:/A01Bosta/openfork/openclaude',
    hookBased: false,
  })
  pendingResolvers[1]?.({
    worktreePath:
      'D:/A01Bosta/openfork/openclaude/.claude/worktrees/remote-control-2',
    worktreeBranch: 'worktree-remote-control-2',
    gitRoot: 'D:/A01Bosta/openfork/openclaude',
    hookBased: false,
  })
  pendingResolvers[2]?.({
    worktreePath:
      'D:/A01Bosta/openfork/openclaude/.claude/worktrees/remote-control-3',
    worktreeBranch: 'worktree-remote-control-3',
    gitRoot: 'D:/A01Bosta/openfork/openclaude',
    hookBased: false,
  })

  await Promise.all([one, two, three])
})

test('creates a worktree-backed session via createAgentWorktree', async () => {
  const createAgentWorktree = mock(async (slug: string) => ({
    worktreePath: `D:/A01Bosta/openfork/openclaude/.claude/worktrees/${slug}`,
    worktreeBranch: `worktree-${slug}`,
    gitRoot: 'D:/A01Bosta/openfork/openclaude',
    hookBased: false,
  }))

  mock.module('../utils/worktree.js', () => ({
    createAgentWorktree,
    removeAgentWorktree: mock(async () => true),
  }))

  const { createRemoteControlService } = await importRemoteControlService()
  const service = createRemoteControlService({
    defaultCwd: 'D:/A01Bosta/openfork/openclaude',
    maxSessions: 3,
  })

  const session = await service.createSession({ source: 'worktree', label: 'one' })

  expect(createAgentWorktree.mock.calls).toEqual([['remote-control-1']])
  expect(session).toMatchObject({
    label: 'one',
    source: 'worktree',
    cwd: 'D:/A01Bosta/openfork/openclaude/.claude/worktrees/remote-control-1',
    worktreePath:
      'D:/A01Bosta/openfork/openclaude/.claude/worktrees/remote-control-1',
    worktreeBranch: 'worktree-remote-control-1',
    gitRoot: 'D:/A01Bosta/openfork/openclaude',
    hookBased: false,
    status: 'idle',
  })
})

test('closeSession removes a worktree session and frees a slot', async () => {
  const createAgentWorktree = mock(async (slug: string) => ({
    worktreePath: `D:/A01Bosta/openfork/openclaude/.claude/worktrees/${slug}`,
    worktreeBranch: `worktree-${slug}`,
    gitRoot: 'D:/A01Bosta/openfork/openclaude',
    hookBased: false,
  }))
  const removeAgentWorktree = mock(async () => true)

  mock.module('../utils/worktree.js', () => ({
    createAgentWorktree,
    removeAgentWorktree,
  }))

  const { createRemoteControlService } = await importRemoteControlService()
  const service = createRemoteControlService({
    defaultCwd: 'D:/A01Bosta/openfork/openclaude',
    maxSessions: 1,
  })

  const session = await service.createSession({ source: 'worktree', label: 'one' })

  await service.closeSession(session.id)

  expect(removeAgentWorktree.mock.calls).toEqual([
    [
      'D:/A01Bosta/openfork/openclaude/.claude/worktrees/remote-control-1',
      'worktree-remote-control-1',
      'D:/A01Bosta/openfork/openclaude',
      false,
    ],
  ])
  expect(service.listSessions()).toEqual([])

  const replacement = await service.createSession({ source: 'cwd', label: 'two' })

  expect(replacement.label).toBe('two')
})

test('closeSession keeps the session when worktree cleanup fails', async () => {
  const createAgentWorktree = mock(async (slug: string) => ({
    worktreePath: `D:/A01Bosta/openfork/openclaude/.claude/worktrees/${slug}`,
    worktreeBranch: `worktree-${slug}`,
    gitRoot: 'D:/A01Bosta/openfork/openclaude',
    hookBased: false,
  }))
  const removeAgentWorktree = mock(async () => false)

  mock.module('../utils/worktree.js', () => ({
    createAgentWorktree,
    removeAgentWorktree,
  }))

  const { createRemoteControlService } = await importRemoteControlService()
  const service = createRemoteControlService({
    defaultCwd: 'D:/A01Bosta/openfork/openclaude',
    maxSessions: 1,
  })

  const session = await service.createSession({ source: 'worktree', label: 'one' })

  await expect(service.closeSession(session.id)).rejects.toThrow(
    'Failed to remove remote-control worktree session',
  )
  expect(service.listSessions()).toHaveLength(1)
})

test('closeSession ignores a missing session id', async () => {
  const { createRemoteControlService } = await importRemoteControlService()
  const service = createRemoteControlService({
    defaultCwd: 'D:/A01Bosta/openfork/openclaude',
    maxSessions: 1,
  })

  await expect(service.closeSession('missing')).resolves.toBeUndefined()
})

test('listSessions returns copies of the stored sessions', async () => {
  const { createRemoteControlService } = await importRemoteControlService()
  const service = createRemoteControlService({
    defaultCwd: 'D:/A01Bosta/openfork/openclaude',
    maxSessions: 3,
  })

  await service.createSession({ source: 'cwd', label: 'one' })

  const listedSessions = service.listSessions()
  listedSessions[0]!.label = 'mutated'

  expect(service.listSessions()[0]?.label).toBe('one')
})
