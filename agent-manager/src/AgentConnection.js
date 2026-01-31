import { randomUUID } from 'crypto'
import { createNodeClientWorld } from '../../hyperfy/build/world-node-client.js'

const round2 = (n) => Math.round(n * 100) / 100

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

export class AgentConnection {
  constructor(id, name, avatar) {
    this.id = id
    this.name = name
    this.avatar = avatar || null
    this.status = 'connecting'
    this.world = null
    this._moveTimers = []
    this._chatListener = null
    this._navInterval = null
    this._navResolve = null
    this._navReject = null
    this._navRunning = false
    this._currentStreamId = null
    this._audioSeq = 0
    this._playbackTimer = null
    this._playbackCleanup = null

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

  getPosition() {
    const player = this.world?.entities?.player
    if (!player) return null
    const p = player.base.position
    return { x: round2(p.x), y: round2(p.y), z: round2(p.z) }
  }

  getYaw() {
    const player = this.world?.entities?.player
    if (!player) return null
    const q = player.base.quaternion
    return round2(Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x)))
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
    this.cancelNavigation()
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

  move(direction, durationMs = 1000, run = false) {
    if (this.status !== 'connected') {
      throw new Error(`Agent is not connected (status: ${this.status})`)
    }
    this.cancelNavigation()
    const key = DIRECTION_KEYS[direction]
    if (!key) {
      throw new Error(`Invalid direction: ${direction}. Use: ${Object.keys(DIRECTION_KEYS).join(', ')}`)
    }
    if (run) this.world.controls.simulateButton('shiftLeft', true)
    this.world.controls.simulateButton(key, true)
    const timer = setTimeout(() => {
      this.world.controls.simulateButton(key, false)
      if (run) this.world.controls.simulateButton('shiftLeft', false)
      const idx = this._moveTimers.indexOf(timer)
      if (idx !== -1) this._moveTimers.splice(idx, 1)
    }, durationMs)
    this._moveTimers.push(timer)
  }

  navigateTo(targetX, targetZ, { arrivalRadius = 2.0, timeout = 30000, getTargetPos = null, run = false } = {}) {
    if (this.status !== 'connected') {
      return Promise.reject(new Error(`Agent is not connected (status: ${this.status})`))
    }
    // Cancel any existing navigation
    this.cancelNavigation()

    return new Promise((resolve) => {
      const startTime = Date.now()
      this._navResolve = resolve
      this._navRunning = run

      const tick = () => {
        const pos = this.getPosition()
        if (!pos) {
          this._cleanupNav()
          resolve({ arrived: false, position: null, distance: null, error: 'Lost position' })
          return
        }

        // If tracking an agent, update target each tick
        let tx = targetX
        let tz = targetZ
        if (getTargetPos) {
          const tp = getTargetPos()
          if (tp) {
            tx = tp.x
            tz = tp.z
          }
        }

        const dx = tx - pos.x
        const dz = tz - pos.z
        const distance = Math.sqrt(dx * dx + dz * dz)

        // Arrived?
        if (distance <= arrivalRadius) {
          // Stop moving
          this.world.controls.simulateButton('keyW', false)
          if (run) this.world.controls.simulateButton('shiftLeft', false)
          this.world.controls.simulateLook(null)
          this._cleanupNav()
          resolve({ arrived: true, position: pos, distance: round2(distance) })
          return
        }

        // Timeout?
        if (Date.now() - startTime > timeout) {
          this.world.controls.simulateButton('keyW', false)
          if (run) this.world.controls.simulateButton('shiftLeft', false)
          this.world.controls.simulateLook(null)
          this._cleanupNav()
          resolve({ arrived: false, position: pos, distance: round2(distance), error: 'Navigation timeout' })
          return
        }

        // Face toward target and walk/run forward
        const yaw = Math.atan2(-dx, -dz)
        this.world.controls.simulateLook(yaw)
        if (run) this.world.controls.simulateButton('shiftLeft', true)
        this.world.controls.simulateButton('keyW', true)
      }

      // Run first tick immediately, then every 200ms
      tick()
      this._navInterval = setInterval(tick, 200)
    })
  }

  cancelNavigation() {
    if (this._navInterval) {
      clearInterval(this._navInterval)
      this._navInterval = null
    }
    if (this._navResolve) {
      // Release W key, shift, and restore auto-face
      if (this.world && this.status === 'connected') {
        this.world.controls.simulateButton('keyW', false)
        if (this._navRunning) this.world.controls.simulateButton('shiftLeft', false)
        this.world.controls.simulateLook(null)
      }
      const resolve = this._navResolve
      this._navResolve = null
      this._navReject = null
      this._navRunning = false
      const pos = this.getPosition()
      resolve({ arrived: false, position: pos, distance: null, error: 'Cancelled' })
    }
  }

  _cleanupNav() {
    if (this._navInterval) {
      clearInterval(this._navInterval)
      this._navInterval = null
    }
    this._navResolve = null
    this._navReject = null
  }

