/**
 * Demo script: spawns 3 agents, has them chat and move, then disconnects them.
 *
 * Usage:
 *   node agent-manager/examples/demo.mjs
 *
 * Prerequisites:
 *   - Hyperfy server running on port 4000
 *   - Agent manager running on port 5000
 */

const API = process.env.AGENT_MANAGER_URL || 'http://localhost:5000'

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${API}${path}`, opts)
  const data = await res.json()
  if (!res.ok) {
    throw new Error(`${method} ${path} failed (${res.status}): ${JSON.stringify(data)}`)
  }
  return data
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main() {
  console.log('=== Agent Manager Demo ===\n')

  // Spawn 3 agents
  const names = ['Alpha', 'Bravo', 'Charlie']
  const agents = []

  for (const name of names) {
    console.log(`Joining agent: ${name}...`)
    const agent = await api('POST', '/agents', { name })
    console.log(`  -> ${agent.name} joined (id: ${agent.id}, status: ${agent.status})`)
    agents.push(agent)
  }

  await sleep(1000)

  // List all agents
  console.log('\nConnected agents:')
  const list = await api('GET', '/agents')
  for (const a of list) {
    console.log(`  - ${a.name} (${a.id}): ${a.status}`)
  }

  await sleep(500)

  // Have them chat
  console.log('\nAgents speaking...')
  await api('POST', `/agents/${agents[0].id}/speak`, { text: 'Hello from Alpha!' })
  await sleep(300)
  await api('POST', `/agents/${agents[1].id}/speak`, { text: 'Bravo here, reporting in.' })
  await sleep(300)
  await api('POST', `/agents/${agents[2].id}/speak`, { text: 'Charlie standing by.' })

  await sleep(1000)

  // Move them around
  console.log('\nAgents moving...')
  await api('POST', `/agents/${agents[0].id}/move`, { direction: 'forward', duration: 2000 })
  await api('POST', `/agents/${agents[1].id}/move`, { direction: 'left', duration: 1500 })
  await api('POST', `/agents/${agents[2].id}/move`, { direction: 'right', duration: 1500 })

  console.log('  Waiting for movement to complete...')
  await sleep(3000)

  // Disconnect all agents
  console.log('\nDisconnecting agents...')
  for (const agent of agents) {
    const result = await api('DELETE', `/agents/${agent.id}`)
    console.log(`  -> ${agent.name} ${result.status}`)
  }

  console.log('\n=== Demo complete ===')
}

main().catch(err => {
  console.error('Demo failed:', err)
  process.exit(1)
})
