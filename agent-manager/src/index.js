import { createServer } from 'node:http'
import { URL } from 'node:url'
import { WebSocketServer } from 'ws'
import { nanoid } from 'nanoid'
import { AgentConnection } from './AgentConnection.js'
import { avatarLibrary, resolveAvatarRef } from './avatarLibrary.js'
import { isCORSSafe, proxyAvatar } from './avatarProxy.js'
import { EventBuffer } from './EventBuffer.js'

const PORT = process.env.AGENT_MANAGER_PORT || 5000
const HYPERFY_WS_URL = process.env.HYPERFY_WS_URL || 'ws://localhost:4000/ws'
const HYPERFY_API_URL = process.env.HYPERFY_API_URL || 'http://localhost:4000'
const MAX_VRM_UPLOAD_SIZE = parseInt(process.env.MAX_VRM_UPLOAD_SIZE || '25', 10) * 1024 * 1024
const INACTIVITY_TTL = 5 * 60 * 1000 // 5 min inactivity for all agents
const MAX_BODY_SIZE = 1 * 1024 * 1024   // 1MB request body limit
const MAX_CHAT_LENGTH = 500              // max characters in a chat message
const MAX_NAME_LENGTH = 32               // max characters in an agent name

// ---------------------------------------------------------------------------
// Global agent registry
// ---------------------------------------------------------------------------
const agentSessions = new Map()  // agentId → AgentSession
const tokenIndex = new Map()     // token → agentId (reverse lookup for auth)

/**
 * AgentSession shape:
 * { agent: AgentConnection, transport: 'ws'|'http', token: string|null,
 *   ws: WebSocket|null, eventBuffer: EventBuffer|null,
 *   lastActivity: number, displayName: string }
 */

function destroySession(agentId) {
  const session = agentSessions.get(agentId)
  if (!session) return
  if (session.token) tokenIndex.delete(session.token)
  if (session.agent) {
    try { session.agent.disconnect() } catch { /* already disconnected */ }
  }
  agentSessions.delete(agentId)
  console.log(`Session destroyed: ${agentId} (${session.transport})`)
}

// ---------------------------------------------------------------------------
// Display name disambiguation
// ---------------------------------------------------------------------------
function resolveDisplayName(name, agentId) {
  for (const [id, session] of agentSessions) {
    if (id !== agentId && session.agent.name === name) {
      return `${name}#${agentId.substring(0, 3)}`
    }
  }
  return name
}

// ---------------------------------------------------------------------------
// Resolve fromId → displayName for chat messages
// ---------------------------------------------------------------------------
function resolveFromName(fromId, fallback) {
  for (const [, session] of agentSessions) {
    if (session.agent.getPlayerId() === fromId) {
      return session.displayName
    }
  }
  return fallback
}

// ---------------------------------------------------------------------------
// Speak text validation
// ---------------------------------------------------------------------------
function validateSpeakText(text) {
  if (/^\s*\{?\s*"?type"?\s*[:=]/i.test(text) || /^\s*type\s*:\s*\w+/i.test(text)) {
    return 'Text looks like a malformed command. Send commands as proper JSON messages, not as speak text.'
  }
  return null
}

// ---------------------------------------------------------------------------
// Spawn name validation
// ---------------------------------------------------------------------------
function validateName(name) {
  if (!name || typeof name !== 'string') return 'spawn requires { name: string }'
  if (name.length > MAX_NAME_LENGTH) return `Name too long (max ${MAX_NAME_LENGTH} characters)`
  if (/<|>/.test(name)) return 'Name cannot contain < or > characters'
  return null
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let rejected = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_SIZE) {
        if (!rejected) {
          rejected = true
          reject(new Error('Request body too large'))
        }
        return
      }
      if (!rejected) chunks.push(chunk)
    })
    req.on('end', () => {
      if (rejected) return
      const raw = Buffer.concat(chunks).toString('utf-8')
      if (!raw) { resolve({}); return }
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('Invalid JSON body')) }
    })
    req.on('error', (err) => { if (!rejected) reject(err) })
  })
}

function readTextBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let rejected = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_SIZE) {
        if (!rejected) {
          rejected = true
          reject(new Error('Request body too large'))
        }
        return
      }
      if (!rejected) chunks.push(chunk)
    })
    req.on('end', () => {
      if (rejected) return
      resolve(Buffer.concat(chunks).toString('utf-8'))
    })
    req.on('error', (err) => { if (!rejected) reject(err) })
  })
}

// ---------------------------------------------------------------------------
// Plaintext command parser (for session endpoint)
// ---------------------------------------------------------------------------
function parseTextCommand(line) {
  const trimmed = line.trim()
  if (!trimmed) return null

  // say <text>
  if (trimmed === 'say') {
    return { action: 'speak', text: '' }
  }
  if (trimmed.startsWith('say ')) {
    return { action: 'speak', text: trimmed.slice(4) }
  }

  // move (bare — no direction)
  if (trimmed === 'move') {
    return { action: 'move', direction: '', duration: 1000 }
  }

  // move <direction> [duration]
  const moveMatch = trimmed.match(/^move\s+(\w+)(?:\s+(\S+))?$/)
  if (moveMatch) {
    if (!moveMatch[2]) {
      return { action: 'move', direction: moveMatch[1], duration: 1000 }
    }
    const parsed = Number(moveMatch[2])
    if (!Number.isInteger(parsed)) {
      return { action: 'move_error', error: 'Duration must be a whole number in milliseconds' }
    }
    return { action: 'move', direction: moveMatch[1], duration: parsed }
  }

  // face / look (bare — no direction)
  if (trimmed === 'face' || trimmed === 'look') {
    return { action: 'face', direction: '' }
  }

  // face <direction|yaw|auto> (also accepts "look")
  const faceMatch = trimmed.match(/^(?:face|look)\s+(.+)$/)
  if (faceMatch) {
    const val = faceMatch[1].trim()
    if (val === 'auto') return { action: 'face', direction: null }
    const num = parseFloat(val)
    if (!isNaN(num)) return { action: 'face', yaw: num }
    return { action: 'face', direction: val }
  }

  if (trimmed === 'who') return { action: 'who' }
  if (trimmed === 'ping') return { action: 'ping' }
  if (trimmed === 'despawn') return { action: 'despawn' }

  return { action: 'unknown', raw: trimmed }
}

// ---------------------------------------------------------------------------
// Execute a parsed command against an agent session
// ---------------------------------------------------------------------------
const SESSION_COMMANDS = [
  'say <text>',
  'move forward|backward|left|right|jump [ms]',
  'face <direction|yaw|auto>',
  'look <direction|yaw|auto>',
  'who',
  'ping',
  'despawn',
]

