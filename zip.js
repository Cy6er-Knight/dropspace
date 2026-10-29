'use strict';
/*
 * A small zip writer for downloading several items at once.
 *
 * Files are stored as they are, without recompressing: photos, videos and 3D models are already
 * compressed, so this is fast and the zip opens anywhere (Finder, Windows, phones). Every size and
 * checksum is worked out before the first byte is sent, so the browser shows real progress, and
 * archives over 4 GB switch to the ZIP64 format on their own.
 */
const fs = require('fs');
const zlib = require('zlib');

const MAX32 = 0xffffffff;
const UTF8_NAMES = 0x0800;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/** CRC-32, continuing from `prev`. Uses Node's built-in version when it has one (Node 20.15+). */
function crc32(buf, prev = 0) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf, prev);
  let c = (prev ^ -1) | 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** CRC-32 of the first `size` bytes of a file. */
async function crcFile(abs, size) {
  let crc = 0;
  let seen = 0;
  if (size === 0) return 0;
  const stream = fs.createReadStream(abs, { start: 0, end: size - 1, highWaterMark: 1024 * 1024 });
  for await (const chunk of stream) {
    crc = crc32(chunk, crc);
    seen += chunk.length;
  }
  if (seen !== size) throw Object.assign(new Error('The file changed while it was being read.'), { code: 'ESHORT' });
  return crc;
}

