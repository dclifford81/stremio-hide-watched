// Decoder for Stremio's watched-episodes bitfield (libraryItem.state.watched).
// Format: "{lastVideoId}:{lastLength}:{base64(zlib(bytes))}", bit i (LSB-first per byte)
// marks video i of the list the bitfield was serialized against.
// Mirrors github.com/Stremio/stremio-watched-bitfield.

const zlib = require('zlib')

function parse(serialized) {
  const parts = serialized.split(':')
  if (parts.length < 3) throw new Error('invalid watched field')
  const packed = parts.pop()
  const lastLength = parseInt(parts.pop(), 10)
  const lastVideoId = parts.join(':')
  const bytes = zlib.inflateSync(Buffer.from(packed, 'base64'))
  return { lastVideoId, lastLength, get: (i) => i >= 0 && ((bytes[i >> 3] || 0) & (1 << (i % 8))) !== 0 }
}

// Same semantics as stremio-core's WatchedBitField::construct_and_resize:
// videos may only have been shifted off the front or pushed to the back.
function watchedSet(serialized, videoIds) {
  const out = new Set()
  if (!serialized) return out
  let bf
  try { bf = parse(serialized) } catch { return out }
  const lastIdx = videoIds.indexOf(bf.lastVideoId)
  const offset = (bf.lastLength - 1) - lastIdx
  if (lastIdx === -1 || offset < 0) return out
  videoIds.forEach((id, i) => { if (bf.get(i + offset)) out.add(id) })
  return out
}

function serialize(videoIds, watched) {
  const bytes = Buffer.alloc(Math.ceil(videoIds.length / 8))
  videoIds.forEach((id, i) => { if (watched.has(id)) bytes[i >> 3] |= 1 << (i % 8) })
  return `${videoIds[videoIds.length - 1]}:${videoIds.length}:${zlib.deflateSync(bytes).toString('base64')}`
}

module.exports = { watchedSet, serialize }