function executeCommand(session, cmd) {
  const agent = session.agent

  switch (cmd.action) {
    case 'speak': {
      if (!cmd.text) return { ok: false, error: 'say requires text' }
      if (cmd.text.length > MAX_CHAT_LENGTH) return { ok: false, error: `Message too long (max ${MAX_CHAT_LENGTH} characters)` }
      if (agent.status !== 'connected') return { ok: false, error: `Agent not connected (${agent.status})` }
      const warning = validateSpeakText(cmd.text)
      agent.speak(cmd.text)
      const result = { ok: true, action: 'say' }
      if (warning) result.warning = warning
      return result
    }
    case 'move_error': {
      return { ok: false, error: cmd.error }
    }
    case 'move': {
      if (!cmd.direction) return { ok: false, error: 'move requires a direction (forward, backward, left, right, jump)' }
      if (agent.status !== 'connected') return { ok: false, error: `Agent not connected (${agent.status})` }
      if (cmd.duration <= 0) return { ok: false, error: 'Duration must be positive (1-10000ms)' }
      if (cmd.duration > 10000) return { ok: false, error: 'Duration cannot exceed 10000ms' }
      try {
        agent.move(cmd.direction, cmd.duration)
      } catch (err) {
        return { ok: false, error: err.message }
      }
      return { ok: true, action: 'move', direction: cmd.direction, duration: cmd.duration }
    }
    case 'face': {
      if (cmd.direction === '') return { ok: false, error: 'face requires a direction, yaw, or auto' }
      if (typeof cmd.yaw === 'number' && !Number.isFinite(cmd.yaw)) return { ok: false, error: 'yaw must be a finite number' }
      if (agent.status !== 'connected') return { ok: false, error: `Agent not connected (${agent.status})` }
      try {
        if (typeof cmd.yaw === 'number') {
          agent.face(cmd.yaw)
          return { ok: true, action: 'face', yaw: cmd.yaw }
        } else {
          agent.face(cmd.direction ?? null)
          return { ok: true, action: 'face', direction: cmd.direction ?? 'auto' }
        }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    }
    case 'who': {
      const agents = []
      for (const [id, s] of agentSessions) {
        if (s.agent.status === 'connected') {
          agents.push({ displayName: s.displayName, id, playerId: s.agent.getPlayerId() })
        }
      }
      return { ok: true, action: 'who', agents }
    }
    case 'ping': {
      return { ok: true, action: 'pong', agentStatus: agent.status }
    }
    case 'despawn': {
      return { ok: true, action: 'despawn', _despawn: true }
    }
    case 'unknown':
    default: {
      return { ok: false, error: `Unknown command: ${cmd.raw || cmd.action}` }
    }
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  })
  res.end(body)
}

function authenticate(req) {
  const auth = req.headers['authorization']
  if (!auth || !auth.startsWith('Bearer ')) return null
  const token = auth.slice(7)
  const agentId = tokenIndex.get(token)
  if (!agentId) return null
  const session = agentSessions.get(agentId)
  if (!session) return null
  session.lastActivity = Date.now()
  return session
}

// ---------------------------------------------------------------------------
// Avatar resolution helper (shared by WS and HTTP spawn)
// ---------------------------------------------------------------------------
async function resolveAndProxyAvatar(avatarRef) {
  let resolvedAvatar = null
  let warning = null
  if (avatarRef) {
    if (typeof avatarRef !== 'string') {
      throw new Error('avatar must be a string (URL, asset:// ref, or library id)')
    }
    resolvedAvatar = resolveAvatarRef(avatarRef)
    if (!resolvedAvatar) {
      throw new Error(`Unknown avatar reference: ${avatarRef}`)
    }
  }
  if (resolvedAvatar && !isCORSSafe(resolvedAvatar)) {
    try {
      resolvedAvatar = await proxyAvatar(resolvedAvatar)
    } catch (err) {
      console.warn(`Avatar proxy failed for ${resolvedAvatar}: ${err.message}, using default`)
      warning = `Avatar failed to load: ${err.message}. Using default avatar.`
      resolvedAvatar = null
    }
  }
  return { url: resolvedAvatar, warning }
}

