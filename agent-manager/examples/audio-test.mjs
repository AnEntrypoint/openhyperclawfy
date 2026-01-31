/**
 * Audio streaming test: spawns an agent, waits 3 seconds, then streams
 * a generated sine wave tone as spatial audio.
 *
 * If ffmpeg is available and an MP3 path is provided, it will decode and
 * stream that instead.
 *
 * Usage:
 *   node agent-manager/examples/audio-test.mjs
 *   node agent-manager/examples/audio-test.mjs path/to/file.mp3
 *
 * Prerequisites:
 *   - Hyperfy server running on port 4000
 *   - Agent manager running on port 5000
 *   - (optional) ffmpeg on PATH for MP3 playback
 */

import WebSocket from 'ws'
import { execSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WS_URL = process.env.AGENT_MANAGER_URL || 'ws://localhost:5000'

const SAMPLE_RATE = 24000
const CHANNELS = 1
const CHUNK_MS = 50
const CHUNK_SAMPLES = Math.floor(SAMPLE_RATE * CHUNK_MS / 1000)
const CHUNK_BYTES = CHUNK_SAMPLES * CHANNELS * 2 // s16le = 2 bytes/sample

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Generate a sine wave tone as PCM s16le
function generateSineWave(durationSec, frequencyHz = 440) {
  const totalSamples = SAMPLE_RATE * durationSec * CHANNELS
  const buf = Buffer.alloc(totalSamples * 2)
  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE
    // Fade in/out to avoid clicks
    const envelope = Math.min(1, t * 20, (durationSec - t) * 20)
    const sample = Math.sin(2 * Math.PI * frequencyHz * t) * 0.5 * envelope
    const int16 = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)))
    buf.writeInt16LE(int16, i * 2)
  }
  return buf
}

// Try to decode MP3 with ffmpeg
function tryDecodeMp3(filePath) {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' })
  } catch {
    return null
  }
  console.log('Decoding MP3 with ffmpeg...')
  const result = execSync(
    `ffmpeg -i "${filePath}" -f s16le -acodec pcm_s16le -ar ${SAMPLE_RATE} -ac ${CHANNELS} -`,
    { maxBuffer: 100 * 1024 * 1024 }
  )
  console.log(`Decoded: ${result.length} bytes (${(result.length / SAMPLE_RATE / CHANNELS / 2).toFixed(1)}s)`)
  return result
}

// Connect and spawn agent
function createAgent(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    const agent = { name, ws, id: null }

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'spawn', name }))
    })

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'spawned') {
        agent.id = msg.id
        console.log(`Agent "${msg.name}" spawned (id: ${msg.id})`)
        resolve(agent)
      } else if (msg.type === 'error') {
        console.error(`Error: ${msg.code} - ${msg.message}`)
        reject(new Error(msg.message))
      } else if (msg.type === 'audio_started') {
        console.log(`Audio stream started (streamId: ${msg.streamId})`)
      } else if (msg.type === 'audio_stopped') {
        console.log('Audio stream stopped')
      }
    })

    ws.on('error', reject)
    ws.on('close', () => console.log(`[${name}] disconnected`))
  })
}

// Stream PCM data using binary frames
async function streamAudio(agent, pcmData) {
  const ws = agent.ws

  // Start stream: binary cmd 0x01 + JSON payload
  const startJson = JSON.stringify({ sampleRate: SAMPLE_RATE, channels: CHANNELS, format: 's16' })
  const startBuf = Buffer.alloc(1 + Buffer.byteLength(startJson))
  startBuf[0] = 0x01
  startBuf.write(startJson, 1)
  ws.send(startBuf)

  const durationSec = (pcmData.length / SAMPLE_RATE / CHANNELS / 2).toFixed(1)
  console.log(`Streaming ${durationSec}s of audio in ${CHUNK_MS}ms chunks...`)

  let offset = 0
  let seq = 0

  while (offset < pcmData.length) {
    const end = Math.min(offset + CHUNK_BYTES, pcmData.length)
    const chunk = pcmData.slice(offset, end)

    // Binary cmd 0x02 + 4-byte LE uint32 seq + PCM samples
    const dataBuf = Buffer.alloc(1 + 4 + chunk.length)
    dataBuf[0] = 0x02
    dataBuf.writeUInt32LE(seq, 1)
    chunk.copy(dataBuf, 5)
    ws.send(dataBuf)

    offset = end
    seq++

    await sleep(CHUNK_MS)
  }

  // Stop stream: binary cmd 0x03
  ws.send(Buffer.from([0x03]))
  console.log(`Done. Sent ${seq} chunks.`)
}

// Main
async function main() {
  let pcmData
  const mp3Arg = process.argv[2]

  if (mp3Arg) {
    const mp3Path = path.resolve(mp3Arg)
    console.log(`MP3 file: ${mp3Path}`)
    pcmData = tryDecodeMp3(mp3Path)
    if (!pcmData) {
      console.log('ffmpeg not found - falling back to sine wave tone')
    }
  }

  if (!pcmData) {
    console.log('Generating 5-second 440Hz sine wave test tone...')
    pcmData = generateSineWave(5, 440)
  }

  console.log(`PCM: ${pcmData.length} bytes, ${SAMPLE_RATE}Hz, ${CHANNELS}ch, s16le`)

  const agent = await createAgent('AudioBot')

  console.log('Waiting 3 seconds before streaming...')
  await sleep(3000)

  await streamAudio(agent, pcmData)

  console.log('Waiting 2 seconds then disconnecting...')
  await sleep(2000)

  agent.ws.close()
  process.exit(0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
