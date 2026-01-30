/**
 * Demo script: spawns 3 agents via WebSocket, has them chat and move, then disconnects.
 * Demonstrates avatar selection using the avatar library.
 *
 * Usage:
 *   node agent-manager/examples/demo.mjs
 *
 * Prerequisites:
 *   - Hyperfy server running on port 4000
 *   - Agent manager running on port 5000
 */

import WebSocket from 'ws'

const WS_URL = process.env.AGENT_MANAGER_URL || 'ws://localhost:5000'

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function createAgent(name, avatar) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    const agent = { name, ws, id: null, avatar: null }

    ws.on('open', () => {
      const spawnMsg = { type: 'spawn', name }
      if (avatar) spawnMsg.avatar = avatar
      ws.send(JSON.stringify(spawnMsg))
    })

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw)
      switch (msg.type) {
        case 'spawned':
          agent.id = msg.id
          agent.avatar = msg.avatar
          console.log(`  -> ${msg.name} spawned (id: ${msg.id}, avatar: ${msg.avatar || 'default'})`)
          resolve(agent)
          break
        case 'chat':
          console.log(`  [chat] ${msg.from}: ${msg.body}`)
          break
        case 'avatar_library':
          console.log(`  [avatars] Available:`, msg.avatars.map(a => a.id).join(', '))
          break
        case 'error':
          console.error(`  [error] ${msg.code}: ${msg.message}`)
          if (!agent.id) reject(new Error(msg.message))
          break
        case 'kicked':
          console.log(`  [kicked] ${name} code=${msg.code}`)
          break
        case 'disconnected':
          console.log(`  [disconnected] ${name}`)
          break
      }
    })

    ws.on('error', (err) => {
      if (!agent.id) reject(err)
    })
  })
}

function sendCmd(agent, type, payload = {}) {
  agent.ws.send(JSON.stringify({ type, ...payload }))
}

function disconnect(agent) {
  return new Promise((resolve) => {
    agent.ws.on('close', resolve)
    agent.ws.close()
  })
}

async function main() {
  console.log('=== Agent Manager Demo (WebSocket + Avatars) ===\n')

  // List available avatars (using first agent's connection)
  console.log('Querying avatar library...')
  const listWs = new WebSocket(WS_URL)
  await new Promise((resolve) => {
    listWs.on('open', () => {
      listWs.send(JSON.stringify({ type: 'list_avatars' }))
    })
    listWs.on('message', (raw) => {
      const msg = JSON.parse(raw)
      if (msg.type === 'avatar_library') {
        console.log('  Available avatars:')
        for (const a of msg.avatars) {
          console.log(`    - ${a.id}: ${a.name} (${a.url})`)
        }
        resolve()
      }
    })
  })
  listWs.close()
  await sleep(500)

  // Spawn 3 agents — Alpha with external library avatar, Bravo with direct URL, Charlie with no avatar
  const agentConfigs = [
    { name: 'Alpha', avatar: 'library:devil' },
    { name: 'Bravo', avatar: 'library:rose' },
    { name: 'Charlie' },
  ]
  const agents = []

  for (const config of agentConfigs) {
    console.log(`\nJoining agent: ${config.name} (avatar: ${config.avatar || 'none specified'})...`)
    const agent = await createAgent(config.name, config.avatar)
    agents.push(agent)
  }

  await sleep(1000)

  // Have them chat
  console.log('\nAgents speaking...')
  sendCmd(agents[0], 'speak', { text: 'Hello from Alpha!' })
  await sleep(300)
  sendCmd(agents[1], 'speak', { text: 'Bravo here, reporting in.' })
  await sleep(300)
  sendCmd(agents[2], 'speak', { text: 'Charlie standing by.' })

  await sleep(1000)

  // Move them around
  console.log('\nAgents moving...')
  sendCmd(agents[0], 'move', { direction: 'forward', duration: 2000 })
  sendCmd(agents[1], 'move', { direction: 'left', duration: 1500 })
  sendCmd(agents[2], 'move', { direction: 'right', duration: 1500 })

  console.log('  Waiting for movement to complete...')
  await sleep(3000)

  // Disconnect all agents
  console.log('\nDisconnecting agents...')
  for (const agent of agents) {
    await disconnect(agent)
    console.log(`  -> ${agent.name} disconnected`)
  }

  console.log('\n=== Demo complete ===')
}

main().catch(err => {
  console.error('Demo failed:', err)
  process.exit(1)
})