// ---------------------------------------------------------------------------
// HTTP route handler
// ---------------------------------------------------------------------------
async function handleHttpRequest(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    })
    res.end()
    return
  }

  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const path = parsed.pathname
  const method = req.method

  try {
    // ---- Health check ----
    if (method === 'GET' && path === '/health') {
      sendJson(res, 200, { status: 'ok', agents: agentSessions.size })
      return
    }

    // ---- Session endpoint: /s/<token> ----
    const sessionMatch = path.match(/^\/s\/(.+)$/)
    if (sessionMatch && (method === 'GET' || method === 'POST')) {
      const token = sessionMatch[1]
      const agentId = tokenIndex.get(token)
      if (!agentId) {
        sendJson(res, 401, { ok: false, error: 'Invalid session token' })
        return
      }
      const session = agentSessions.get(agentId)
      if (!session) {
        sendJson(res, 401, { ok: false, error: 'Session expired' })
        return
      }
      session.lastActivity = Date.now()

      let results = []
      let shouldDespawn = false

      // POST with body → parse plaintext commands
      if (method === 'POST') {
        let body
        try {
          body = await readTextBody(req)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: err.message })
          return
        }
        if (body) {
          const lines = body.split('\n')
          for (const line of lines) {
            const cmd = parseTextCommand(line)
            if (!cmd) continue
            const result = executeCommand(session, cmd)
            results.push(result)
            if (result._despawn) {
              shouldDespawn = true
              delete result._despawn
              break
            }
            delete result._despawn
          }
        }
      }

      // Drain events
      const events = session.eventBuffer ? session.eventBuffer.drainSince(0) : []

      // Build response
      const response = {
        ok: results.length === 0 || results.every(r => r.ok),
        events,
        commands: SESSION_COMMANDS,
      }
      if (results.length === 1) {
        Object.assign(response, results[0])
      } else if (results.length > 1) {
        response.results = results
      }

      sendJson(res, 200, response)

      // Despawn after response is sent
      if (shouldDespawn) {
        destroySession(agentId)
      }
      return
    }

    // ---- List avatars ----
    if (method === 'GET' && path === '/api/avatars') {
      sendJson(res, 200, { avatars: avatarLibrary })
      return
    }

    // ---- Spawn (HTTP) ----
    if (method === 'POST' && path === '/api/spawn') {
      let body
      try {
        body = await readBody(req)
      } catch (err) {
        sendJson(res, 400, { error: 'INVALID_JSON', message: err.message })
        return
      }
      const { name, avatar } = body
      const nameError = validateName(name)
      if (nameError) {
        sendJson(res, 400, { error: 'INVALID_PARAMS', message: nameError })
        return
      }

      let resolvedAvatar, avatarWarning
      try {
        const result = await resolveAndProxyAvatar(avatar)
        resolvedAvatar = result.url
        avatarWarning = result.warning
      } catch (err) {
        sendJson(res, 400, { error: 'INVALID_PARAMS', message: err.message })
        return
      }

      const id = nanoid(12)
      const token = nanoid(32)
      const agent = new AgentConnection(id, name, resolvedAvatar)
      const eventBuffer = new EventBuffer()
      const displayName = resolveDisplayName(name, id)

      // Wire callbacks to push into event buffer
      agent.onWorldChat = (chatMsg) => {
        const playerId = agent.getPlayerId()
        if (chatMsg.fromId === playerId) return
        eventBuffer.push({
          type: 'chat',
          from: resolveFromName(chatMsg.fromId, chatMsg.from),
          fromId: chatMsg.fromId,
          body: chatMsg.body,
          id: chatMsg.id,
          createdAt: chatMsg.createdAt,
        })
      }

      agent.onKick = (code) => {
        eventBuffer.push({ type: 'kicked', code })
        // Don't destroy immediately — let the agent poll this event
      }

      agent.onDisconnect = () => {
        eventBuffer.push({ type: 'disconnected' })
      }

      try {
        await agent.connect(HYPERFY_WS_URL)
      } catch (err) {
        sendJson(res, 500, { error: 'SPAWN_FAILED', message: err.message })
        return
      }

      // Register session
      const session = {
        agent,
        transport: 'http',
        token,
        ws: null,
        eventBuffer,
        lastActivity: Date.now(),
        displayName,
      }
      agentSessions.set(id, session)
      tokenIndex.set(token, id)

      console.log(`HTTP agent spawned: ${name} (${id}) displayName=${displayName}`)
      const spawnResponse = {
        id,
        token,
        session: `http://${req.headers.host || `localhost:${PORT}`}/s/${token}`,
        name: agent.name,
        displayName,
        avatar: agent.avatar,
      }
      if (avatarWarning) spawnResponse.warning = avatarWarning
      sendJson(res, 201, spawnResponse)
      return
    }

    // ---- Routes requiring :id param ----
    const agentRouteMatch = path.match(/^\/api\/agents\/([^/]+)(\/\w+)?$/)
    if (agentRouteMatch) {
      const agentId = agentRouteMatch[1]
      const action = agentRouteMatch[2] ? agentRouteMatch[2].slice(1) : null

      // All agent routes require auth
      const session = authenticate(req)
      if (!session) {
        sendJson(res, 401, { error: 'UNAUTHORIZED', message: 'Invalid or missing Bearer token' })
        return
      }
      // Verify the token matches this agent
      if (session.agent.id !== agentId) {
        sendJson(res, 403, { error: 'FORBIDDEN', message: 'Token does not match agent id' })
        return
      }

      const agent = session.agent

      // ---- DELETE /api/agents/:id (despawn) ----
      if (method === 'DELETE' && !action) {
        destroySession(agentId)
        sendJson(res, 200, { status: 'despawned' })
        return
      }

      // Ensure agent is connected for action endpoints
      if (agent.status !== 'connected' && action !== 'events') {
        sendJson(res, 409, { error: 'NOT_CONNECTED', message: `Agent is not connected (status: ${agent.status})` })
        return
      }

      // ---- GET /api/agents/:id/events ----
      if (method === 'GET' && action === 'events') {
        const since = parsed.searchParams.get('since')
        let sinceMs = 0
        if (since) {
          const parsed_ts = Number(since) || Date.parse(since)
          if (!isNaN(parsed_ts)) sinceMs = parsed_ts
        }
        const events = session.eventBuffer ? session.eventBuffer.drainSince(sinceMs) : []
        sendJson(res, 200, { events, agentStatus: agent.status })
        return
      }

      // ---- POST /api/agents/:id/speak ----
      if (method === 'POST' && action === 'speak') {
        let body
        try {
          body = await readBody(req)
        } catch (err) {
          sendJson(res, 400, { error: 'INVALID_JSON', message: err.message })
          return
        }
        const { text } = body
        if (!text || typeof text !== 'string') {
          sendJson(res, 400, { error: 'INVALID_PARAMS', message: 'speak requires { text: string }' })
          return
        }
        if (text.length > MAX_CHAT_LENGTH) {
          sendJson(res, 400, { error: 'INVALID_PARAMS', message: `Message too long (max ${MAX_CHAT_LENGTH} characters)` })
          return
        }
        const warning = validateSpeakText(text)
        agent.speak(text)
        const response = { status: 'sent' }
        if (warning) response.warning = warning
        sendJson(res, 200, response)
        return
      }

      // ---- POST /api/agents/:id/move ----
      if (method === 'POST' && action === 'move') {
        let body
        try {
          body = await readBody(req)
        } catch (err) {
          sendJson(res, 400, { error: 'INVALID_JSON', message: err.message })
          return
        }
        const { direction, duration } = body
        if (!direction || typeof direction !== 'string') {
          sendJson(res, 400, { error: 'INVALID_PARAMS', message: 'move requires { direction: string }' })
          return
        }
        const durationMs = typeof duration === 'number' ? duration : 1000
        if (durationMs <= 0) {
          sendJson(res, 400, { error: 'INVALID_PARAMS', message: 'Duration must be positive (1-10000ms)' })
          return
        }
        if (durationMs > 10000) {
          sendJson(res, 400, { error: 'INVALID_PARAMS', message: 'Duration cannot exceed 10000ms' })
          return
        }
        try {
          agent.move(direction, durationMs)
        } catch (err) {
          sendJson(res, 400, { error: 'INVALID_PARAMS', message: err.message })
          return
        }
        sendJson(res, 200, { status: 'moving', direction, duration: durationMs })
        return
      }

      // ---- POST /api/agents/:id/face ----
      if (method === 'POST' && action === 'face') {
        let body
        try {
          body = await readBody(req)
        } catch (err) {
          sendJson(res, 400, { error: 'INVALID_JSON', message: err.message })
          return
        }
        const { direction, yaw } = body
        if (typeof yaw === 'number' && !Number.isFinite(yaw)) {
          sendJson(res, 400, { error: 'INVALID_PARAMS', message: 'yaw must be a finite number' })
          return
        }
        try {
          if (typeof yaw === 'number') {
            agent.face(yaw)
            sendJson(res, 200, { status: 'facing', yaw })
          } else if (direction === null) {
            agent.face(null)
            sendJson(res, 200, { status: 'facing', direction: 'auto' })
          } else if (typeof direction === 'string') {
            agent.face(direction)
            sendJson(res, 200, { status: 'facing', direction })
          } else {
            sendJson(res, 400, { error: 'INVALID_PARAMS', message: 'face requires { direction: string } or { yaw: number } or { direction: null }' })
            return
          }
        } catch (err) {
          sendJson(res, 400, { error: 'INVALID_PARAMS', message: err.message })
          return
        }
        return
      }

      // ---- POST /api/agents/:id/ping ----
      if (method === 'POST' && action === 'ping') {
        sendJson(res, 200, { status: 'pong', agentStatus: agent.status })
        return
      }

      sendJson(res, 404, { error: 'NOT_FOUND', message: `Unknown action: ${action || 'none'}` })
      return
    }

    // ---- 404 fallthrough ----
    sendJson(res, 404, { error: 'NOT_FOUND', message: `No route: ${method} ${path}` })
  } catch (err) {
    console.error('HTTP handler error:', err)
    sendJson(res, 500, { error: 'INTERNAL_ERROR', message: err.message })
  }
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket shared server
// ---------------------------------------------------------------------------
const server = createServer(handleHttpRequest)
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req)
  })
})

