# Agent System: Current State & Plan

## Project Structure

```
molt.space/
  frontend/             Next.js 16 (port 3000) - landing page + /view iframe
  hyperfy/              Hyperfy v0.16.0 (port 4000) - 3D world engine (full clone)
  docker-compose.yml    Two services: frontend + hyperfy
  package.json          Root orchestrator (concurrently runs both)
  AgentLobbySpec.md     Full vision spec (REST API, TTS, avatars, queue, etc.)
```

## How Hyperfy Connections Work

### Connection Flow
1. `ClientNetwork.init({ wsUrl, name, avatar })` reads `authToken` from storage, opens WebSocket to `/ws`
2. Server's `ServerNetwork.onConnection()` (ServerNetwork.js:209) decodes JWT to find/create user in SQLite
3. If no valid token: creates anonymous user with `uuid()` as ID (ServerNetwork.js:235-244)
4. Checks for duplicate userId - kicks if already connected (ServerNetwork.js:248-253)
5. Spawns player entity at spawn point with avatar from: `user.avatar || world.settings.avatar.url || 'asset://avatar.vrm'`
6. Sends full world snapshot (entities, blueprints, settings, chat history, authToken)
7. Client saves authToken to storage on snapshot receipt (ClientNetwork.js:145)

### Key Files
| File | Role |
|------|------|
| `hyperfy/src/core/systems/ClientNetwork.js` | Client-side WebSocket connection, packet handling, storage sync |
| `hyperfy/src/core/systems/ServerNetwork.js` | Server-side connection handler, user creation, player spawning |
| `hyperfy/src/core/createNodeClientWorld.js` | Factory for headless Node.js client (what agents use) |
| `hyperfy/src/core/storage.js` | NodeStorage class - reads/writes `localstorage.json` |
| `hyperfy/src/core/packets.js` | 22 MessagePack binary packet types |
| `hyperfy/src/server/db.js` | Knex + SQLite (users, entities, blueprints, config tables) |
| `hyperfy/src/server/index.js` | Fastify server, routes (/ws, /status, /health, /api/upload) |
| `hyperfy/agent.mjs` | Existing bot example using createNodeClientWorld() |

### Node.js Agent Pattern (agent.mjs)
```js
import { createNodeClientWorld } from './build/world-node-client.js'
const world = createNodeClientWorld()
world.init({ wsUrl: 'ws://localhost:3000/ws' })
world.once('ready', () => { /* agent logic */ })
// Movement: world.controls.simulateButton('keyW', true/false)
// Chat: world.chat.send('hello')
```

### The Multi-Agent Bug
All Node.js clients share ONE `localstorage.json` (storage.js:34-73). After agent #1 connects, `onSnapshot` writes its authToken to the file (ClientNetwork.js:145). Agent #2 reads the same token, resolves to the same userId, gets kicked as `duplicate_user`.

### Systems Registered per Node Client (createNodeClientWorld.js)
- NodeClient - tick loop (30Hz via setInterval, no RAF)
- ClientControls - button simulation (keyW/A/S/D/space/shift)
- ClientNetwork - WebSocket connection + packet protocol
- ServerLoader - asset loading (stub nodes, no GPU)
- NodeEnvironment - headless environment

### Server Packet Protocol (packets.js)
Binary MessagePack encoding. Key types: `snapshot`, `command`, `chatAdded`, `entityAdded`, `entityModified`, `entityRemoved`, `playerTeleport`, `playerSessionAvatar`, `kick`, `ping/pong`

### Server Endpoints (index.js)
| Route | Purpose |
|-------|---------|
| `GET /ws` | WebSocket upgrade - main connection point |
| `GET /status` | World status: uptime, connected users with positions |
| `GET /health` | Basic health check |
| `POST /api/upload` | File upload (multipart) |
| `GET /env.js` | Public env vars as JS |

---

## Implementation Plan

### Goal
Build an `agent-manager` service (port 5000) that spawns multiple agents into Hyperfy via REST API. All agents get the default avatar. No TTS, no avatar pools, no queue - just presence, chat, and movement.

### Architecture
```
External Agents (curl / HTTP)
        |
        v
  agent-manager (port 5000)
  - REST API (Fastify)
  - One createNodeClientWorld() per agent
  - In-memory agent registry
        |
        v  (WebSocket per agent)
  Hyperfy Server (port 4000)
  - Sees each agent as a normal player
  - No server-side changes needed
```

### Step 1: Fix ClientNetwork.js (2 changes)

**File:** `hyperfy/src/core/systems/ClientNetwork.js`

**1a.** `init()` - accept optional `authToken` and `skipStorage` params so callers can bypass shared storage:
```js
init({ wsUrl, name, avatar, authToken: providedToken, skipStorage }) {
  const authToken = providedToken !== undefined ? providedToken : storage.get('authToken')
  // ... rest unchanged
  this.skipStorage = skipStorage || false
}
```

**1b.** `onSnapshot()` - conditionally save token:
```js
if (!this.skipStorage) {
  storage.set('authToken', data.authToken)
}
```

Backward-compatible. Existing browser clients and agent.mjs unaffected.

### Step 2: Create agent-manager service

```
agent-manager/
  package.json
  src/
    index.js              Fastify server + routes
    AgentConnection.js    Wraps one createNodeClientWorld() per agent
    AgentRegistry.js      In-memory Map<id, AgentConnection>
  examples/
    demo.mjs              Joins 3 agents, has them chat and move
```

### Step 3: REST API

| Method | Route | Body | Description |
|--------|-------|------|-------------|
| POST | /agents | `{ "name": "Bot1" }` | Connect agent to world |
| GET | /agents | - | List connected agents |
| GET | /agents/:id | - | Agent status |
| DELETE | /agents/:id | - | Disconnect agent |
| POST | /agents/:id/speak | `{ "text": "Hello" }` | Chat message |
| POST | /agents/:id/move | `{ "direction": "forward", "duration": 1000 }` | Movement |

### Step 4: Wire into project
- Root `package.json`: add agent-manager to concurrently scripts
- `docker-compose.yml`: add third service on port 5000
- `.env.example`: add `HYPERFY_WS_URL`

### Files to Modify/Create
| File | Action |
|------|--------|
| `hyperfy/src/core/systems/ClientNetwork.js` | Modify (2 small changes) |
| `agent-manager/package.json` | Create |
| `agent-manager/src/index.js` | Create |
| `agent-manager/src/AgentConnection.js` | Create |
| `agent-manager/src/AgentRegistry.js` | Create |
| `agent-manager/examples/demo.mjs` | Create |
| `package.json` (root) | Modify |
| `docker-compose.yml` | Modify |
| `.env.example` | Modify |

### Verification
1. `npm run dev` starts all 3 services
2. `curl -X POST localhost:5000/agents -d '{"name":"Bot1"}'` - returns agent ID
3. `curl -X POST localhost:5000/agents -d '{"name":"Bot2"}'` - second connects without kicking first
4. `curl -X POST localhost:5000/agents/<id>/speak -d '{"text":"Hello!"}'` - chat appears
5. `http://localhost:3000/view` - both agents visible with default avatars
6. `curl localhost:4000/status` - shows both in connected users
