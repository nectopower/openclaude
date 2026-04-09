import { type ChildProcess, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { which } from '../utils/which.js'

type TunnelState =
  | { status: 'stopped' }
  | {
      status: 'error'
      message: string
    }
  | {
      status: 'running'
      url?: string
    }

const CLOUD_FLARED_MISSING_MESSAGE =
  'cloudflared not found. Place cloudflared.exe in bin/ or install globally.'
const CLOUDFLARED_START_TIMEOUT_MS = 15000
const CLOUDFLARED_BINARY_NAME =
  process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
const CLOUDFLARED_LOCAL_PATH = path.join(
  process.cwd(),
  'bin',
  CLOUDFLARED_BINARY_NAME,
)

let tunnelState: TunnelState = { status: 'stopped' }
let tunnelProcess: ChildProcess | null = null

function getCloudflaredDownloadUrl(): string | null {
  if (process.env.CLOUDFLARED_DOWNLOAD_URL) {
    return process.env.CLOUDFLARED_DOWNLOAD_URL
  }

  if (process.env.NODE_ENV === 'test') {
    return null
  }

  if (process.platform === 'win32') {
    return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
  }

  return null
}

async function ensureCloudflaredBinary(): Promise<string | null> {
  if (existsSync(CLOUDFLARED_LOCAL_PATH)) {
    return CLOUDFLARED_LOCAL_PATH
  }

  const globalBinary = await which('cloudflared')
  if (globalBinary) {
    return globalBinary
  }

  const downloadUrl = getCloudflaredDownloadUrl()
  if (!downloadUrl) {
    return null
  }

  const response = await fetch(downloadUrl)
  if (!response.ok) {
    throw new Error(`Failed to download cloudflared from ${downloadUrl}`)
  }

  mkdirSync(path.dirname(CLOUDFLARED_LOCAL_PATH), { recursive: true })
  writeFileSync(
    CLOUDFLARED_LOCAL_PATH,
    Buffer.from(await response.arrayBuffer()),
  )

  if (process.platform !== 'win32') {
    chmodSync(CLOUDFLARED_LOCAL_PATH, 0o755)
  }

  return CLOUDFLARED_LOCAL_PATH
}

function extractTunnelUrl(chunk: string): string | null {
  const match = chunk.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
  return match?.[0] ?? null
}

async function waitForTunnelUrl(
  child: ChildProcess,
  port: number,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      cleanup()
      child.kill()
      reject(
        new Error(`Timed out waiting for cloudflared tunnel on port ${port}`),
      )
    }, CLOUDFLARED_START_TIMEOUT_MS)

    const cleanup = () => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeout)
      child.stdout?.removeListener('data', onData)
      child.stderr?.removeListener('data', onData)
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
    }

    const onData = (chunk: Buffer | string) => {
      const url = extractTunnelUrl(chunk.toString())
      if (!url) {
        return
      }

      cleanup()
      resolve(url)
    }

    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }

    const onExit = (code: number | null) => {
      cleanup()
      reject(
        new Error(
          code === null
            ? 'cloudflared exited before publishing a tunnel URL'
            : `cloudflared exited before publishing a tunnel URL (code ${code})`,
        ),
      )
    }

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

export async function startTunnel(port: number): Promise<TunnelState> {
  if (tunnelState.status === 'running') {
    return tunnelState
  }

  try {
    const binaryPath = await ensureCloudflaredBinary()
    if (!binaryPath) {
      tunnelState = {
        status: 'error',
        message: CLOUD_FLARED_MISSING_MESSAGE,
      }
      return tunnelState
    }

    const child = spawn(
      binaryPath,
      ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )

    const url = await waitForTunnelUrl(child, port)
    tunnelProcess = child
    tunnelState = {
      status: 'running',
      url,
    }

    child.once('exit', () => {
      if (tunnelProcess === child) {
        tunnelProcess = null
        tunnelState = { status: 'stopped' }
      }
    })

    return tunnelState
  } catch (error) {
    tunnelProcess?.kill()
    tunnelProcess = null
    tunnelState = {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    }
    return tunnelState
  }
}

export function stopTunnel(): { status: 'stopped' } {
  tunnelProcess?.kill()
  tunnelProcess = null
  tunnelState = { status: 'stopped' }
  return { status: 'stopped' }
}

export function getTunnelStatus(): TunnelState {
  return tunnelState
}

export { CLOUD_FLARED_MISSING_MESSAGE }
