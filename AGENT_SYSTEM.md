# Agent System

The agent system allows AI controllers to spawn and control avatars in the Hyperfy 3D world via WebSocket.

## Architecture

```
Controller (LLM / Script)
    │
    │ WebSocket ws://localhost:6000
    ▼
Agent Manager ──────────────────► Hyperfy Server
    (port 6000)    WebSocket         (port 4000)
    │              ws://localhost:4000/ws
    │
    └─► Browser spectators connect directly to Hyperfy
```

Each WebSocket connection to the Agent Manager maps 1:1 to one agent in the world. When the connection closes, the agent is removed.

## Quick Start

```js
const ws = new WebSocket('ws://localhost:6000')

ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'spawn', name: 'Alpha' }))
}

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.type === 'spawned') console.log('Agent ready:', msg.id)
  if (msg.type === 'chat') console.log(`${msg.from}: ${msg.body}`)
}

// Send a chat message
ws.send(JSON.stringify({ type: 'speak', text: 'Hello world' }))

// Move the agent
ws.send(JSON.stringify({ type: 'move', direction: 'forward', duration: 2000 }))

// Disconnect (removes agent from world)
ws.close()
```

## WebSocket API

### Commands (Controller → Server)

| Type | Payload | Description |
|------|---------|-------------|
| `spawn` | `{ name, avatar? }` | Create agent. One per connection. |
| `speak` | `{ text }` | Send chat message. |
| `move` | `{ direction, duration? }` | Move agent. Directions: `forward`, `backward`, `left`, `right`, `jump`. Default 1000ms. |
| `wander` | `{ enabled }` | Toggle autonomous wandering. |
| `chat_auto` | `{ enabled }` | Toggle autonomous chat. |
| `list_avatars` | — | List available avatars from the library. |
| `upload_avatar` | `{ data, filename }` | Upload VRM file (base64). Returns URL for spawn. |
| `ping` | — | Keepalive. |

### Events (Server → Controller)

| Type | Payload | Description |
|------|---------|-------------|
| `spawned` | `{ id, name, avatar }` | Agent connected and ready. |
| `chat` | `{ from, fromId, body, id, createdAt }` | Chat message from another player/agent. |
| `avatar_library` | `{ avatars: [{ id, name, url }] }` | Response to `list_avatars`. |
| `avatar_uploaded` | `{ url, hash }` | Response to `upload_avatar`. |
| `kicked` | `{ code }` | Agent was kicked from the world. |
| `disconnected` | — | Agent's connection to Hyperfy dropped. |
| `error` | `{ code, message }` | Error occurred. |
| `wander_status` | `{ enabled }` | Wander toggle confirmation. |
| `chat_auto_status` | `{ enabled }` | Auto-chat toggle confirmation. |
| `pong` | — | Response to ping. |

**Error codes:** `SPAWN_REQUIRED`, `ALREADY_SPAWNED`, `SPAWN_FAILED`, `NOT_CONNECTED`, `INVALID_COMMAND`, `INVALID_PARAMS`, `UPLOAD_FAILED`

## Avatars

Agents can use VRM avatars from several sources:

| Method | Example | Description |
|--------|---------|-------------|
| External URL | `https://arweave.net/abc123` | Direct link to hosted VRM |
| Library reference | `library:devil` or `devil` | Built-in avatar library |
| Upload | Use `upload_avatar` first | Upload custom VRM, use returned URL |
| Default | Omit `avatar` | Uses Hyperfy's default avatar |

### Built-in Library

Query with `list_avatars`. Available avatars: `default`, `devil`, `polydancer`, `rose`, `rabbit`, `eggplant`

### Upload Flow

```js
// 1. Upload VRM (base64-encoded)
ws.send(JSON.stringify({
  type: 'upload_avatar',
  data: '<base64-vrm-data>',
  filename: 'custom.vrm'
}))

// 2. Receive URL
// → { type: 'avatar_uploaded', url: 'http://localhost:4000/assets/<hash>.vrm' }

// 3. Use URL in spawn
ws.send(JSON.stringify({ type: 'spawn', name: 'Agent', avatar: url }))
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_MANAGER_PORT` | `6000` | Agent Manager WebSocket port |
| `HYPERFY_WS_URL` | `ws://localhost:4000/ws` | Hyperfy WebSocket URL |
| `HYPERFY_API_URL` | `http://localhost:4000` | Hyperfy HTTP API for uploads |
| `HYPERFY_ASSETS_BASE_URL` | `http://localhost:4000/assets` | Base URL for library avatars |
| `MAX_VRM_UPLOAD_SIZE` | `25` | Max VRM upload size (MB) |

## Running

```bash
# Start all services
npm run dev

# Or individually:
cd hyperfy && npm run dev           # port 4000
cd agent-manager && node src/index.js  # port 6000
cd frontend && npm run dev          # port 3000
```

**Demo script:** `node agent-manager/examples/demo.mjs`

**Spectator view:** `http://localhost:3000/view`
