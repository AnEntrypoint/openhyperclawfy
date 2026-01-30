/**
 * Test script: connects as an agent with a specific avatar for 30 seconds.
 *
 * Usage:
 *   node agent-manager/examples/test-avatar.mjs
 */

import WebSocket from 'ws'

const WS_URL = process.env.AGENT_MANAGER_URL || 'ws://localhost:5000'
const CONNECT_DURATION = 30_000

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main() {
  console.log('=== VRM Avatar Test ===\n')

  // Step 1: Query avatar library
  console.log('1. Querying avatar library...')
  const avatars = await new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'list_avatars' }))
    })
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw)
      if (msg.type === 'avatar_library') {
        ws.close()
        resolve(msg.avatars)
      } else if (msg.type === 'error') {
        ws.close()
        reject(new Error(`${msg.code}: ${msg.message}`))
      }
    })
    ws.on('error', reject)
  })

  console.log(`   Found ${avatars.length} avatars:`)
  for (const a of avatars) {
    console.log(`     - ${a.id}: ${a.name} (${a.url})`)
  }

  // Step 2: Pick a random non-default avatar
  const choices = avatars.filter(a => a.id !== 'default')
  const pick = choices[Math.floor(Math.random() * choices.length)]
  console.log(`\n2. Selected avatar: "${pick.name}" (${pick.id})`)

  // Step 3: Spawn agent with chosen avatar
  console.log(`\n3. Spawning agent "AvatarTestBot" with avatar "${pick.id}"...`)
  const ws = new WebSocket(WS_URL)

  const agent = await new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'spawn',
        name: 'AvatarTestBot',
        avatar: `library:${pick.id}`,
      }))
    })

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw)
      switch (msg.type) {
        case 'spawned':
          console.log(`   Spawned! id=${msg.id}, avatar=${msg.avatar}`)
          resolve(msg)
          break
        case 'chat':
          console.log(`   [chat] ${msg.from}: ${msg.body}`)
          break
        case 'error':
          console.error(`   [error] ${msg.code}: ${msg.message}`)
          reject(new Error(msg.message))
          break
        case 'kicked':
          console.log(`   [kicked] code=${msg.code}`)
          break
        case 'disconnected':
          console.log(`   [disconnected]`)
          break
      }
    })

    ws.on('error', reject)
  })

  // Step 4: Stay connected for 30 seconds, wander + chat
  console.log(`\n4. Connected! Wandering for ${CONNECT_DURATION / 1000}s...`)
  ws.send(JSON.stringify({ type: 'wander', enabled: true }))

  // Say hello
  ws.send(JSON.stringify({ type: 'speak', text: `Hi! I'm ${pick.name}. Check out my avatar!` }))

  // Move around and chat periodically
  const chatInterval = setInterval(() => {
    const lines = [
      `I'm the ${pick.name} avatar!`,
      'Looking good?',
      'VRM avatars are working!',
      '*strikes a pose*',
      'Testing 1, 2, 3...',
    ]
    const line = lines[Math.floor(Math.random() * lines.length)]
    ws.send(JSON.stringify({ type: 'speak', text: line }))
  }, 8000)

  await sleep(CONNECT_DURATION)

  // Step 5: Disconnect
  clearInterval(chatInterval)
  console.log('\n5. Disconnecting...')
  ws.send(JSON.stringify({ type: 'wander', enabled: false }))

  await new Promise((resolve) => {
    ws.on('close', resolve)
    ws.close()
  })

  console.log('   Done!\n=== Test complete ===')
}

main().catch(err => {
  console.error('Test failed:', err.message)
  process.exit(1)
})
