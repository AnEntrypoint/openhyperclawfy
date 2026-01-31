/**
 * Test: 100-agent cap
 *
 * Spawns 100 agents via HTTP, verifies the 101st is rejected with 503,
 * despawns all, then confirms spawning works again.
 *
 * Usage:
 *   node agent-manager/examples/test-agent-limit.mjs
 *
 * Prerequisites:
 *   - Hyperfy server running on port 4000
 *   - Agent manager running on port 5000
 */

const BASE = process.env.AGENT_MANAGER_URL || 'http://localhost:5000'
const BATCH = 10 // concurrent spawns per batch

// ── helpers ──────────────────────────────────────────────────────────────────

async function spawn(name) {
  const res = await fetch(`${BASE}/api/spawn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  const body = await res.json()
  return { status: res.status, body }
}

async function despawn(id, token) {
  const res = await fetch(`${BASE}/api/agents/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  return res.status
}

async function health() {
  const res = await fetch(`${BASE}/health`)
  return res.json()
}

function assert(cond, msg) {
  if (!cond) { throw new Error(`FAIL: ${msg}`) }
}

// ── test ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Agent limit test ===\n')

  // 1. Health check
  const h = await health()
  console.log(`Health: ${JSON.stringify(h)}`)
  assert(h.maxAgents === 100, `expected maxAgents=100, got ${h.maxAgents}`)
  const preExisting = h.agents
  console.log(`Pre-existing agents: ${preExisting}`)

  const toSpawn = 100 - preExisting
  assert(toSpawn > 0, `already at or above cap (${preExisting} agents)`)

  // 2. Spawn agents in batches
  const agents = [] // { id, token }
  console.log(`\nSpawning ${toSpawn} agents (batches of ${BATCH})...`)

  for (let i = 0; i < toSpawn; i += BATCH) {
    const batch = []
    const end = Math.min(i + BATCH, toSpawn)
    for (let j = i; j < end; j++) {
      batch.push(spawn(`bot-${j}`))
    }
    const results = await Promise.all(batch)
    for (const r of results) {
      assert(r.status === 201, `spawn failed: ${r.status} ${JSON.stringify(r.body)}`)
      agents.push({ id: r.body.id, token: r.body.token })
    }
    process.stdout.write(`  ${agents.length}/${toSpawn}\r`)
  }
  console.log(`  ${agents.length} agents spawned ✓`)

  // 3. Verify at capacity
  const h2 = await health()
  console.log(`\nHealth at cap: agents=${h2.agents}, maxAgents=${h2.maxAgents}`)
  assert(h2.agents === 100, `expected 100 agents, got ${h2.agents}`)

  // 4. 101st spawn must fail
  console.log('\nAttempting spawn #101...')
  const overflow = await spawn('overflow')
  console.log(`  Status: ${overflow.status}, error: ${overflow.body.error}`)
  assert(overflow.status === 503, `expected 503, got ${overflow.status}`)
  assert(overflow.body.error === 'AGENT_LIMIT', `expected AGENT_LIMIT, got ${overflow.body.error}`)
  console.log('  Correctly rejected ✓')

  // 5. Despawn all
  console.log(`\nDespawning ${agents.length} agents (batches of ${BATCH})...`)
  for (let i = 0; i < agents.length; i += BATCH) {
    const batch = agents.slice(i, i + BATCH).map(a => despawn(a.id, a.token))
    const statuses = await Promise.all(batch)
    for (const s of statuses) {
      assert(s === 200, `despawn failed: ${s}`)
    }
    process.stdout.write(`  ${Math.min(i + BATCH, agents.length)}/${agents.length}\r`)
  }
  console.log(`  ${agents.length} agents despawned ✓`)

  // 6. Verify spawning works again
  const h3 = await health()
  console.log(`\nHealth after cleanup: agents=${h3.agents}`)
  assert(h3.agents === preExisting, `expected ${preExisting}, got ${h3.agents}`)

  console.log('\nSpawning one more to confirm recovery...')
  const recovery = await spawn('recovery')
  assert(recovery.status === 201, `expected 201, got ${recovery.status}`)
  console.log(`  Spawned ${recovery.body.displayName} ✓`)
  await despawn(recovery.body.id, recovery.body.token)
  console.log('  Despawned ✓')

  console.log('\n=== All checks passed ===')
}

main().catch(err => {
  console.error(`\n${err.message}`)
  process.exit(1)
})
