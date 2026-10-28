// imagesize.js — read width/height from an image file by parsing its header.
//
// Real imageboards shell out to ImageMagick or link a native library like
// sharp. We want zero native dependencies, so we parse just enough of each
// format's header bytes ourselves. We only need the dimensions (for display),
// not decoding, so a few dozen bytes are enough. Returns {w, h} or null.

import { openSync, readSync, closeSync } from "node:fs";

function readHead(path, length) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

export function imageSize(path) {
  // Read a generous chunk; headers we care about live in the first few KB.
  const buf = readHead(path, 65536);
  if (buf.length < 24) return null;

  // PNG: 8-byte signature, then IHDR with width/height as big-endian uint32.
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  ) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }

  // GIF: "GIF87a"/"GIF89a", then logical screen width/height as LE uint16.
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }

  // JPEG: scan the marker segments for a Start-Of-Frame (SOFn) marker, whose
  // payload carries height then width as big-endian uint16.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = buf[off + 1];
      // SOF0..SOF15 except the DHT/DAC/RST markers.
      const isSOF =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc;
      if (isSOF) {
        return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
      }
      const segLen = buf.readUInt16BE(off + 2);
      off += 2 + segLen;
    }
    return null;
  }

  // WebP: "RIFF"...."WEBP", then a VP8/VP8L/VP8X chunk.
  if (
    buf.length >= 30 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    const fmt = buf.toString("ascii", 12, 16);
    if (fmt === "VP8 ") {
      // Lossy: 14-bit dimensions after a 3-byte start code at offset 23.
      const w = buf.readUInt16LE(26) & 0x3fff;
      const h = buf.readUInt16LE(28) & 0x3fff;
      return { w, h };
    }
    if (fmt === "VP8L") {
      // Lossless: dimensions packed into bits after the 0x2f signature byte.
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
      const w = 1 + (((b1 & 0x3f) << 8) | b0);
      const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { w, h };
    }
    if (fmt === "VP8X") {
      // Extended: 24-bit (minus one) canvas dimensions at offset 24.
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { w, h };
    }
  }

  return null;
}