  startAudioStream({ sampleRate = 24000, channels = 1, format = 's16' } = {}) {
    if (this.status !== 'connected') {
      throw new Error(`Agent is not connected (status: ${this.status})`)
    }
    if (this._currentStreamId) {
      throw new Error('Audio stream already active. Stop it first.')
    }
    if (format !== 'f32' && format !== 's16') {
      throw new Error(`Invalid format: ${format}. Use 'f32' or 's16'`)
    }
    if (channels !== 1 && channels !== 2) {
      throw new Error('Channels must be 1 or 2')
    }
    if (sampleRate < 8000 || sampleRate > 48000) {
      throw new Error('Sample rate must be between 8000 and 48000')
    }

    this._currentStreamId = randomUUID()
    this._audioSeq = 0

    this.world.network.send('audioStreamStart', {
      streamId: this._currentStreamId,
      playerId: this.getPlayerId(),
      sampleRate,
      channels,
      format,
    })

    return this._currentStreamId
  }

  pushAudioData(seq, samples) {
    if (!this._currentStreamId) return
    if (this.status !== 'connected') return

    const samplesArray = samples instanceof Uint8Array
      ? samples
      : new Uint8Array(samples.buffer || samples)

    this.world.network.send('audioStreamData', {
      streamId: this._currentStreamId,
      seq: seq !== undefined ? seq : this._audioSeq++,
      samples: samplesArray,
    })
  }

  stopAudioStream() {
    if (!this._currentStreamId) return

    if (this.status === 'connected') {
      this.world.network.send('audioStreamStop', {
        streamId: this._currentStreamId,
      })
    }

    this._currentStreamId = null
    this._audioSeq = 0
  }

  playAudio(pcmBuffer, { sampleRate = 24000, channels = 1, format = 's16' } = {}, onComplete) {
    if (this.status !== 'connected') {
      throw new Error(`Agent is not connected (status: ${this.status})`)
    }
    if (format !== 'f32' && format !== 's16') {
      throw new Error(`Invalid format: ${format}. Use 'f32' or 's16'`)
    }
    if (channels !== 1 && channels !== 2) {
      throw new Error('Channels must be 1 or 2')
    }
    if (sampleRate < 8000 || sampleRate > 48000) {
      throw new Error('Sample rate must be between 8000 and 48000')
    }

    // Validate max duration (30 seconds)
    const bytesPerSample = format === 'f32' ? 4 : 2
    const totalSamples = pcmBuffer.length / (bytesPerSample * channels)
    const durationSec = totalSamples / sampleRate
    if (durationSec > 30) {
      throw new Error(`Audio too long: ${durationSec.toFixed(1)}s exceeds 30s maximum`)
    }

    // Stop any existing stream or playback
    this._stopPlayback()
    this.stopAudioStream()

    // Start a stream
    const streamId = this.startAudioStream({ sampleRate, channels, format })

    // Chunk into 50ms pieces
    const chunkMs = 50
    const samplesPerChunk = Math.floor(sampleRate * chunkMs / 1000)
    const bytesPerChunk = samplesPerChunk * channels * bytesPerSample
    let offset = 0
    let seq = 0
    let nextTime = Date.now()

    const sendNext = () => {
      if (!this._currentStreamId || this._currentStreamId !== streamId) {
        // Stream was stopped externally
        if (onComplete) onComplete()
        return
      }
      if (this.status !== 'connected') {
        this._stopPlayback()
        if (onComplete) onComplete()
        return
      }

      if (offset >= pcmBuffer.length) {
        // All chunks sent — stop the stream
        this.stopAudioStream()
        this._playbackTimer = null
        this._playbackCleanup = null
        if (onComplete) onComplete()
        return
      }

      const end = Math.min(offset + bytesPerChunk, pcmBuffer.length)
      const chunk = pcmBuffer.slice(offset, end)
      this.pushAudioData(seq++, chunk)
      offset = end

      // Drift-correcting setTimeout
      nextTime += chunkMs
      const delay = Math.max(0, nextTime - Date.now())
      this._playbackTimer = setTimeout(sendNext, delay)
    }

    this._playbackCleanup = () => {
      if (this._currentStreamId === streamId) {
        this.stopAudioStream()
      }
    }

    // Send first chunk immediately
    nextTime = Date.now() + chunkMs
    sendNext()
    return streamId
  }

  _stopPlayback() {
    if (this._playbackTimer) {
      clearTimeout(this._playbackTimer)
      this._playbackTimer = null
    }
    if (this._playbackCleanup) {
      this._playbackCleanup()
      this._playbackCleanup = null
    }
  }

  disconnect() {
    this._stopPlayback()
    this.stopAudioStream()
    this.cancelNavigation()
    for (const timer of this._moveTimers) {
      clearTimeout(timer)
    }
    this._moveTimers = []
    // Release shift in case a run-move timer is still pending
    if (this.world && this.status === 'connected') {
      this.world.controls.simulateButton('shiftLeft', false)
    }
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
