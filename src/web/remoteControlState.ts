import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from '../utils/config.js'

export type PersistedRemoteControlState = {
  pid: number
  port: number
  localUrl: string
  publicUrl: string | null
}

export async function readRemoteControlState(): Promise<PersistedRemoteControlState | null> {
  const state = getCurrentProjectConfig().remoteControlLocalState
  return state ? { ...state } : null
}

export function writeRemoteControlState(
  state: PersistedRemoteControlState,
): void {
  saveCurrentProjectConfig(current => ({
    ...current,
    remoteControlLocalState: { ...state },
  }))
}

export function clearRemoteControlState(): void {
  saveCurrentProjectConfig(current => {
    if (current.remoteControlLocalState === undefined) {
      return current
    }

    return {
      ...current,
      remoteControlLocalState: undefined,
    }
  })
}
