import { getCwd } from '../utils/cwd.js'
import { randomUUID } from '../utils/crypto.js'
import { createAgentWorktree, removeAgentWorktree } from '../utils/worktree.js'
import type {
  CreateRemoteControlSessionInput,
  RemoteControlSession,
} from './remoteControlTypes.js'

function cloneSession(session: RemoteControlSession): RemoteControlSession {
  return { ...session }
}

export function createRemoteControlService(options?: {
  defaultCwd?: string
  maxSessions?: number
}) {
  const defaultCwd = options?.defaultCwd ?? getCwd()
  const maxSessions = options?.maxSessions ?? 3
  const sessions = new Map<string, RemoteControlSession>()

  return {
    listSessions(): RemoteControlSession[] {
      return Array.from(sessions.values(), cloneSession)
    },

    async createSession(
      input: CreateRemoteControlSessionInput,
    ): Promise<RemoteControlSession> {
      if (sessions.size >= maxSessions) {
        throw new Error(
          `Remote Control supports at most ${maxSessions} sessions`,
        )
      }

      const createdAt = Date.now()
      const id = randomUUID()
      const session: RemoteControlSession = {
        id,
        label: input.label,
        source: input.source,
        cwd: input.cwd || defaultCwd,
        status: 'idle',
        createdAt,
      }

      sessions.set(id, session)

      try {
        if (input.source === 'worktree') {
          const worktree = await createAgentWorktree(
            `remote-control-${id.slice(0, 8)}`,
          )

          session.cwd = worktree.worktreePath
          session.worktreePath = worktree.worktreePath
          session.worktreeBranch = worktree.worktreeBranch
          session.gitRoot = worktree.gitRoot
          session.hookBased = worktree.hookBased
        }

        return cloneSession(session)
      } catch (error) {
        sessions.delete(id)
        throw error
      }
    },

    async closeSession(id: string): Promise<void> {
      const session = sessions.get(id)
      if (!session) {
        return
      }

      if (session.source === 'worktree' && session.worktreePath) {
        const removed = await removeAgentWorktree(
          session.worktreePath,
          session.worktreeBranch,
          session.gitRoot,
          session.hookBased,
        )

        if (!removed) {
          throw new Error('Failed to remove remote-control worktree session')
        }
      }

      sessions.delete(id)
    },
  }
}
