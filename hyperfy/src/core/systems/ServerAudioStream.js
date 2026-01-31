import { writePacket } from '../packets'
import { System } from './System'

const PROXIMITY_CHECK_RATE = 4 // Hz — how often to recheck for new/departed clients
const MAX_STREAMS_PER_PLAYER = 2
const STREAM_TIMEOUT = 10000 // ms — auto-end streams with no data

export class ServerAudioStream extends System {
  constructor(world) {
    super(world)
    this.streams = new Map() // streamId -> StreamState
    this.playerStreams = new Map() // playerId -> Set<streamId>
    this.listenerSets = new Map() // streamId -> Set<socketId>
    this.proximityTimer = 0
  }

  update(delta) {
    if (this.streams.size === 0) return

    this.proximityTimer += delta
    if (this.proximityTimer < 1 / PROXIMITY_CHECK_RATE) return
    this.proximityTimer = 0

    const now = performance.now()

    // collect timed-out streams first to avoid mutating during iteration
    const timedOut = []
    for (const [streamId, stream] of this.streams) {
      if (now - stream.lastDataAt > STREAM_TIMEOUT) {
        timedOut.push(streamId)
      }
    }
    for (const streamId of timedOut) {
      console.log(`[audioStream] stream ${streamId} timed out`)
      this.endStream(streamId)
    }

    for (const [streamId, stream] of this.streams) {
      // recompute listeners
      const newListeners = this.computeListeners(stream.playerId)
      const oldListeners = this.listenerSets.get(streamId)

      if (!oldListeners) {
        this.listenerSets.set(streamId, newListeners)
        continue
      }

      // players entering range — send audioStreamStart
      for (const socketId of newListeners) {
        if (!oldListeners.has(socketId)) {
          const socket = this.world.network.sockets.get(socketId)
          socket?.send('audioStreamStart', {
            streamId: stream.streamId,
            playerId: stream.playerId,
            sampleRate: stream.sampleRate,
            channels: stream.channels,
            format: stream.format,
          })
        }
      }

      // players leaving range — send audioStreamStop
      for (const socketId of oldListeners) {
        if (!newListeners.has(socketId)) {
          const socket = this.world.network.sockets.get(socketId)
          socket?.send('audioStreamStop', { streamId: stream.streamId })
        }
      }

      this.listenerSets.set(streamId, newListeners)
    }
  }

  handleStreamStart(socket, data) {
    const { streamId, sampleRate, channels, format } = data
    const playerId = socket.player?.data?.id
    if (!playerId) {
      console.log('[audioStream] handleStreamStart: no playerId on socket')
      return
    }

    // validate
    if (this.streams.has(streamId)) { console.log('[audioStream] duplicate streamId'); return }
    if (format !== 'f32' && format !== 's16') { console.log('[audioStream] invalid format:', format); return }
    if (channels !== 1 && channels !== 2) { console.log('[audioStream] invalid channels:', channels); return }
    if (sampleRate < 8000 || sampleRate > 48000) { console.log('[audioStream] invalid sampleRate:', sampleRate); return }

    // limit concurrent streams per player
    const playerSet = this.playerStreams.get(playerId) || new Set()
    if (playerSet.size >= MAX_STREAMS_PER_PLAYER) { console.log('[audioStream] max streams reached'); return }
    playerSet.add(streamId)
    this.playerStreams.set(playerId, playerSet)

    // create stream state
    const stream = {
      streamId,
      playerId,
      socketId: socket.id,
      sampleRate,
      channels,
      format,
      lastDataAt: performance.now(),
    }
    this.streams.set(streamId, stream)

    // compute initial listeners and send start packets
    const listeners = this.computeListeners(playerId)
    this.listenerSets.set(streamId, listeners)

    console.log(`[audioStream] stream started: ${streamId} from player ${playerId}, ${listeners.size} listener(s), ${sampleRate}Hz ${channels}ch ${format}`)

    const startPacket = writePacket('audioStreamStart', {
      streamId,
      playerId,
      sampleRate,
      channels,
      format,
    })
    for (const socketId of listeners) {
      const targetSocket = this.world.network.sockets.get(socketId)
      targetSocket?.sendPacket(startPacket)
    }
  }

  handleStreamData(socket, data) {
    const { streamId, seq, samples } = data
    const stream = this.streams.get(streamId)
    if (!stream) return
    if (stream.socketId !== socket.id) return // prevent spoofing

    stream.lastDataAt = performance.now()

    // forward to current listeners
    const listeners = this.listenerSets.get(streamId)
    if (!listeners || listeners.size === 0) return

    const dataPacket = writePacket('audioStreamData', { streamId, seq, samples })
    for (const socketId of listeners) {
      const targetSocket = this.world.network.sockets.get(socketId)
      targetSocket?.sendPacket(dataPacket)
    }
  }

  handleStreamStop(socket, data) {
    const { streamId } = data
    const stream = this.streams.get(streamId)
    if (!stream) return
    if (stream.socketId !== socket.id) return

    this.endStream(streamId)
  }

  endStream(streamId) {
    const stream = this.streams.get(streamId)
    if (!stream) return

    // notify all current listeners
    const listeners = this.listenerSets.get(streamId)
    if (listeners) {
      const stopPacket = writePacket('audioStreamStop', { streamId })
      for (const socketId of listeners) {
        const targetSocket = this.world.network.sockets.get(socketId)
        targetSocket?.sendPacket(stopPacket)
      }
    }

    // cleanup
    this.listenerSets.delete(streamId)
    this.streams.delete(streamId)
    const playerSet = this.playerStreams.get(stream.playerId)
    if (playerSet) {
      playerSet.delete(streamId)
      if (playerSet.size === 0) this.playerStreams.delete(stream.playerId)
    }
  }

  cleanupSocket(socketId) {
    // collect streams to end first to avoid mutating during iteration
    const toEnd = []
    for (const [streamId, stream] of this.streams) {
      if (stream.socketId === socketId) {
        toEnd.push(streamId)
      }
    }
    for (const streamId of toEnd) {
      this.endStream(streamId)
    }

    // remove this socket from all listener sets
    for (const [, listeners] of this.listenerSets) {
      listeners.delete(socketId)
    }
  }

  computeListeners(sourcePlayerId) {
    const listeners = new Set()
    for (const [socketId] of this.world.network.sockets) {
      if (socketId === sourcePlayerId) continue // don't send to self
      listeners.add(socketId)
    }
    return listeners
  }
}
