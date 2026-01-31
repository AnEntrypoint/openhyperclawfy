import * as THREE from '../extras/three'
import { System } from './System'

const v1 = new THREE.Vector3()
const v2 = new THREE.Vector3()
const q1 = new THREE.Quaternion()

/**
 * Client Audio Stream System
 *
 * Handles receiving and playing back agent audio streams with
 * spatial (HRTF) positioning. Mirrors the PlayerVoice pattern
 * from ClientLiveKit but sources audio from WebSocket PCM data
 * via an AudioWorklet ring buffer.
 */
export class ClientAudioStream extends System {
  constructor(world) {
    super(world)
    this.streams = new Map() // streamId -> AgentAudioStream
    this.workletReady = false
  }

  async init() {
    const ctx = this.world.audio?.ctx
    if (!ctx) return
    try {
      await ctx.audioWorklet.addModule('/agent-audio-stream-processor.js')
      this.workletReady = true
    } catch (err) {
      console.error('[audioStream] failed to load AudioWorklet:', err)
    }
  }

  handleStart(data) {
    console.log('[audioStream] handleStart', data.streamId, 'workletReady:', this.workletReady)
    if (!this.workletReady) {
      console.warn('[audioStream] worklet not ready, dropping stream')
      return
    }
    const { streamId, playerId, sampleRate, channels, format } = data
    if (this.streams.has(streamId)) return

    const player = this.world.entities.getPlayer(playerId)
    if (!player) {
      console.warn('[audioStream] player not found:', playerId)
      return
    }

    console.log(`[audioStream] creating stream: ${sampleRate}Hz ${channels}ch ${format} for player ${playerId}`)
    const stream = new AgentAudioStream(
      this.world, player, streamId, sampleRate, channels, format
    )
    this.streams.set(streamId, stream)
  }

  handleData(data) {
    const stream = this.streams.get(data.streamId)
    if (!stream) return
    stream.pushAudio(data.seq, data.samples)
  }

  handleStop(data) {
    console.log('[audioStream] handleStop', data.streamId)
    const stream = this.streams.get(data.streamId)
    if (!stream) return
    stream.destroy()
    this.streams.delete(data.streamId)
  }

  lateUpdate(delta) {
    for (const [, stream] of this.streams) {
      stream.updatePosition()
    }
  }

  destroy() {
    for (const [, stream] of this.streams) {
      stream.destroy()
    }
    this.streams.clear()
  }
}

/**
 * AgentAudioStream
 *
 * Per-stream audio playback with spatial positioning.
 * Audio chain: AudioWorkletNode → PannerNode → voice gain group
 *
 * PannerNode config matches PlayerVoice in ClientLiveKit exactly.
 */
class AgentAudioStream {
  constructor(world, player, streamId, sampleRate, channels, format) {
    this.world = world
    this.player = player
    this.streamId = streamId
    this.destroyed = false

    const ctx = world.audio.ctx

    this.workletNode = new AudioWorkletNode(ctx, 'agent-audio-stream-processor', {
      outputChannelCount: [channels],
      processorOptions: {
        sampleRate,
        channels,
        format,
        ringBufferSize: sampleRate * 2, // 2 seconds
      },
    })

    // spatial audio — matches PlayerVoice (ClientLiveKit.js:301-310) exactly
    this.panner = ctx.createPanner()
    this.panner.panningModel = 'HRTF'
    this.panner.distanceModel = 'inverse'
    this.panner.refDistance = 1
    this.panner.maxDistance = 40
    this.panner.rolloffFactor = 3
    this.panner.coneInnerAngle = 360
    this.panner.coneOuterAngle = 360
    this.panner.coneOuterGain = 0

    // connect: worklet → panner → voice gain group
    const voiceGain = world.audio.groupGains.voice
    this.workletNode.connect(this.panner)
    this.panner.connect(voiceGain)

    // set speaking indicator on the player nametag
    player.setSpeaking(true)
  }

  pushAudio(seq, samples) {
    if (this.destroyed) return
    // transfer the underlying ArrayBuffer to the worklet for zero-copy
    const buffer = samples.buffer.slice(
      samples.byteOffset,
      samples.byteOffset + samples.byteLength
    )
    this.workletNode.port.postMessage(
      { type: 'audio', seq, buffer },
      [buffer]
    )
  }

  updatePosition() {
    if (this.destroyed) return
    if (!this.player?.base?.matrixWorld) return

    const matrix = this.player.base.matrixWorld
    const pos = v1.setFromMatrixPosition(matrix)
    const qua = q1.setFromRotationMatrix(matrix)
    const dir = v2.set(0, 0, -1).applyQuaternion(qua)

    const audio = this.world.audio
    if (this.panner.positionX) {
      const endTime = audio.ctx.currentTime + audio.lastDelta
      this.panner.positionX.linearRampToValueAtTime(pos.x, endTime)
      this.panner.positionY.linearRampToValueAtTime(pos.y, endTime)
      this.panner.positionZ.linearRampToValueAtTime(pos.z, endTime)
      this.panner.orientationX.linearRampToValueAtTime(dir.x, endTime)
      this.panner.orientationY.linearRampToValueAtTime(dir.y, endTime)
      this.panner.orientationZ.linearRampToValueAtTime(dir.z, endTime)
    } else {
      this.panner.setPosition(pos.x, pos.y, pos.z)
      this.panner.setOrientation(dir.x, dir.y, dir.z)
    }
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true

    this.player?.setSpeaking(false)

    this.workletNode.port.postMessage({ type: 'stop' })
    this.workletNode.disconnect()
    this.panner.disconnect()
  }
}