// ---------------------------------------------------------------------------
// WebSocket send helpers
// ---------------------------------------------------------------------------
function send(ws, type, payload = {}) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }))
  }
}

function sendError(ws, code, message) {
  send(ws, 'error', { code, message })
}

// ---------------------------------------------------------------------------
// WebSocket connection handler
// ---------------------------------------------------------------------------
wss.on('connection', (ws) => {
  let agentId = null

  ws.on('message', async (raw) => {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      sendError(ws, 'INVALID_COMMAND', 'Message must be valid JSON')
      return
    }

    const { type } = msg

    // Track activity for inactivity timeout
    if (agentId) {
      const session = agentSessions.get(agentId)
      if (session) session.lastActivity = Date.now()
    }

    switch (type) {
      case 'spawn': {
        if (agentId) {
          sendError(ws, 'ALREADY_SPAWNED', 'Agent already spawned on this connection')
          return
        }
        const { name, avatar } = msg
        const nameError = validateName(name)
        if (nameError) {
          sendError(ws, 'INVALID_PARAMS', nameError)
          return
        }

        let resolvedAvatar, avatarWarning
        try {
          const result = await resolveAndProxyAvatar(avatar)
          resolvedAvatar = result.url
          avatarWarning = result.warning
        } catch (err) {
          sendError(ws, 'INVALID_PARAMS', err.message)
          return
        }

        const id = nanoid(12)
        const agent = new AgentConnection(id, name, resolvedAvatar)
        const displayName = resolveDisplayName(name, id)

        // Set callbacks before connect
        agent.onWorldChat = (chatMsg) => {
          const playerId = agent.getPlayerId()
          if (chatMsg.fromId === playerId) return
          send(ws, 'chat', {
            from: resolveFromName(chatMsg.fromId, chatMsg.from),
            fromId: chatMsg.fromId,
            body: chatMsg.body,
            id: chatMsg.id,
            createdAt: chatMsg.createdAt,
          })
        }

        agent.onKick = (code) => {
          send(ws, 'kicked', { code })
          ws.close()
        }

        agent.onDisconnect = () => {
          send(ws, 'disconnected')
          ws.close()
        }

        try {
          await agent.connect(HYPERFY_WS_URL)
        } catch (err) {
          sendError(ws, 'SPAWN_FAILED', err.message)
          return
        }

        agentId = id

        // Register in global registry
        const session = {
          agent,
          transport: 'ws',
          token: null,
          ws,
          eventBuffer: null,
          lastActivity: Date.now(),
          displayName,
        }
        agentSessions.set(id, session)

        console.log(`WS agent spawned: ${name} (${id}) displayName=${displayName}`)
        const spawnedPayload = { id: agent.id, name: agent.name, displayName, avatar: agent.avatar }
        if (avatarWarning) spawnedPayload.warning = avatarWarning
        send(ws, 'spawned', spawnedPayload)
        break
      }

      case 'speak': {
        const session = agentSessions.get(agentId)
        const agent = session?.agent
        if (!agent || agent.status !== 'connected') {
          sendError(ws, agent ? 'NOT_CONNECTED' : 'SPAWN_REQUIRED',
            agent ? 'Agent is not connected' : 'Send spawn first')
          return
        }
        const { text } = msg
        if (!text || typeof text !== 'string') {
          sendError(ws, 'INVALID_PARAMS', 'speak requires { text: string }')
          return
        }
        if (text.length > MAX_CHAT_LENGTH) {
          sendError(ws, 'INVALID_PARAMS', `Message too long (max ${MAX_CHAT_LENGTH} characters)`)
          return
        }
        const warning = validateSpeakText(text)
        if (warning) {
          send(ws, 'warning', { message: warning })
        }
        agent.speak(text)
        send(ws, 'speak', { text })
        break
      }

      case 'move': {
        const session = agentSessions.get(agentId)
        const agent = session?.agent
        if (!agent || agent.status !== 'connected') {
          sendError(ws, agent ? 'NOT_CONNECTED' : 'SPAWN_REQUIRED',
            agent ? 'Agent is not connected' : 'Send spawn first')
          return
        }
        const { direction, duration } = msg
        if (!direction || typeof direction !== 'string') {
          sendError(ws, 'INVALID_PARAMS', 'move requires { direction: string }')
          return
        }
        const durationMs = typeof duration === 'number' ? duration : 1000
        if (durationMs <= 0) {
          sendError(ws, 'INVALID_PARAMS', 'Duration must be positive (1-10000ms)')
          return
        }
        if (durationMs > 10000) {
          sendError(ws, 'INVALID_PARAMS', 'Duration cannot exceed 10000ms')
          return
        }
        try {
          agent.move(direction, durationMs)
          send(ws, 'move', { direction, duration: durationMs })
        } catch (err) {
          sendError(ws, 'INVALID_PARAMS', err.message)
        }
        break
      }

      case 'face': {
        const session = agentSessions.get(agentId)
        const agent = session?.agent
        if (!agent || agent.status !== 'connected') {
          sendError(ws, agent ? 'NOT_CONNECTED' : 'SPAWN_REQUIRED',
            agent ? 'Agent is not connected' : 'Send spawn first')
          return
        }
        const { direction: faceDir, yaw } = msg
        if (typeof yaw === 'number' && !Number.isFinite(yaw)) {
          sendError(ws, 'INVALID_PARAMS', 'yaw must be a finite number')
          return
        }
        try {
          if (typeof yaw === 'number') {
            agent.face(yaw)
            send(ws, 'face', { yaw })
          } else if (faceDir === null) {
            agent.face(null)
            send(ws, 'face', { direction: 'auto' })
          } else if (typeof faceDir === 'string') {
            agent.face(faceDir)
            send(ws, 'face', { direction: faceDir })
          } else {
            sendError(ws, 'INVALID_PARAMS', 'face requires { direction: string } or { yaw: number } or { direction: null }')
            return
          }
        } catch (err) {
          sendError(ws, 'INVALID_PARAMS', err.message)
        }
        break
      }

      case 'who': {
        const agents = []
        for (const [id, s] of agentSessions) {
          if (s.agent.status === 'connected') {
            agents.push({ displayName: s.displayName, id, playerId: s.agent.getPlayerId() })
          }
        }
        send(ws, 'who', { agents })
        break
      }

      case 'list_avatars': {
        send(ws, 'avatar_library', { avatars: avatarLibrary })
        break
      }

      case 'upload_avatar': {
        const { data, filename } = msg
        if (!data || typeof data !== 'string') {
          sendError(ws, 'INVALID_PARAMS', 'upload_avatar requires { data: string (base64), filename: string }')
          return
        }
        if (!filename || typeof filename !== 'string' || !filename.endsWith('.vrm')) {
          sendError(ws, 'INVALID_PARAMS', 'filename must be a .vrm file')
          return
        }

        let buffer
        try {
          buffer = Buffer.from(data, 'base64')
        } catch {
          sendError(ws, 'INVALID_PARAMS', 'data must be valid base64')
          return
        }

        if (buffer.length > MAX_VRM_UPLOAD_SIZE) {
          sendError(ws, 'INVALID_PARAMS', `VRM file exceeds max size of ${MAX_VRM_UPLOAD_SIZE / (1024 * 1024)}MB`)
          return
        }

        if (buffer.length < 12) {
          sendError(ws, 'INVALID_PARAMS', 'File too small to be a valid VRM')
          return
        }
        const magic = buffer.readUInt32LE(0)
        if (magic !== 0x46546C67) {
          sendError(ws, 'INVALID_PARAMS', 'Invalid VRM file: missing glTF magic bytes')
          return
        }
        const version = buffer.readUInt32LE(4)
        if (version !== 2) {
          sendError(ws, 'INVALID_PARAMS', 'Invalid VRM file: must be glTF version 2')
          return
        }

        try {
          const boundary = '----VRMUpload' + Date.now()
          const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
          const footer = `\r\n--${boundary}--\r\n`
          const headerBuf = Buffer.from(header)
          const footerBuf = Buffer.from(footer)
          const body = Buffer.concat([headerBuf, buffer, footerBuf])

          const uploadRes = await fetch(`${HYPERFY_API_URL}/api/avatar/upload`, {
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            body,
          })

          if (!uploadRes.ok) {
            const text = await uploadRes.text()
            sendError(ws, 'UPLOAD_FAILED', `Upload failed: ${uploadRes.status} ${text}`)
            return
          }

          const result = await uploadRes.json()
          send(ws, 'avatar_uploaded', { url: result.url, hash: result.hash })
        } catch (err) {
          sendError(ws, 'UPLOAD_FAILED', `Upload failed: ${err.message}`)
        }
        break
      }

      case 'ping': {
        send(ws, 'pong')
        break
      }

      default: {
        sendError(ws, 'INVALID_COMMAND', `Unknown command: ${type}`)
      }
    }
  })

  ws.on('close', () => {
    if (agentId) {
      destroySession(agentId)
      agentId = null
    }
  })

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message)
    if (agentId) {
      destroySession(agentId)
      agentId = null
    }
  })
})

