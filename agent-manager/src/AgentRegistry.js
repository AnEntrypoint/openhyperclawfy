export class AgentRegistry {
  constructor() {
    this.agents = new Map()
  }

  add(id, agent) {
    this.agents.set(id, agent)
  }

  get(id) {
    return this.agents.get(id)
  }

  remove(id) {
    this.agents.delete(id)
  }

  has(id) {
    return this.agents.has(id)
  }

  list() {
    const result = []
    for (const [id, agent] of this.agents) {
      result.push({ id, name: agent.name, status: agent.status })
    }
    return result
  }

  size() {
    return this.agents.size
  }

  disconnectAll() {
    for (const [id, agent] of this.agents) {
      agent.disconnect()
    }
    this.agents.clear()
  }
}
