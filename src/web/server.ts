import fs from 'node:fs'
import http from 'http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { WebSocketServer, WebSocket } from 'ws'

import { createHostSessionTransport } from './hostSessionTransport.js'
import { resolveHostSessionByToken } from './hostSessionRegistry.js'
import { createPtySessionTransport } from './ptySessionTransport.js'
import { createRemoteControlService } from './remoteControlService.js'
import type {
  CreateRemoteControlSessionInput,
  RemoteControlResolvedSession,
} from './remoteControlTypes.js'
import type { TerminalTransport } from './terminalTransport.ts'
import { startTunnel, stopTunnel, getTunnelStatus } from './tunnel.js'

let remoteControlServer: http.Server | null = null
let remoteControlServerState: {
  port: number
  localUrl: string
} | null = null
let serverPort = 3080

const remoteControlService = createRemoteControlService({ maxSessions: 3 })

type RemoteControlApiService = Pick<
  ReturnType<typeof createRemoteControlService>,
  'listSessions' | 'createSession' | 'closeSession'
>

type TransportEntry = {
  kind: RemoteControlResolvedSession['kind']
  transport: TerminalTransport
  clients: Set<WebSocket>
  detachTransport: () => void
}

const activeTransports = new Map<string, TransportEntry>()

function resolvePtySession(sessionId: string): RemoteControlResolvedSession | null {
  const session = remoteControlService.listSessions().find(entry => entry.id === sessionId)
  if (!session) {
    return null
  }

  return {
    id: session.id,
    kind: 'pty',
    label: session.label,
    cwd: session.cwd,
  }
}

function createTransport(
  session: RemoteControlResolvedSession,
  cols: number,
  rows: number,
): TerminalTransport {
  if (session.kind === 'host') {
    return createHostSessionTransport(session.id)
  }

  return createPtySessionTransport(
    {
      id: session.id,
      cwd: session.cwd,
    },
    cols,
    rows,
  )
}

function getOrCreateTransport(
  session: RemoteControlResolvedSession,
  ws: WebSocket,
  cols: number,
  rows: number,
): TransportEntry {
  const existing = activeTransports.get(session.id)
  if (existing) {
    existing.clients.add(ws)
    return existing
  }

  const transport = createTransport(session, cols, rows)
  const entry: TransportEntry = {
    kind: session.kind,
    transport,
    clients: new Set([ws]),
    detachTransport: () => {},
  }

  entry.detachTransport = transport.attach(event => {
    const message = JSON.stringify(event)
    for (const client of entry.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message)
      }
    }

    if (event.type === 'exit') {
      entry.detachTransport()
      activeTransports.delete(session.id)
    }
  })

  activeTransports.set(session.id, entry)
  return entry
}

function detachClient(sessionId: string, ws: WebSocket): void {
  const entry = activeTransports.get(sessionId)
  if (!entry) {
    return
  }

  entry.clients.delete(ws)
  if (entry.clients.size === 0) {
    entry.detachTransport()
    if (entry.kind === 'pty') {
      entry.transport.close()
    }
    activeTransports.delete(sessionId)
  }
}

function detachAllClients(sessionId: string): void {
  const entry = activeTransports.get(sessionId)
  if (!entry) {
    return
  }

  entry.detachTransport()
  entry.transport.close()
  activeTransports.delete(sessionId)
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

function getStaticDir(): string {
  const dirname = path.dirname(fileURLToPath(import.meta.url))
  const webStaticDir = path.resolve(dirname, 'web-static')
  if (fs.existsSync(webStaticDir)) {
    return webStaticDir
  }

  const staticDir = path.resolve(dirname, 'static')
  if (fs.existsSync(staticDir)) {
    return staticDir
  }

  return webStaticDir
}

function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    return false
  }

  const requestUrl = new URL(req.url ?? '/', 'http://localhost')
  let pathname = requestUrl.pathname
  if (pathname === '/') {
    pathname = '/index.html'
  }

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(pathname)
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid path' }))
    return true
  }

  const staticDir = getStaticDir()
  let filePath = path.resolve(staticDir, `.${decodedPath}`)
  if (!filePath.startsWith(staticDir)) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Forbidden' }))
    return true
  }

  if (!fs.existsSync(filePath)) {
    if (path.extname(decodedPath) !== '') {
      return false
    }

    filePath = path.resolve(staticDir, './index.html')
    if (!fs.existsSync(filePath)) {
      return false
    }
  }

  const mimeType = MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream'
  const body = fs.readFileSync(filePath)
  res.writeHead(200, { 'Content-Type': mimeType })
  if (method === 'HEAD') {
    res.end()
  } else {
    res.end(body)
  }
  return true
}