// ---------------------------------------------------------------------------
// Inactivity timeout cleanup (all agents)
// ---------------------------------------------------------------------------
const cleanupInterval = setInterval(() => {
  const now = Date.now()
  for (const [id, session] of agentSessions) {
    if (now - session.lastActivity > INACTIVITY_TTL) {
      console.log(`Session timed out (inactive ${Math.round((now - session.lastActivity) / 1000)}s): ${id} (${session.agent.name}, ${session.transport})`)
      // For WS agents, close the socket (which triggers destroySession via 'close' handler)
      if (session.transport === 'ws' && session.ws) {
        send(session.ws, 'kicked', { code: 'INACTIVITY_TIMEOUT' })
        session.ws.close()
      } else {
        destroySession(id)
      }
    }
  }
}, 60_000)

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
const shutdown = () => {
  console.log('Shutting down agent-manager...')
  clearInterval(cleanupInterval)

  // Destroy all agent sessions (both WS and HTTP)
  for (const [id] of agentSessions) {
    destroySession(id)
  }

  // Close all remaining WS clients
  for (const client of wss.clients) {
    client.close()
  }

  wss.close(() => {
    server.close(() => {
      process.exit(0)
    })
  })

  // Force exit after 5 seconds if graceful shutdown stalls
  setTimeout(() => process.exit(1), 5000)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`Agent manager listening on port ${PORT} (HTTP + WebSocket)`)
  console.log(`  WebSocket: ws://localhost:${PORT}`)
  console.log(`  HTTP API:  http://localhost:${PORT}/api/`)
  console.log(`  Health:    http://localhost:${PORT}/health`)
  console.log(`Hyperfy WebSocket URL: ${HYPERFY_WS_URL}`)
})
