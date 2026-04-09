import type React from 'react'
import type { ToolUseContext } from '../../Tool.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import {
  startOrRevealRemoteControl,
} from '../../web/remoteControlLauncher.js'
import type {
  RemoteControlStartupResult,
  RemoteControlStartupStatus,
} from '../../web/remoteControlTypes.js'

const REMOTE_CONTROL_STATUS_MESSAGES = {
  starting: 'Remote Control starting.',
  running: 'Remote Control running.',
  'already-running': 'Remote Control already running.',
} as const satisfies Record<
  Exclude<RemoteControlStartupStatus, 'error'>,
  string
>

function formatRemoteControlError(message?: string): string {
  return `Remote Control error: ${message?.trim() || 'Unknown error'}`
}

export function formatRemoteControlStartupMessage(
  result: RemoteControlStartupResult,
): string {
  if (result.status === 'error') {
    return formatRemoteControlError(result.message)
  }

  return [
    REMOTE_CONTROL_STATUS_MESSAGES[result.status],
    `Local URL: ${result.localUrl ?? 'Unavailable'}`,
    `Public URL: ${result.publicUrl ?? 'Tunnel unavailable'}`,
    `Mirror URL: ${result.hostUrl ?? 'Unavailable'}`,
    `Default directory: ${result.defaultCwd}`,
    `Sessions max: ${result.maxSessions}`,
  ].join('\n')
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return String(error)
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: ToolUseContext & LocalJSXCommandContext,
  _args: string,
): Promise<React.ReactNode> {
  try {
    const result = await startOrRevealRemoteControl()
    onDone(formatRemoteControlStartupMessage(result), {
      display: 'system',
    })
  } catch (error) {
    onDone(formatRemoteControlError(getErrorMessage(error)), {
      display: 'system',
    })
  }

  return null
}