/** Zip timestamps are in local time with 2-second steps, from 1980 on. */
function dosDateTime(ms) {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  const year = d.getFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.min(year, 2107) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Work out where everything goes. Each entry is { name, size, crc, mtime } plus either
 * `path` (a file to read) or `data` (a Buffer). Returns the plan and the exact total size.
 */
function planZip(entries, { forceZip64 = false } = {}) {
  let offset = 0;
  const planned = entries.map((e) => {
    const nameBuf = Buffer.from(e.name, 'utf8');
    if (nameBuf.length > 0xffff) throw new Error('Name too long for a zip');
    const localZip64 = forceZip64 || e.size >= MAX32;
    const needSize = localZip64;
    const needOffset = forceZip64 || offset >= MAX32;
    const p = {
      ...e,
      nameBuf,
      offset,
      localZip64,
      needSize,
      needOffset,
      version: localZip64 || needOffset ? 45 : 20,
      localLen: 30 + nameBuf.length + (localZip64 ? 20 : 0),
      cdExtraLen: needSize || needOffset ? 4 + (needSize ? 16 : 0) + (needOffset ? 8 : 0) : 0,
      ...dosDateTime(e.mtime),
    };
    offset += p.localLen + e.size;
    return p;
  });
  const cdStart = offset;
  const cdLen = planned.reduce((n, p) => n + 46 + p.nameBuf.length + p.cdExtraLen, 0);
  const zip64End = forceZip64 || planned.length >= 0xffff || cdStart >= MAX32 || cdLen >= MAX32;
  const total = cdStart + cdLen + (zip64End ? 56 + 20 : 0) + 22;
  return { entries: planned, cdStart, cdLen, zip64End, total };
}

function localHeader(p) {
  const b = Buffer.alloc(p.localLen);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(p.version, 4);
  b.writeUInt16LE(UTF8_NAMES, 6);
  b.writeUInt16LE(0, 8); // stored
  b.writeUInt16LE(p.time, 10);
  b.writeUInt16LE(p.date, 12);
  b.writeUInt32LE(p.crc >>> 0, 14);
  b.writeUInt32LE(p.localZip64 ? MAX32 : p.size, 18);
  b.writeUInt32LE(p.localZip64 ? MAX32 : p.size, 22);
  b.writeUInt16LE(p.nameBuf.length, 26);
  b.writeUInt16LE(p.localZip64 ? 20 : 0, 28);
  p.nameBuf.copy(b, 30);
  if (p.localZip64) {
    const o = 30 + p.nameBuf.length;
    b.writeUInt16LE(0x0001, o);
    b.writeUInt16LE(16, o + 2);
    b.writeBigUInt64LE(BigInt(p.size), o + 4);
    b.writeBigUInt64LE(BigInt(p.size), o + 12);
  }
  return b;
}

function centralHeader(p) {
  const b = Buffer.alloc(46 + p.nameBuf.length + p.cdExtraLen);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE((3 << 8) | p.version, 4); // made on Unix, so file permissions are kept
  b.writeUInt16LE(p.version, 6);
  b.writeUInt16LE(UTF8_NAMES, 8);
  b.writeUInt16LE(0, 10);
  b.writeUInt16LE(p.time, 12);
  b.writeUInt16LE(p.date, 14);
  b.writeUInt32LE(p.crc >>> 0, 16);
  b.writeUInt32LE(p.needSize ? MAX32 : p.size, 20);
  b.writeUInt32LE(p.needSize ? MAX32 : p.size, 24);
  b.writeUInt16LE(p.nameBuf.length, 28);
  b.writeUInt16LE(p.cdExtraLen, 30);
  b.writeUInt16LE(0, 32);
  b.writeUInt16LE(0, 34);
  b.writeUInt16LE(0, 36);
  b.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  b.writeUInt32LE(p.needOffset ? MAX32 : p.offset, 42);
  p.nameBuf.copy(b, 46);
  if (p.cdExtraLen) {
    let o = 46 + p.nameBuf.length;
    b.writeUInt16LE(0x0001, o);
    b.writeUInt16LE(p.cdExtraLen - 4, o + 2);
    o += 4;
    if (p.needSize) {
      b.writeBigUInt64LE(BigInt(p.size), o);
      b.writeBigUInt64LE(BigInt(p.size), o + 8);
      o += 16;
    }
    if (p.needOffset) b.writeBigUInt64LE(BigInt(p.offset), o);
  }
  return b;
}

function endRecords(plan) {
  const n = plan.entries.length;
  const parts = [];
  if (plan.zip64End) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeUInt16LE((3 << 8) | 45, 12);
    z.writeUInt16LE(45, 14);
    z.writeUInt32LE(0, 16);
    z.writeUInt32LE(0, 20);
    z.writeBigUInt64LE(BigInt(n), 24);
    z.writeBigUInt64LE(BigInt(n), 32);
    z.writeBigUInt64LE(BigInt(plan.cdLen), 40);
    z.writeBigUInt64LE(BigInt(plan.cdStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeUInt32LE(0, 4);
    loc.writeBigUInt64LE(BigInt(plan.cdStart + plan.cdLen), 8);
    loc.writeUInt32LE(1, 16);
    parts.push(z, loc);
  }
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(0, 4);
  e.writeUInt16LE(0, 6);
  e.writeUInt16LE(plan.zip64End ? 0xffff : n, 8);
  e.writeUInt16LE(plan.zip64End ? 0xffff : n, 10);
  e.writeUInt32LE(plan.zip64End ? MAX32 : plan.cdLen, 12);
  e.writeUInt32LE(plan.zip64End ? MAX32 : plan.cdStart, 16);
  e.writeUInt16LE(0, 20);
  parts.push(e);
  return Buffer.concat(parts);
}

/** Write respecting backpressure; rejects if the other side went away. */
function write(out, buf) {
  if (out.destroyed || out.writableEnded) return Promise.reject(Object.assign(new Error('closed'), { code: 'ECONNRESET' }));
  if (out.write(buf)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = (err) => {
      out.off('drain', onDrain);
      out.off('close', onClose);
      if (err) reject(err);
      else resolve();
    };
    const onDrain = () => done();
    const onClose = () => done(Object.assign(new Error('closed'), { code: 'ECONNRESET' }));
    out.on('drain', onDrain);
    out.on('close', onClose);
  });
}

/** Stream a planned zip to `out` (an HTTP response or any writable). Does not end `out`. */
async function writeZip(out, plan) {
  for (const p of plan.entries) {
    await write(out, localHeader(p));
    if (p.data) {
      await write(out, p.data);
      continue;
    }
    if (!p.size) continue;
    let sent = 0;
    const stream = fs.createReadStream(p.path, { start: 0, end: p.size - 1, highWaterMark: 256 * 1024 });
    try {
      for await (const chunk of stream) {
        sent += chunk.length;
        await write(out, chunk);
      }
    } finally {
      stream.destroy();
    }
    if (sent !== p.size) throw Object.assign(new Error(`${p.name} changed while it was being zipped.`), { code: 'ESHORT' });
  }
  for (const p of plan.entries) await write(out, centralHeader(p));
  await write(out, endRecords(plan));
}

module.exports = { crc32, crcFile, planZip, writeZip, dosDateTime };
