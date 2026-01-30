const ASSETS_BASE_URL = process.env.HYPERFY_ASSETS_BASE_URL || 'http://localhost:4000/assets'

export const avatarLibrary = [
  { id: 'default', name: 'Default Avatar', url: `${ASSETS_BASE_URL}/avatar.vrm` },
  { id: 'devil', name: 'Devil', url: 'https://arweave.net/gfVzs1oH_aPaHVxpQK86HT_rqzyrFPOUKUrDJ30yprs' },
  { id: 'polydancer', name: 'Polydancer', url: 'https://arweave.net/jPOg-G0MPH55ZQmamFhT9f8cHn-hjeAQ0mRO5gWeKMQ' },
  { id: 'rose', name: 'Rose', url: 'https://arweave.net/Ea1KXujzJatQgCFSMzGOzp_UtHqB1pyia--U3AtkMAY' },
  { id: 'rabbit', name: 'Rabbit', url: 'https://arweave.net/RymRtrmhHx_f9ZDvtvIQb1noTHvILdjoTg5G7L2DR-8' },
  { id: 'eggplant', name: 'Eggplant', url: 'https://arweave.net/64v_-jGcqFc4q_1ao0sjcXnhqkrtnjSSBotZoN2DDmc' },
]

/**
 * Resolve an avatar reference to a full URL.
 *
 * Supported formats:
 *   - Full URL: "https://..." or "http://..." — pass through
 *   - Asset protocol: "asset://..." — pass through (Hyperfy resolves internally)
 *   - Library ref: "library:<id>" or just "<id>" — resolve from avatarLibrary
 *
 * Returns null for unknown references.
 */
export function resolveAvatarRef(ref) {
  if (!ref || typeof ref !== 'string') return null

  // Full URL — pass through
  if (ref.startsWith('http://') || ref.startsWith('https://')) {
    return ref
  }

  // Asset protocol — pass through
  if (ref.startsWith('asset://')) {
    return ref
  }

  // Library reference — "library:<id>" or bare "<id>"
  const id = ref.startsWith('library:') ? ref.slice('library:'.length) : ref
  const entry = avatarLibrary.find(a => a.id === id)
  if (entry) {
    return entry.url
  }

  return null
}
