import { getCwd } from '../utils/cwd.js'
import {
  clearRemoteControlState,
  readRemoteControlState,
  writeRemoteControlState,
} from './remoteControlState.js'
import {
  getCurrentHostSession,
  registerHostSession,
} from './hostSessionRegistry.js'
import { ensureRemoteControlServer } from './server.js'
import { startTunnel } from './tunnel.js'
import type { RemoteControlStartupResult } from './remoteControlTypes.js'

const DEFAULT_REMOTE_CONTROL_PORT = 3080
const DEFAULT_REMOTE_CONTROL_MAX_SESSIONS = 3

function getRemoteControlPort(): number {
  const port = Number.parseInt(process.env.WEB_PORT ?? '', 10)
  return Number.isFinite(port) ? port : DEFAULT_REMOTE_CONTROL_PORT
}

async function isHealthyRemoteControlState(localUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${localUrl}/api/health`)
    return response.ok
  } catch {
    return false
  }
}

function buildHostUrl(
  publicUrl: string | null | undefined,
  token: string,
): string | null {
  if (!publicUrl) {
    return null
  }

  return `${publicUrl.replace(/\/$/, '')}/${token}`
}

function createStartupError(
  defaultCwd: string,
  message: string,
): RemoteControlStartupResult {
  return {
    status: 'error',
    defaultCwd,
    maxSessions: DEFAULT_REMOTE_CONTROL_MAX_SESSIONS,
    message,
  }
}

export async function startOrRevealRemoteControl(): Promise<RemoteControlStartupResult> {
  const defaultCwd = getCwd()
  const persistedState = await readRemoteControlState()

  if (persistedState) {
    if (await isHealthyRemoteControlState(persistedState.localUrl)) {
      const hostSession = getCurrentHostSession()
      return {
        status: 'already-running',
        localUrl: persistedState.localUrl,
        publicUrl: persistedState.publicUrl,
        hostUrl: hostSession
          ? buildHostUrl(persistedState.publicUrl, hostSession.token)
          : null,
        hostToken: hostSession?.token,
        hostSessionId: hostSession?.id,
        port: persistedState.port,
        defaultCwd,
        maxSessions: DEFAULT_REMOTE_CONTROL_MAX_SESSIONS,
      }
    }

    clearRemoteControlState()
  }

  try {
    const requestedPort = getRemoteControlPort()
    const { port, localUrl } = await ensureRemoteControlServer(
      requestedPort,
      '127.0.0.1',
    )
    const tunnelResult = await startTunnel(port)
    const publicUrl =
      tunnelResult.status === 'running' ? tunnelResult.url ?? null : null

    const existingHostSession = getCurrentHostSession()
    const hostSession = existingHostSession &&
      existingHostSession.cwd === defaultCwd &&
      existingHostSession.localUrl === localUrl &&
      existingHostSession.publicUrl === publicUrl
      ? existingHostSession
      : registerHostSession({
          cwd: defaultCwd,
          localUrl,
          publicUrl,
        })

    writeRemoteControlState({
      pid: process.pid,
      port,
      localUrl,
      publicUrl,
    })

    return {
      status: 'running',
      localUrl,
      publicUrl,
      hostUrl: buildHostUrl(publicUrl, hostSession.token),
      hostToken: hostSession.token,
      hostSessionId: hostSession.id,
      port,
      defaultCwd,
      maxSessions: DEFAULT_REMOTE_CONTROL_MAX_SESSIONS,
      message:
        tunnelResult.status === 'error' ? tunnelResult.message : undefined,
    }
  } catch (error) {
    return createStartupError(
      defaultCwd,
      error instanceof Error ? error.message : String(error),
    )
  }
}

export { isHealthyRemoteControlState }
