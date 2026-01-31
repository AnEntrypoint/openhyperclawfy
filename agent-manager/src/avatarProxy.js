const HYPERFY_API_URL = process.env.HYPERFY_API_URL || 'http://localhost:4000'
const MAX_VRM_UPLOAD_SIZE = parseInt(process.env.MAX_VRM_UPLOAD_SIZE || '25', 10) * 1024 * 1024

// Hostnames known to serve VRMs with permissive CORS headers
const CORS_SAFE_DOMAINS = new Set([
  'arweave.net',
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
])

// Also treat the Hyperfy server itself as CORS-safe
try {
  const hyperfyHost = new URL(HYPERFY_API_URL).hostname
  CORS_SAFE_DOMAINS.add(hyperfyHost)
} catch {
  // HYPERFY_API_URL wasn't a valid URL — the static entries still apply
}

// In-memory cache: externalURL → localURL
const proxyCache = new Map()

/**
 * Returns true if the avatar URL will load in the browser without CORS issues.
 * asset:// refs are always safe (Hyperfy resolves them internally).
 */
export function isCORSSafe(url) {
  if (!url || typeof url !== 'string') return true
  if (url.startsWith('asset://')) return true

  try {
    const hostname = new URL(url).hostname
    return CORS_SAFE_DOMAINS.has(hostname)
  } catch {
    // Unparseable URL — let it pass through; it will fail on its own
    return true
  }
}

/**
 * Download a VRM from an external URL, validate it, upload it to the Hyperfy
 * asset server, and return the local URL. Results are cached so the same
 * external URL is only proxied once per process lifetime.
 */
export async function proxyAvatar(url) {
  // Return cached result if we've already proxied this URL
  const cached = proxyCache.get(url)
  if (cached) return cached

  // 1. Download the VRM server-side (no CORS restrictions here)
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to download VRM: ${res.status} ${res.statusText}`)
  }

  const arrayBuf = await res.arrayBuffer()
  const buffer = Buffer.from(arrayBuf)

  // 2. Validate size
  if (buffer.length > MAX_VRM_UPLOAD_SIZE) {
    throw new Error(`VRM exceeds max size of ${MAX_VRM_UPLOAD_SIZE / (1024 * 1024)}MB`)
  }

  // 3. Validate GLB magic bytes (VRM is a GLB container)
  if (buffer.length < 12) {
    throw new Error('File too small to be a valid VRM')
  }
  const magic = buffer.readUInt32LE(0)
  if (magic !== 0x46546C67) { // 'glTF'
    throw new Error('Invalid VRM file: missing glTF magic bytes')
  }
  const version = buffer.readUInt32LE(4)
  if (version !== 2) {
    throw new Error('Invalid VRM file: must be glTF version 2')
  }

  // 4. Upload to Hyperfy's local asset server
  const boundary = '----VRMProxy' + Date.now()
  const filename = 'avatar.vrm'
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  const footer = `\r\n--${boundary}--\r\n`
  const body = Buffer.concat([Buffer.from(header), buffer, Buffer.from(footer)])

  const uploadRes = await fetch(`${HYPERFY_API_URL}/api/avatar/upload`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  })

  if (!uploadRes.ok) {
    const text = await uploadRes.text()
    throw new Error(`Hyperfy upload failed: ${uploadRes.status} ${text}`)
  }

  const result = await uploadRes.json()
  const localUrl = result.url

  // 5. Cache the mapping
  proxyCache.set(url, localUrl)
  console.log(`Avatar proxied: ${url} -> ${localUrl}`)

  return localUrl
}

export { CORS_SAFE_DOMAINS }