type JsonResponse = {
  statusCode: number
  body: unknown
}

function isCreateSessionInput(
  body: unknown,
): body is CreateRemoteControlSessionInput {
  return !!body &&
    typeof body === 'object' &&
    'label' in body &&
    typeof body.label === 'string' &&
    body.label.length > 0 &&
    'source' in body &&
    (body.source === 'cwd' || body.source === 'worktree')
}

function writeJson(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  if (chunks.length === 0) {
    return undefined
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function createRemoteControlApiHandlers(
  service: RemoteControlApiService = remoteControlService,
) {
  const handleJson = async (
    method: string,
    url: string,
    body?: unknown,
  ): Promise<JsonResponse> => {
    const requestUrl = new URL(url, 'http://localhost')
    const pathname = requestUrl.pathname

    if (method === 'GET' && pathname === '/api/health') {
      return {
        statusCode: 200,
        body: { status: 'ok', cwd: process.cwd() },
      }
    }

    if (method === 'GET' && pathname === '/api/host-session') {
      const token = requestUrl.searchParams.get('token')
      if (!token) {
        return {
          statusCode: 400,
          body: { error: 'Missing host session token' },
        }
      }

      const hostSession = resolveHostSessionByToken(token)
      if (!hostSession) {
        return {
          statusCode: 404,
          body: { error: 'Host session not found' },
        }
      }

      return {
        statusCode: 200,
        body: {
          id: hostSession.id,
          kind: hostSession.kind,
          label: hostSession.label,
          cwd: hostSession.cwd,
          token: hostSession.token,
        },
      }
    }

    if (method === 'GET' && pathname === '/api/browse') {
      const dir = requestUrl.searchParams.get('path') || process.cwd()

      const drives: string[] = []
      if (process.platform === 'win32') {
        for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
          const drive = `${letter}:\\`
          try {
            fs.accessSync(drive)
            drives.push(drive)
          } catch {
          }
        }
      }

      try {
        const resolved = path.resolve(dir)
        const entries = fs.readdirSync(resolved, { withFileTypes: true })
        const dirs = entries
          .filter(entry => {
            try {
              return entry.isDirectory() && !entry.name.startsWith('.')
            } catch {
              return false
            }
          })
          .map(entry => entry.name)
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))

        return {
          statusCode: 200,
          body: {
            path: resolved,
            parent: path.dirname(resolved),
            sep: path.sep,
            drives,
            dirs,
          },
        }
      } catch {
        return {
          statusCode: 400,
          body: { error: `Cannot read directory: ${dir}`, drives },
        }
      }
    }

    if (method === 'POST' && pathname === '/api/tunnel/start') {
      return {
        statusCode: 200,
        body: await startTunnel(serverPort),
      }
    }

    if (method === 'POST' && pathname === '/api/tunnel/stop') {
      return {
        statusCode: 200,
        body: stopTunnel(),
      }
    }

    if (method === 'GET' && pathname === '/api/tunnel/status') {
      return {
        statusCode: 200,
        body: getTunnelStatus(),
      }
    }

    if (method === 'GET' && pathname === '/api/sessions') {
      return {
        statusCode: 200,
        body: service.listSessions(),
      }
    }

    if (method === 'POST' && pathname === '/api/sessions') {
      if (!isCreateSessionInput(body)) {
        return {
          statusCode: 400,
          body: { error: 'Invalid session payload' },
        }
      }

      try {
        const session = await service.createSession(body)

        return {
          statusCode: 200,
          body: session,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          statusCode: 409,
          body: { error: message },
        }
      }
    }

    const closeMatch =
      method === 'POST' ? /^\/api\/sessions\/([^/]+)\/close$/.exec(pathname) : null
    if (closeMatch) {
      try {
        const sessionId = decodeURIComponent(closeMatch[1]!)
        detachAllClients(sessionId)
        await service.closeSession(sessionId)

        return {
          statusCode: 200,
          body: { ok: true },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          statusCode: 409,
          body: { error: message },
        }
      }
    }

    return {
      statusCode: 404,
      body: { error: 'Not found' },
    }
  }

  const handleApi = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<boolean> => {
    const method = req.method ?? 'GET'
    const requestUrl = new URL(req.url ?? '/', 'http://localhost')

    if (!requestUrl.pathname.startsWith('/api/')) {
      return false
    }

    let body: unknown
    if (method !== 'GET' && method !== 'HEAD') {
      try {
        body = await readJsonBody(req)
      } catch {
        writeJson(res, 400, { error: 'Invalid JSON' })
        return true
      }
    }

    const response = await handleJson(method, req.url ?? requestUrl.pathname, body)
    writeJson(res, response.statusCode, response.body)
    return true
  }

  return {
    handleJson,
    handleApi,
  }
}

