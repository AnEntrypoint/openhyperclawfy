/**
 * AudioWorklet processor for streaming agent audio.
 *
 * Receives PCM chunks via port.postMessage, buffers them in a ring buffer,
 * and outputs audio with jitter handling and basic resampling.
 */
class AgentAudioStreamProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const opts = options.processorOptions || {}
    this.sourceSampleRate = opts.sampleRate || 24000
    this.channels = opts.channels || 1
    this.format = opts.format || 's16'

    // Ring buffer — sized for 2 seconds at source sample rate
    const bufferSize = (opts.ringBufferSize || this.sourceSampleRate * 2) * this.channels
    this.ringBuffer = new Float32Array(bufferSize)
    this.writePos = 0
    this.readPos = 0
    this.buffered = 0
    this.stopped = false

    // Resampling ratio: source rate / output rate (sampleRate is global in worklet scope)
    this.resampleRatio = this.sourceSampleRate / sampleRate

    // Jitter buffer: accumulate this many samples before starting playback
    this.jitterThreshold = Math.floor(this.sourceSampleRate * 0.1) // 100ms
    this.playing = false

    this.port.onmessage = (e) => {
      const msg = e.data
      if (msg.type === 'audio') {
        this.enqueueAudio(msg.buffer)
      } else if (msg.type === 'stop') {
        this.stopped = true
      }
    }
  }

  enqueueAudio(arrayBuffer) {
    let floatSamples
    if (this.format === 'f32') {
      floatSamples = new Float32Array(arrayBuffer)
    } else {
      // s16 — convert to float32
      const int16 = new Int16Array(arrayBuffer)
      floatSamples = new Float32Array(int16.length)
      for (let i = 0; i < int16.length; i++) {
        floatSamples[i] = int16[i] / 32768
      }
    }

    const buf = this.ringBuffer
    const len = buf.length

    for (let i = 0; i < floatSamples.length; i++) {
      buf[this.writePos] = floatSamples[i]
      this.writePos = (this.writePos + 1) % len
    }
    this.buffered += floatSamples.length

    // cap buffered count to ring buffer length (overwrite scenario)
    if (this.buffered > len) {
      this.buffered = len
      // advance readPos to match — skip oldest data
      this.readPos = this.writePos
    }

    // start playing once we have enough buffered
    if (!this.playing && this.buffered >= this.jitterThreshold) {
      this.playing = true
    }
  }

  process(inputs, outputs) {
    if (this.stopped) return false

    const output = outputs[0]
    if (!output || output.length === 0) return true

    const outLen = output[0].length // typically 128 samples

    if (!this.playing) {
      // output silence while buffering
      for (let ch = 0; ch < output.length; ch++) {
        output[ch].fill(0)
      }
      return true
    }

    const buf = this.ringBuffer
    const bufLen = buf.length
    const ratio = this.resampleRatio
    const channels = this.channels

    // how many source samples we'll consume for this output block
    const sourceSamples = Math.floor(outLen * ratio)

    if (this.buffered < sourceSamples) {
      // underrun — output silence and re-enter buffering mode
      for (let ch = 0; ch < output.length; ch++) {
        output[ch].fill(0)
      }
      this.playing = false
      return true
    }

    if (channels === 1) {
      // mono — write to first output channel
      const channel = output[0]
      for (let i = 0; i < outLen; i++) {
        const srcIdx = Math.floor(i * ratio)
        const bufIdx = (this.readPos + srcIdx) % bufLen
        channel[i] = buf[bufIdx]
      }
      // if stereo output exists, copy mono to it
      if (output.length > 1) {
        output[1].set(channel)
      }
    } else {
      // interleaved stereo in ring buffer
      for (let i = 0; i < outLen; i++) {
        const srcFrame = Math.floor(i * ratio)
        for (let ch = 0; ch < Math.min(channels, output.length); ch++) {
          const bufIdx = (this.readPos + srcFrame * channels + ch) % bufLen
          output[ch][i] = buf[bufIdx]
        }
      }
    }

    this.readPos = (this.readPos + sourceSamples * channels) % bufLen
    this.buffered -= sourceSamples * channels

    if (this.buffered < 0) this.buffered = 0

    return true
  }
}

registerProcessor('agent-audio-stream-processor', AgentAudioStreamProcessor)
