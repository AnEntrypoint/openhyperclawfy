import { createNodeClientWorld } from '../../hyperfy/build/world-node-client.js'

const DIRECTION_KEYS = {
  forward: 'keyW',
  backward: 'keyS',
  left: 'keyA',
  right: 'keyD',
  jump: 'space',
}

const DIRECTION_YAWS = {
  forward: 0,
  backward: Math.PI,
  left: Math.PI / 2,
  right: -Math.PI / 2,
}

const WANDER_DIRECTIONS = ['forward', 'backward', 'left', 'right']

const CHAT_LINES = [
  'nice day for a walk',
  'anyone else here?',
  'just vibing',
  'whoa, what is this place',
  'brb',
  'lol',
  'hm',
  '...',
  'i like it here',
  'where am i going',
  'wait up',
  'yo',
  'this is chill',
  'sup',
  'o/',
]

export class AgentConnection {
  constructor(id, name, avatar) {
    this.id = id
    this.name = name
    this.avatar = avatar || null
    this.status = 'connecting'
    this.world = null
    this._moveTimers = []
    this._wanderTimer = null
    this._wandering = false
    this._chatTimer = null
    this._chatting = false
    this._chatListener = null

    // Callback hooks — set by the WS session handler before connect()
    this.onWorldChat = null
    this.onKick = null
    this.onDisconnect = null
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

        // Subscribe to world chat events
        this._chatListener = (msg) => {
          if (this.onWorldChat) this.onWorldChat(msg)
        }
        this.world.events.on('chat', this._chatListener)

        resolve()
      })

      this.world.on('kick', (code) => {
        clearTimeout(timeout)
        this.status = 'kicked'
        console.log(`Agent ${this.name} (${this.id}) kicked: ${code}`)
        if (this.onKick) this.onKick(code)
      })

      this.world.on('disconnect', () => {
        clearTimeout(timeout)
        if (this.status !== 'disconnected') {
          this.status = 'disconnected'
          console.log(`Agent ${this.name} (${this.id}) disconnected`)
          if (this.onDisconnect) this.onDisconnect()
        }
      })

      this.world.init({
        wsUrl,
        name: this.name,
        avatar: this.avatar,
        authToken: null,
        skipStorage: true,
      })
    })
  }

  getPlayerId() {
    return this.world?.network?.id ?? null
  }

  speak(text) {
    if (this.status !== 'connected') {
      throw new Error(`Agent is not connected (status: ${this.status})`)
    }
    this.world.chat.send(text)
  }

  face(yawOrDirection) {
    if (this.status !== 'connected') {
      throw new Error(`Agent is not connected (status: ${this.status})`)
    }
    if (typeof yawOrDirection === 'number') {
      this.world.controls.simulateLook(yawOrDirection)
    } else if (typeof yawOrDirection === 'string') {
      const yaw = DIRECTION_YAWS[yawOrDirection]
      if (yaw === undefined) {
        throw new Error(`Invalid direction: ${yawOrDirection}. Use: ${Object.keys(DIRECTION_YAWS).join(', ')} or a number (radians)`)
      }
      this.world.controls.simulateLook(yaw)
    } else if (yawOrDirection === null) {
      // clear explicit look — reverts to auto-face movement direction
      this.world.controls.simulateLook(null)
    }
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

  startWander() {
    if (this._wandering) return
    this._wandering = true
    this._wanderLoop()
  }

  stopWander() {
    this._wandering = false
    if (this._wanderTimer) {
      clearTimeout(this._wanderTimer)
      this._wanderTimer = null
    }
  }

  _wanderLoop() {
    if (!this._wandering || this.status !== 'connected') return

    // Pick a random direction and walk for 500-2000ms
    const dir = WANDER_DIRECTIONS[Math.floor(Math.random() * WANDER_DIRECTIONS.length)]
    const walkDuration = 500 + Math.floor(Math.random() * 1500)
    // Pause 500-2500ms between moves
    const pauseDuration = 500 + Math.floor(Math.random() * 2000)

    // Occasionally jump
    if (Math.random() < 0.15) {
      this.move('jump', 200)
    }

    this.move(dir, walkDuration)

    this._wanderTimer = setTimeout(() => {
      this._wanderLoop()
    }, walkDuration + pauseDuration)
  }

  startChat() {
    if (this._chatting) return
    this._chatting = true
    this._chatLoop()
  }

  stopChat() {
    this._chatting = false
    if (this._chatTimer) {
      clearTimeout(this._chatTimer)
      this._chatTimer = null
    }
  }

  _chatLoop() {
    if (!this._chatting || this.status !== 'connected') return
    // Say something every 15-45 seconds
    const delay = 15000 + Math.floor(Math.random() * 30000)
    this._chatTimer = setTimeout(() => {
      if (!this._chatting || this.status !== 'connected') return
      const line = CHAT_LINES[Math.floor(Math.random() * CHAT_LINES.length)]
      this.speak(line)
      this._chatLoop()
    }, delay)
  }

  disconnect() {
    this.stopWander()
    this.stopChat()
    for (const timer of this._moveTimers) {
      clearTimeout(timer)
    }
    this._moveTimers = []
    if (this.world) {
      if (this._chatListener) {
        this.world.events.off('chat', this._chatListener)
        this._chatListener = null
      }
      this.status = 'disconnected'
      this.world.destroy()
      this.world = null
    }
    this.onWorldChat = null
    this.onKick = null
    this.onDisconnect = null
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      avatar: this.avatar,
      status: this.status,
    }
  }
}