type WsConnectMessage = {
  type: 'connect'
  token?: string
  session_id?: string
  cols?: number
  rows?: number
}

type WsInputMessage = {
  type: 'input'
  data?: string
}

type WsResizeMessage = {
  type: 'resize'
  cols?: number
  rows?: number
}

type WsClientMessage = WsConnectMessage | WsInputMessage | WsResizeMessage

function parseWsMessage(raw: unknown): WsClientMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(raw))
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
    return null
  }

  const obj = parsed as Record<string, unknown>
  if (obj.type !== 'connect' && obj.type !== 'input' && obj.type !== 'resize') {
    return null
  }

  return obj as WsClientMessage
}

function handleWebSocket(ws: WebSocket): void {
  let sessionId: string | null = null

  ws.on('message', raw => {
    const msg = parseWsMessage(raw)
    if (!msg) {
      return
    }

    if (msg.type === 'connect') {
      if (sessionId) {
        detachClient(sessionId, ws)
      }

      let session: RemoteControlResolvedSession | null = null
      if (typeof msg.token === 'string') {
        session = resolveHostSessionByToken(msg.token)
      } else if (typeof msg.session_id === 'string') {
        session = resolvePtySession(msg.session_id)
      } else {
        return
      }

      if (!session) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: typeof msg.token === 'string'
              ? 'Host session not found'
              : `Unknown session: ${msg.session_id}`,
          }),
        )
        sessionId = null
        return
      }

      sessionId = session.id
      const cols = typeof msg.cols === 'number' ? msg.cols : 220
      const rows = typeof msg.rows === 'number' ? msg.rows : 50

      try {
        const entry = getOrCreateTransport(session, ws, cols, rows)
        entry.transport.resize(cols, rows)
        ws.send(JSON.stringify({
          type: 'connected',
          session_id: sessionId,
          kind: session.kind,
        }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ws.send(JSON.stringify({
          type: 'error',
          message: `${session.kind.toUpperCase()} transport failed: ${message}`,
        }))
        sessionId = null
      }
      return
    }

    if (msg.type === 'input') {
      if (!sessionId) {
        return
      }

      const entry = activeTransports.get(sessionId)
      if (entry && typeof msg.data === 'string') {
        entry.transport.writeInput(msg.data)
      }
      return
    }

    if (msg.type === 'resize') {
      if (!sessionId) {
        return
      }

      const entry = activeTransports.get(sessionId)
      if (
        entry &&
        typeof msg.cols === 'number' &&
        typeof msg.rows === 'number'
      ) {
        entry.transport.resize(msg.cols, msg.rows)
      }
      return
    }
  })

  ws.on('close', () => {
    if (sessionId) {
      detachClient(sessionId, ws)
    }
  })
}

export function createWebServer(
  port: number = 3080,
  host: string = '0.0.0.0',
): http.Server {
  serverPort = port
  const handlers = createRemoteControlApiHandlers()
  const server = http.createServer(async (req, res) => {
    try {
      const handled = await handlers.handleApi(req, res)
      if (handled) {
        return
      }

      if (serveStatic(req, res)) {
        return
      }

      writeJson(res, 404, { error: 'Not found' })
    } catch (error) {
      writeJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  const wss = new WebSocketServer({ server })
  wss.on('connection', handleWebSocket)

  server.on('close', () => {
    wss.close()
    for (const [, entry] of activeTransports) {
      entry.detachTransport()
      entry.transport.close()
    }
    activeTransports.clear()
  })

  server.listen(port, host)
  return server
}

export async function ensureRemoteControlServer(
  port: number = 3080,
  host: string = '0.0.0.0',
): Promise<{ port: number; localUrl: string }> {
  if (
    remoteControlServer &&
    remoteControlServer.listening &&
    remoteControlServerState
  ) {
    return { ...remoteControlServerState }
  }

  remoteControlServer = createWebServer(port, host)
  remoteControlServerState = {
    port,
    localUrl: `http://localhost:${port}`,
  }

  const resetServerState = () => {
    remoteControlServer = null
    remoteControlServerState = null
  }

  remoteControlServer.once('close', resetServerState)
  remoteControlServer.once('error', resetServerState)

  if (!remoteControlServer.listening) {
    await new Promise<void>((resolve, reject) => {
      remoteControlServer?.once('listening', () => resolve())
      remoteControlServer?.once('error', reject)
    })
  }

  if (remoteControlService.listSessions().length === 0) {
    await remoteControlService.createSession({
      source: 'cwd',
      label: path.basename(process.cwd()) || 'CLI Session',
    })
  }

  return { ...remoteControlServerState }
}

export { detachClient, detachAllClients, getOrCreateTransport }
