import { createNodeClientWorld } from '../../hyperfy/build/world-node-client.js'

const DIRECTION_KEYS = {
  forward: 'keyW',
  backward: 'keyS',
  left: 'keyA',
  right: 'keyD',
  jump: 'space',
}

export class AgentConnection {
  constructor(id, name) {
    this.id = id
    this.name = name
    this.status = 'connecting'
    this.world = null
    this._moveTimers = []
  }

  connect(wsUrl) {
    return new Promise((resolve, reject) => {
      this.world = createNodeClientWorld()

      const timeout = setTimeout(() => {
        this.status = 'error'
        reject(new Error('Connection timed out'))
      }, 15000)

      this.world.once('ready', () => {
        clearTimeout(timeout)
        this.status = 'connected'
        resolve()
      })

      this.world.on('kick', (code) => {
        clearTimeout(timeout)
        this.status = 'kicked'
        console.log(`Agent ${this.name} (${this.id}) kicked: ${code}`)
      })

      this.world.on('disconnect', () => {
        clearTimeout(timeout)
        if (this.status !== 'disconnected') {
          this.status = 'disconnected'
          console.log(`Agent ${this.name} (${this.id}) disconnected`)
        }
      })

      this.world.init({
        wsUrl,
        name: this.name,
        authToken: null,
        skipStorage: true,
      })
    })
  }

  speak(text) {
    if (this.status !== 'connected') {
      throw new Error(`Agent is not connected (status: ${this.status})`)
    }
    this.world.chat.send(text)
  }

  move(direction, durationMs = 1000) {
    if (this.status !== 'connected') {
      throw new Error(`Agent is not connected (status: ${this.status})`)
    }
    const key = DIRECTION_KEYS[direction]
    if (!key) {
      throw new Error(`Invalid direction: ${direction}. Use: ${Object.keys(DIRECTION_KEYS).join(', ')}`)
    }
    this.world.controls.simulateButton(key, true)
    const timer = setTimeout(() => {
      this.world.controls.simulateButton(key, false)
      const idx = this._moveTimers.indexOf(timer)
      if (idx !== -1) this._moveTimers.splice(idx, 1)
    }, durationMs)
    this._moveTimers.push(timer)
  }

  disconnect() {
    for (const timer of this._moveTimers) {
      clearTimeout(timer)
    }
    this._moveTimers = []
    if (this.world) {
      this.status = 'disconnected'
      this.world.destroy()
      this.world = null
    }
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
    }
  }
}
