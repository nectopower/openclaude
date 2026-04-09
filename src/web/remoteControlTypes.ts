export type RemoteControlStartupStatus =
  | 'starting'
  | 'running'
  | 'already-running'
  | 'error'

export type RemoteControlSourceType = 'cwd' | 'worktree'

export type RemoteControlSession = {
  id: string
  label: string
  source: RemoteControlSourceType
  cwd: string
  worktreePath?: string
  worktreeBranch?: string
  gitRoot?: string
  hookBased?: boolean
  status: 'idle' | 'running' | 'closed'
  createdAt: number
}

export type CreateRemoteControlSessionInput = {
  source: RemoteControlSourceType
  label: string
  cwd?: string
}

export type RemoteControlSessionKind = 'pty' | 'host'

export type RemoteControlResolvedSession = {
  id: string
  kind: RemoteControlSessionKind
  label: string
  cwd: string
  token?: string
}

export type RemoteControlStartupResult = {
  status: RemoteControlStartupStatus
  localUrl?: string
  publicUrl?: string | null
  hostUrl?: string | null
  hostToken?: string
  hostSessionId?: string
  port?: number
  defaultCwd: string
  maxSessions: number
  message?: string
}
