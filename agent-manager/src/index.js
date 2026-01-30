import Fastify from 'fastify'
import cors from '@fastify/cors'
import { nanoid } from 'nanoid'
import { AgentRegistry } from './AgentRegistry.js'
import { AgentConnection } from './AgentConnection.js'

const PORT = process.env.AGENT_MANAGER_PORT || 5000
const HYPERFY_WS_URL = process.env.HYPERFY_WS_URL || 'ws://localhost:4000/ws'

const registry = new AgentRegistry()

const fastify = Fastify({ logger: true })

await fastify.register(cors)

// POST /agents — connect a new agent
fastify.post('/agents', async (request, reply) => {
  const { name } = request.body || {}
  if (!name || typeof name !== 'string') {
    return reply.status(400).send({ error: 'name is required (string)' })
  }

  const id = nanoid(12)
  const agent = new AgentConnection(id, name)
  registry.add(id, agent)

  try {
    await agent.connect(HYPERFY_WS_URL)
    return { id: agent.id, name: agent.name, status: agent.status }
  } catch (err) {
    registry.remove(id)
    return reply.status(500).send({ error: `Failed to connect agent: ${err.message}` })
  }
})

// GET /agents — list all agents
fastify.get('/agents', async () => {
  return registry.list()
})

// GET /agents/:id — get one agent
fastify.get('/agents/:id', async (request, reply) => {
  const agent = registry.get(request.params.id)
  if (!agent) {
    return reply.status(404).send({ error: 'Agent not found' })
  }
  return agent.toJSON()
})

// DELETE /agents/:id — disconnect agent
fastify.delete('/agents/:id', async (request, reply) => {
  const agent = registry.get(request.params.id)
  if (!agent) {
    return reply.status(404).send({ error: 'Agent not found' })
  }
  agent.disconnect()
  registry.remove(request.params.id)
  return { id: request.params.id, status: 'disconnected' }
})

// POST /agents/:id/speak — send chat message
fastify.post('/agents/:id/speak', async (request, reply) => {
  const agent = registry.get(request.params.id)
  if (!agent) {
    return reply.status(404).send({ error: 'Agent not found' })
  }
  const { text } = request.body || {}
  if (!text || typeof text !== 'string') {
    return reply.status(400).send({ error: 'text is required (string)' })
  }
  try {
    agent.speak(text)
    return { id: agent.id, action: 'speak', text }
  } catch (err) {
    return reply.status(400).send({ error: err.message })
  }
})

// POST /agents/:id/move — move agent
fastify.post('/agents/:id/move', async (request, reply) => {
  const agent = registry.get(request.params.id)
  if (!agent) {
    return reply.status(404).send({ error: 'Agent not found' })
  }
  const { direction, duration } = request.body || {}
  if (!direction || typeof direction !== 'string') {
    return reply.status(400).send({ error: 'direction is required (forward, backward, left, right, jump)' })
  }
  const durationMs = typeof duration === 'number' ? duration : 1000
  try {
    agent.move(direction, durationMs)
    return { id: agent.id, action: 'move', direction, duration: durationMs }
  } catch (err) {
    return reply.status(400).send({ error: err.message })
  }
})

// Graceful shutdown
const shutdown = async () => {
  console.log('Shutting down agent-manager...')
  registry.disconnectAll()
  await fastify.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

try {
  await fastify.listen({ port: PORT, host: '0.0.0.0' })
  console.log(`Agent manager listening on port ${PORT}`)
  console.log(`Hyperfy WebSocket URL: ${HYPERFY_WS_URL}`)
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
