import { WebSocketServer } from 'ws'
import { nanoid } from 'nanoid'
import { AgentConnection } from './AgentConnection.js'
import { avatarLibrary, resolveAvatarRef } from './avatarLibrary.js'
import { isCORSSafe, proxyAvatar } from './avatarProxy.js'

const PORT = process.env.AGENT_MANAGER_PORT || 5000
const HYPERFY_WS_URL = process.env.HYPERFY_WS_URL || 'ws://localhost:4000/ws'
const HYPERFY_API_URL = process.env.HYPERFY_API_URL || 'http://localhost:4000'
const MAX_VRM_UPLOAD_SIZE = parseInt(process.env.MAX_VRM_UPLOAD_SIZE || '25', 10) * 1024 * 1024

const wss = new WebSocketServer({ port: PORT })

function send(ws, type, payload = {}) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }))
  }
}

function sendError(ws, code, message) {
  send(ws, 'error', { code, message })
}

wss.on('connection', (ws) => {
  let agent = null

  ws.on('message', async (raw) => {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      sendError(ws, 'INVALID_COMMAND', 'Message must be valid JSON')
      return
    }

    const { type } = msg

    switch (type) {
      case 'spawn': {
        if (agent) {
          sendError(ws, 'ALREADY_SPAWNED', 'Agent already spawned on this connection')
          return
        }
        const { name, avatar } = msg
        if (!name || typeof name !== 'string') {
          sendError(ws, 'INVALID_PARAMS', 'spawn requires { name: string }')
          return
        }

        let resolvedAvatar = null
        if (avatar) {
          if (typeof avatar !== 'string') {
            sendError(ws, 'INVALID_PARAMS', 'avatar must be a string (URL, asset:// ref, or library id)')
            return
          }
          resolvedAvatar = resolveAvatarRef(avatar)
          if (!resolvedAvatar) {
            sendError(ws, 'INVALID_PARAMS', `Unknown avatar reference: ${avatar}`)
            return
          }
        }

        // Proxy avatar through Hyperfy if the URL isn't CORS-safe
        if (resolvedAvatar && !isCORSSafe(resolvedAvatar)) {
          try {
            resolvedAvatar = await proxyAvatar(resolvedAvatar)
          } catch (err) {
            console.warn(`Avatar proxy failed for ${resolvedAvatar}: ${err.message}, using default`)
            resolvedAvatar = null
          }
        }

        const id = nanoid(12)
        agent = new AgentConnection(id, name, resolvedAvatar)

        // Set callbacks before connect
        agent.onWorldChat = (chatMsg) => {
          // Filter out own messages
          const playerId = agent.getPlayerId()
          if (chatMsg.fromId === playerId) return
          send(ws, 'chat', {
            from: chatMsg.from,
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
          send(ws, 'spawned', { id: agent.id, name: agent.name, avatar: agent.avatar })
        } catch (err) {
          sendError(ws, 'SPAWN_FAILED', err.message)
          agent = null
        }
        break
      }

      case 'speak': {
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
        agent.speak(text)
        break
      }

      case 'move': {
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
        try {
          agent.move(direction, durationMs)
        } catch (err) {
          sendError(ws, 'INVALID_PARAMS', err.message)
        }
        break
      }

      case 'face': {
        if (!agent || agent.status !== 'connected') {
          sendError(ws, agent ? 'NOT_CONNECTED' : 'SPAWN_REQUIRED',
            agent ? 'Agent is not connected' : 'Send spawn first')
          return
        }
        const { direction: faceDir, yaw } = msg
        try {
          if (typeof yaw === 'number') {
            agent.face(yaw)
          } else if (faceDir === null) {
            agent.face(null) // clear — revert to auto-face
          } else if (typeof faceDir === 'string') {
            agent.face(faceDir)
          } else {
            sendError(ws, 'INVALID_PARAMS', 'face requires { direction: string } or { yaw: number } or { direction: null }')
            return
          }
        } catch (err) {
          sendError(ws, 'INVALID_PARAMS', err.message)
        }
        break
      }

      case 'wander': {
        if (!agent || agent.status !== 'connected') {
          sendError(ws, agent ? 'NOT_CONNECTED' : 'SPAWN_REQUIRED',
            agent ? 'Agent is not connected' : 'Send spawn first')
          return
        }
        const { enabled } = msg
        if (enabled === false) {
          agent.stopWander()
        } else {
          agent.startWander()
        }
        send(ws, 'wander_status', { enabled: agent._wandering })
        break
      }

      case 'chat_auto': {
        if (!agent || agent.status !== 'connected') {
          sendError(ws, agent ? 'NOT_CONNECTED' : 'SPAWN_REQUIRED',
            agent ? 'Agent is not connected' : 'Send spawn first')
          return
        }
        const { enabled } = msg
        if (enabled === false) {
          agent.stopChat()
        } else {
          agent.startChat()
        }
        send(ws, 'chat_auto_status', { enabled: agent._chatting })
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

        // Validate GLB magic bytes (VRM is a GLB container)
        if (buffer.length < 12) {
          sendError(ws, 'INVALID_PARAMS', 'File too small to be a valid VRM')
          return
        }
        const magic = buffer.readUInt32LE(0)
        if (magic !== 0x46546C67) { // 'glTF'
          sendError(ws, 'INVALID_PARAMS', 'Invalid VRM file: missing glTF magic bytes')
          return
        }
        const version = buffer.readUInt32LE(4)
        if (version !== 2) {
          sendError(ws, 'INVALID_PARAMS', 'Invalid VRM file: must be glTF version 2')
          return
        }

        try {
          // Build multipart form data and POST to Hyperfy upload endpoint
          const boundary = '----VRMUpload' + Date.now()
          const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
          const footer = `\r\n--${boundary}--\r\n`
          const headerBuf = Buffer.from(header)
          const footerBuf = Buffer.from(footer)
          const body = Buffer.concat([headerBuf, buffer, footerBuf])

          const res = await fetch(`${HYPERFY_API_URL}/api/avatar/upload`, {
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            body,
          })

          if (!res.ok) {
            const text = await res.text()
            sendError(ws, 'UPLOAD_FAILED', `Upload failed: ${res.status} ${text}`)
            return
          }

          const result = await res.json()
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
    if (agent) {
      agent.disconnect()
      agent = null
    }
  })

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message)
    if (agent) {
      agent.disconnect()
      agent = null
    }
  })
})

// Graceful shutdown
const shutdown = () => {
  console.log('Shutting down agent-manager...')
  for (const client of wss.clients) {
    client.close()
  }
  wss.close(() => {
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

console.log(`Agent manager WebSocket server listening on port ${PORT}`)
console.log(`Hyperfy WebSocket URL: ${HYPERFY_WS_URL}`)
