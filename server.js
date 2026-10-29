#!/usr/bin/env node
/*
 * Dropspace — drag something onto one computer, it shows up on the other.
 *
 * Run this on one computer. Every other computer (or phone) on the same
 * Wi-Fi opens the address it prints, enters the pairing code once, and
 * from then on anything dropped onto the page appears on every device
 * and is saved into one folder on this computer.
 *
 * No dependencies beyond Node.js 18+.
 */
'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const { execFile, execFileSync, spawn } = require('child_process');
const dns = require('dns');

const PKG = require('./package.json');
const VERSION = PKG.version;
const AUTHOR = String(PKG.author || '').replace(/\s*[<(].*$/, '').trim();
const { readMacClipboard } = require('./clipboard.js');
const { crc32, crcFile, planZip, writeZip } = require('./zip.js');
const { ensureCertificates, mobileConfig, fromPem } = require('./tls.js');
const { MultipartParser, boundaryOf } = require('./multipart.js');
const shortcut = require('./shortcut.js');
const PUBLIC_DIR = path.join(__dirname, 'public');

const DEFAULT_PORT = 8765;
// On a Mac, Dropspace advertises this name on the Wi-Fi so its address never changes.
const NICE_HOST = 'dropspace.local';
const MAX_UPLOAD_BYTES = 20 * 1024 ** 3; // 20 GB per file
const MAX_TEXT_BYTES = 1024 * 1024; // 1 MB per note
const MAX_ITEMS = 300; // items kept per folder
const MAX_SPACES = 50;
const DEFAULT_SPACE_NAME = 'General';
const DEFAULT_ROOT = () => path.join(os.homedir(), 'Downloads', 'Dropspace');
const MAX_FOLDER_LIST = 500; // files listed per folder card
const PIN_WINDOW_MS = 5 * 60 * 1000;
const PIN_MAX_FAILS_PER_IP = 5;
const PIN_MAX_FAILS_TOTAL = 30;
const PAIR_TOKEN_TTL_MS = 10 * 60 * 1000;
const ZIP_TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_SHARE_KEYS = 20;
const COOKIE = 'dropspace_session';
const SHORTCUT_FILE = 'Send to Dropspace.shortcut';

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', heic: 'image/heic',
  heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  json: 'application/json', csv: 'text/csv; charset=utf-8', html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'model/obj', stl: 'model/stl',
};
const KIND = {};
for (const e of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'heic', 'heif', 'tif', 'tiff']) KIND[e] = 'image';
for (const e of ['mp4', 'm4v', 'mov', 'webm']) KIND[e] = 'video';
for (const e of ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']) KIND[e] = 'audio';

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/favicon.ico': ['icon.svg', 'image/svg+xml'],
  '/vendor/qrcode.js': ['vendor/qrcode.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
};

// extraImg: the permanent address and the secure address, so the page can check it can reach them before moving.
const pageCsp = (extraImg = []) => [
  "default-src 'self'", ["img-src 'self' blob: data:", ...extraImg.filter(Boolean)].join(' '), "media-src 'self' blob:", "style-src 'self'",
  "script-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'",
  "form-action 'self'", "frame-ancestors 'none'", "manifest-src 'self'",
].join('; ');
// User files are served with no ability to run scripts, even if someone drops an .svg or .html.
const FILE_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox";

/* ------------------------------------------------------------------ helpers */

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function displayPath(p) {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

function extOf(name) {
  return path.extname(name).slice(1).toLowerCase();
}
function mimeOf(name) {
  return MIME[extOf(name)] || 'application/octet-stream';
}
function kindOf(name) {
  return KIND[extOf(name)] || 'file';
}

function newId() {
  return crypto.randomBytes(12).toString('base64url');
}

function newPin() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function quiet() {}

function runQuiet(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** "Ansar's MacBook Pro" on a Mac, a tidied hostname elsewhere. */
function computerName() {
  if (process.platform === 'darwin') {
    const name = runQuiet('scutil', ['--get', 'ComputerName']);
    if (name) return name;
  }
  const h = os.hostname().replace(/\.(local|lan|home)$/i, '').replace(/[-_]+/g, ' ').trim();
  return h || 'This computer';
}

/** Bonjour name, e.g. "Ansars-MacBook-Pro.local", which works on any Mac on the network. */
function bonjourName() {
  if (process.platform === 'darwin') {
    const n = runQuiet('scutil', ['--get', 'LocalHostName']);
    if (n) return `${n}.local`;
  }
  const h = os.hostname();
  return /\.local$/i.test(h) ? h : '';
}

function lanAddresses() {
  const found = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal || a.address.startsWith('169.254.')) continue;
      found.push({ iface, address: a.address });
    }
  }
  const score = ({ iface, address }) =>
    (/^(en|eth|wlan|wl|wi-?fi)/i.test(iface) ? 0 : 2) +
    (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address) ? 0 : 1) +
    (/^(utun|bridge|docker|br-|veth|vmnet|vboxnet|tailscale|zt|awdl|llw)/i.test(iface) ? 10 : 0);
  return found.sort((a, b) => score(a) - score(b)).map((a) => a.address);
}

function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string' || !hostHeader) return null;
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(1, end) : null;
  }
  return h.replace(/:\d+$/, '');
}

/**
 * Only answer to names that can only mean "this computer on this network".
 * This blocks DNS-rebinding, where a website points its own domain name at
 * your local network to sneak requests in.
 */
function hostAllowed(hostHeader, extra) {
  const h = hostnameOf(hostHeader);
  if (!h) return false;
  if (h === 'localhost' || net.isIP(h)) return true;
  if (/\.(local|lan|home|internal|home\.arpa)$/.test(h)) return true;
  if (h === os.hostname().toLowerCase()) return true;
  return extra.includes(h);
}

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function clientIp(req) {
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function headerText(req, name) {
  const v = req.headers[name];
  if (typeof v !== 'string') return '';
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function cleanDeviceId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(v) ? v : '';
}

function cleanDeviceName(v) {
  if (typeof v !== 'string') return '';
  return Array.from(v.replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, 60).join('');
}

/** Folder names as people see them in Dropspace: trimmed, single-spaced, up to 40 characters. */
function cleanSpaceName(v) {
  if (typeof v !== 'string') return '';
  return Array.from(v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()).slice(0, 40).join('').trim();
}

/** Turn whatever name a browser sent into a safe single file name. */
function safeName(name, fallback = 'file') {
  let n = String(name || '').normalize('NFC');
  n = n.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[/\\:*?"<>|]/g, '_');
  n = n.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!n) n = fallback;
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = '_' + n;
  if (Buffer.byteLength(n) > 200) {
    const ext = path.extname(n).slice(0, 16);
    let base = Array.from(n.slice(0, n.length - path.extname(n).length));
    while (base.length && Buffer.byteLength(base.join('') + ext) > 200) base.pop();
    n = (base.join('') || fallback) + ext;
  }
  return n;
}

/** "textures/../../etc" becomes ["textures", "etc"]: no way out of the folder. */
function safeRelSegments(rel) {
  return String(rel || '')
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..')
    .slice(0, 16)
    .map((s) => safeName(s, '_'));
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function contentDisposition(type, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const EXT_FOR_TYPE = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/tiff': 'tiff', 'video/quicktime': 'mov', 'video/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'application/pdf': 'pdf', 'application/zip': 'zip', 'text/plain': 'txt', 'model/gltf-binary': 'glb',
};

/** "2026-10-26 at 14.03.22", like the Mac names screenshots. */
function stampNow(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

/** A file name for something shared from a phone, adding the extension its type implies. */
function sharedFileName(name, contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  const ext = EXT_FOR_TYPE[type];
  let n = safeName(name || '', '');
  if (!n) {
    const what = type.startsWith('image/') ? 'photo' : type.startsWith('video/') ? 'video' : 'file';
    return `Shared ${what} ${stampNow()}${ext ? `.${ext}` : ''}`;
  }
  if (ext && !/\.[a-z][a-z0-9]{0,6}$/i.test(n)) n += `.${ext}`;
  return safeName(n, 'file');
}

/** A note's file name inside a zip: its first sentence, or first few words. */
function noteFileName(text) {
  const t = String(text || '').trim();
  if (/^https?:\/\/\S+$/i.test(t)) return 'Link.txt';
  const sentence = (t.split('\n')[0] || '').replace(/https?:\/\/\S+/g, '').split(/(?<=[.!?])\s/)[0];
  const words = sentence.split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
  return `${safeName(Array.from(words).slice(0, 48).join('').replace(/[.,;:!?]+$/, ''), 'Note')}.txt`;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        reject(httpError(413, 'That is too large to send as text. Drop it as a file instead.'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => {
      if (!done) reject(e);
    });
  });
}

async function readJson(req, limit = 64 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw httpError(400, 'Invalid JSON');
  }
}

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function openInBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  execFile(cmd, args, () => {});
}

function openWithDefaultApp(target) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [target]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]]
        : ['xdg-open', [target]];
  execFile(cmd, args, () => {});
}

function dropspaceHome(opts = {}) {
  return path.resolve(expandHome(opts.home || process.env.DROPSPACE_HOME || path.join(os.homedir(), '.dropspace')));
}

/** If Dropspace is already running for this user, resolve with its port. */
async function findRunning(home) {
  let status;
  try {
    status = JSON.parse(await fsp.readFile(path.join(home, 'status.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!status || !Number.isInteger(status.pid) || !Number.isInteger(status.port)) return null;
  try {
    process.kill(status.pid, 0);
  } catch (e) {
    if (e.code !== 'EPERM') return null;
  }
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: status.port, path: '/api/whoami', headers: { Host: 'localhost' }, timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 ? status : null);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

const localUrlFor = (port) => (port === 80 ? 'http://localhost' : `http://localhost:${port}`);

function revealInFileManager(target, isDir) {
  if (process.platform === 'darwin') execFile('open', isDir ? [target] : ['-R', target], () => {});
  else if (process.platform === 'win32') execFile('explorer', isDir ? [target] : [`/select,${target}`], () => {});
  else execFile('xdg-open', [isDir ? target : path.dirname(target)], () => {});
}

/** macOS asks before apps write to Downloads, Documents or Desktop. Explain a "no" instead of failing vaguely. */
function blockedError(e, dir) {
  if (!e || !['EPERM', 'EACCES'].includes(e.code)) return e;
  const where = process.platform === 'darwin'
    ? ' On that Mac, open System Settings, then Privacy & Security, then Files and Folders, and turn on access for node.'
    : ' Pick a folder this computer lets Dropspace write to.';
  return httpError(403, `The host computer didn't let Dropspace save into ${displayPath(dir)}.${where}`);
}

/* ------------------------------------------------------------------ server */

async function startDropspace(opts = {}) {
  const log = opts.log === false ? quiet : opts.log || ((...a) => console.log(...a));
  const home = dropspaceHome(opts);
  const configPath = path.join(home, 'config.json');
  const statusPath = path.join(home, 'status.json');
  const historyPath = path.join(home, 'history.json');
  const extraHosts = String(process.env.DROPSPACE_ALLOWED_HOSTS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  await fsp.mkdir(home, { recursive: true, mode: 0o700 });

  let config = {};
  try {
    config = JSON.parse(await fsp.readFile(configPath, 'utf8')) || {};
  } catch {
    config = {};
  }
  if (typeof config.secret !== 'string' || config.secret.length < 32) config.secret = crypto.randomBytes(32).toString('base64url');

  // "root" is where folders are saved unless a folder has its own location.
  if (opts.folder) config.root = path.resolve(expandHome(opts.folder));
  if (typeof config.root !== 'string' || !path.isAbsolute(config.root)) config.root = DEFAULT_ROOT();

  config.spaces = (Array.isArray(config.spaces) ? config.spaces : [])
    .filter((s) => s && typeof s.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(s.id) && cleanSpaceName(s.name))
    .map((s) => ({
      id: s.id,
      name: cleanSpaceName(s.name),
      dir: typeof s.dir === 'string' && path.isAbsolute(s.dir) ? s.dir : null,
      created: Number.isFinite(s.created) ? s.created : 0,
    }));
  if (!config.spaces.length) {
    // Version 1 had a single "save to" folder. It becomes the first folder's location, so nothing moves.
    const legacy = typeof config.folder === 'string' && path.isAbsolute(config.folder) ? config.folder : null;
    config.spaces = [{ id: 'general', name: DEFAULT_SPACE_NAME, dir: legacy, created: 0 }];
  }
  delete config.folder;
  // Keys used by phones' Share button shortcuts. Only a hash of each secret is kept.
  config.shareKeys = (Array.isArray(config.shareKeys) ? config.shareKeys : [])
    .filter((k) => k && /^[A-Za-z0-9_-]{6,32}$/.test(k.id) && /^[0-9a-f]{64}$/.test(k.hash))
    .map((k) => ({ id: k.id, hash: k.hash, name: cleanDeviceName(k.name) || 'iPhone', created: Number(k.created) || 0, lastUsed: Number(k.lastUsed) || 0 }));
  config.secureOnly = config.secureOnly === true;

  const saveConfig = async () => {
    const tmp = configPath + '.tmp';
    const data = {
      secret: config.secret,
      root: config.root,
      spaces: config.spaces,
      lastSpace: config.lastSpace || null,
      shareKeys: config.shareKeys,
      secureOnly: config.secureOnly,
    };
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, configPath);
  };
  await saveConfig();

  const spaceDir = (space) => space.dir || path.join(config.root, safeName(space.name, 'Folder'));
  const findSpace = (id) => config.spaces.find((s) => s.id === id);
  const getSpace = (id) => {
    if (!id) return config.spaces[0];
    const space = findSpace(id);
    if (!space) throw httpError(404, 'That folder was deleted. Pick another folder.');
    return space;
  };
  // The folder each device has open, so sending without picking a folder (right-click in Finder,
  // the clipboard shortcut) lands where you're looking. Keyed by address: a Mac's browser and its
  // Finder shortcut share one.
  const focus = new Map();
  const deviceKey = (req) => (isLoopback(req.socket.remoteAddress) ? 'local' : clientIp(req));
  const spaceFor = (req, id) => {
    if (id) return getSpace(id);
    return findSpace(focus.get(deviceKey(req))) || findSpace(config.lastSpace) || config.spaces[0];
  };
  const nameTaken = (name, exceptId) => {
    const a = name.toLowerCase();
    const b = safeName(name, 'Folder').toLowerCase();
    return config.spaces.some((s) => s.id !== exceptId && (s.name.toLowerCase() === a || safeName(s.name, 'Folder').toLowerCase() === b));
  };
  await fsp.mkdir(spaceDir(config.spaces[0]), { recursive: true }).catch(() => {}); // a blocked folder is reported on first upload

  const hostName = cleanDeviceName(opts.hostName || process.env.DROPSPACE_NAME || '') || computerName();
  const S = {
    pin: newPin(),
    items: [], // oldest first
    files: new Map(), // fileId -> { abs, name, size, mime }
    clients: new Map(), // connectionId -> { res, deviceId, name, local }
    batches: new Map(), // batchId -> folder upload in progress
    reserved: new Set(), // file paths being written right now
    fails: new Map(), // ip -> [timestamps]
    allFails: [],
    pairTokens: new Map(), // one-time QR tokens -> expiry
    zips: new Map(), // download token -> { ids, name, expires }
    shortcuts: new Map(), // download token -> { file, expires }
    crcs: new Map(), // "path size mtime" -> CRC-32, so zipping something just received is instant
    port: null,
    httpsPort: null,
    tls: null, // { caPem, certPem, keyPem, fingerprint }
    nice: null, // 'dropspace.local' once it's confirmed to resolve on the network
  };
  const crcKey = (abs, st) => `${abs}\0${st.size}\0${Math.floor(st.mtimeMs)}`;
  const rememberCrc = (abs, st, crc) => {
    if (S.crcs.size > 5000) S.crcs.delete(S.crcs.keys().next().value);
    S.crcs.set(crcKey(abs, st), crc);
  };
  const fixedAddress = String(process.env.DROPSPACE_ADDRESS || '').trim().replace(/\/+$/, '') || null;

  /* ---------- sessions: an HMAC-signed random id in an HttpOnly cookie */

  const sign = (value) => crypto.createHmac('sha256', config.secret).update(value).digest('base64url');
  const makeSession = () => {
    const id = crypto.randomBytes(18).toString('base64url');
    return `${id}.${sign(id)}`;
  };
  const sessionValid = (token) => {
    if (typeof token !== 'string') return false;
    const i = token.indexOf('.');
    if (i <= 0) return false;
    const a = Buffer.from(token.slice(i + 1));
    const b = Buffer.from(sign(token.slice(0, i)));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const isLocal = (req) => {
    const h = hostnameOf(req.headers.host);
    return isLoopback(req.socket.remoteAddress) && (h === 'localhost' || h === '127.0.0.1' || h === '::1');
  };

  /* ---------- the board */

  const addresses = () => {
    const suffix = S.port === 80 ? '' : `:${S.port}`;
    const ips = lanAddresses().map((a) => `http://${a}${suffix}`);
    const bonjour = bonjourName();
    // The permanent address: a fixed one if set, dropspace.local, or this Mac's own Bonjour name.
    const stable = fixedAddress || (S.nice ? `http://${S.nice}${suffix}` : null) || (bonjour ? `http://${bonjour}${suffix}` : null);
    const all = [stable, ...ips, bonjour ? `http://${bonjour}${suffix}` : null].filter(Boolean);
    const unique = [...new Set(all)];
    if (!ips.length && !fixedAddress) return { primary: null, others: [], stable: null, qr: null };
    // Phones scan the QR code; a plain IP address works on every phone.
    return { primary: unique[0], others: unique.slice(1), stable, qr: ips[0] || unique[0] };
  };

  // The secure address lives on its own port: 443 when plain HTTP has 80, so it needs no number either.
  const secureInfo = () => (S.httpsPort ? { port: S.httpsPort, only: config.secureOnly } : null);
  const hostInfo = () => ({
    name: hostName,
    pin: S.pin,
    addresses: addresses(),
    address: addresses().stable,
    platform: process.platform,
    quickActions: process.platform === 'darwin' && fs.existsSync(path.join(os.homedir(), 'Library', 'Services', 'Send to Dropspace.workflow')),
    secure: S.httpsPort ? { ...secureInfo(), fingerprint: S.tls && S.tls.fingerprint } : null,
    shareKeys: config.shareKeys.map(({ id, name, created, lastUsed }) => ({ id, name, created, lastUsed })),
  });
  const publicHost = () => ({ name: hostName, address: addresses().stable, platform: process.platform, secure: secureInfo() });
  const sessionCookie = (secure) => `${COOKIE}=${makeSession()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`;

  // Where a folder saves is only shown on the host computer itself.
  const publicSpace = (space, local) => (local
    ? { id: space.id, name: space.name, created: space.created || 0, folderDisplay: displayPath(spaceDir(space)) }
    : { id: space.id, name: space.name, created: space.created || 0 });

  const publicItem = (item) => {
    const { abs, files, ...rest } = item;
    if (item.type !== 'folder') return rest;
    return {
      ...rest,
      files: files.slice(0, MAX_FOLDER_LIST).map(({ id, name, rel, size, mime }) => ({ id, name, rel, size, mime, kind: kindOf(name) })),
      more: Math.max(0, files.length - MAX_FOLDER_LIST),
    };
  };

  const presence = () => {
    const seen = new Map();
    for (const c of S.clients.values()) {
      if (!seen.has(c.deviceId)) seen.set(c.deviceId, { id: c.deviceId, name: c.name, local: c.local });
    }
    return [...seen.values()].sort((a, b) => Number(b.local) - Number(a.local));
  };

  const sendEvent = (client, event, data) => {
    if (!client.res.writableEnded) client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const broadcast = (event, data, filter = () => true) => {
    for (const c of S.clients.values()) if (filter(c)) sendEvent(c, event, data);
  };
  const broadcastPresence = () => broadcast('presence', { devices: presence() });
  const broadcastHost = () => {
    for (const c of S.clients.values()) sendEvent(c, 'host', c.local ? hostInfo() : publicHost());
  };
  const broadcastSpaces = () => {
    for (const c of S.clients.values()) sendEvent(c, 'spaces', { spaces: config.spaces.map((s) => publicSpace(s, c.local)) });
  };

  let saveTimer = null;
  const historySnapshot = () => JSON.stringify({ version: 1, items: S.items });
  const saveHistory = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const tmp = historyPath + '.tmp';
        await fsp.writeFile(tmp, historySnapshot(), { mode: 0o600 });
        await fsp.rename(tmp, historyPath);
      } catch (e) {
        log(`Could not save the board: ${e.message}`);
      }
    }, 250);
  };

  const registerFiles = (item) => {
    if (item.type === 'file') S.files.set(item.id, { abs: item.abs, name: item.name, size: item.size, mime: item.mime });
    if (item.type === 'folder') for (const f of item.files) S.files.set(f.id, f);
  };
  const unregisterFiles = (item) => {
    if (item.type === 'file') S.files.delete(item.id);
    if (item.type === 'folder') for (const f of item.files) S.files.delete(f.id);
  };

  const addItem = (item) => {
    S.items.push(item);
    registerFiles(item);
    // Each folder keeps its newest MAX_ITEMS. Files stay on disk either way.
    let count = S.items.reduce((n, it) => n + (it.space === item.space ? 1 : 0), 0);
    while (count > MAX_ITEMS) {
      const oldest = S.items.findIndex((it) => it.space === item.space);
      unregisterFiles(S.items[oldest]);
      S.items.splice(oldest, 1);
      count--;
    }
    saveHistory();
    broadcast('item', publicItem(item));
  };

  // Bring back the board from last time, dropping anything whose file is gone.
  try {
    const saved = JSON.parse(await fsp.readFile(historyPath, 'utf8'));
    for (const item of Array.isArray(saved.items) ? saved.items : []) {
      if (!item || typeof item.id !== 'string') continue;
      if (!findSpace(item.space)) item.space = config.spaces[0].id; // version 1 items, or a folder that's gone
      if (item.type === 'text' && typeof item.text === 'string') S.items.push(item);
      else if (item.type === 'file' && typeof item.abs === 'string' && fs.existsSync(item.abs)) S.items.push(item);
      else if (item.type === 'folder' && Array.isArray(item.files)) {
        item.files = item.files.filter((f) => f && typeof f.abs === 'string' && fs.existsSync(f.abs));
        if (item.files.length) S.items.push(item);
      }
    }
    S.items.forEach(registerFiles);
  } catch {
    /* first run */
  }

  const uniquePath = async (dir, name) => {
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    for (let i = 0; i < 10000; i++) {
      const candidate = path.join(dir, i === 0 ? name : `${base} (${i})${ext}`);
      if (S.reserved.has(candidate)) continue;
      try {
        await fsp.lstat(candidate);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        S.reserved.add(candidate);
        return candidate;
      }
    }
    throw httpError(409, 'Too many files with that name already');
  };

  const uniqueDir = async (parent, name) => {
    for (let i = 0; i < 10000; i++) {
      const candidate = path.join(parent, i === 0 ? name : `${name} (${i})`);
      try {
        await fsp.mkdir(candidate);
        return candidate;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    throw httpError(409, 'Too many folders with that name already');
  };

  /* ---------- rate-limited pairing */

  const recent = (list, now) => {
    while (list.length && now - list[0] > PIN_WINDOW_MS) list.shift();
    return list.length;
  };
  const pairLocked = (ip) => {
    const now = Date.now();
    return recent(S.fails.get(ip) || [], now) >= PIN_MAX_FAILS_PER_IP || recent(S.allFails, now) >= PIN_MAX_FAILS_TOTAL;
  };
  const recordFail = (ip) => {
    const list = S.fails.get(ip) || [];
    list.push(Date.now());
    S.fails.set(ip, list);
    S.allFails.push(Date.now());
  };
  const checkPin = (given) => {
    const a = Buffer.from(String(given || '').replace(/\D/g, '').padEnd(6, 'x').slice(0, 12));
    const b = Buffer.from(S.pin.padEnd(6, 'x'));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const consumeToken = (token) => {
    const now = Date.now();
    for (const [t, exp] of S.pairTokens) if (exp < now) S.pairTokens.delete(t);
    if (typeof token !== 'string' || !S.pairTokens.has(token)) return false;
    S.pairTokens.delete(token);
    return true;
  };

  /**
   * Renaming a folder renames its directory too, so the website and Finder match.
   * If that isn't possible (the new name is already taken on disk), the folder keeps
   * saving to its current directory instead of splitting files across two.
   */
  async function renameSpaceDir(space, newName) {
    const from = spaceDir(space);
    const to = path.join(config.root, safeName(newName, 'Folder'));
    if (from === to) return;
    for (const r of S.reserved) {
      if (isInside(from, r)) throw httpError(409, 'Wait for uploads to this folder to finish, then rename it.');
    }
    let fromExists = true;
    try {
      await fsp.access(from);
    } catch {
      fromExists = false;
    }
    if (!fromExists) return;
    const caseOnly = from.toLowerCase() === to.toLowerCase();
    let toExists = false;
    if (!caseOnly) {
      try {
        await fsp.access(to);
        toExists = true;
      } catch {
        /* free */
      }
    }
    if (toExists) {
      space.dir = from;
      return;
    }
    try {
      await fsp.rename(from, to);
    } catch {
      space.dir = from;
      return;
    }
    const move = (p) => (p === from || isInside(from, p) ? to + p.slice(from.length) : p);
    for (const it of S.items) {
      unregisterFiles(it);
      if (it.abs) it.abs = move(it.abs);
      if (it.type === 'folder') for (const f of it.files) f.abs = move(f.abs);
      registerFiles(it);
    }
    for (const b of S.batches.values()) {
      b.dir = move(b.dir);
      for (const f of b.files) f.abs = move(f.abs);
    }
    saveHistory();
  }

  /** Copy files or folders already on this computer into a Dropspace folder. Symlinks are skipped. */
  async function importPaths(paths, space, from, { names = {} } = {}) {
    const dir = spaceDir(space);
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (e) {
      throw blockedError(e, dir);
    }
    const items = [];
    for (const src of paths) {
      let st;
      try {
        st = await fsp.stat(src);
      } catch (e) {
        if (['EPERM', 'EACCES'].includes(e.code)) throw blockedError(e, path.dirname(src));
        continue;
      }
      if (st.isFile()) {
        const finalPath = await uniquePath(dir, safeName(names[src] || path.basename(src), 'file'));
        try {
          await fsp.copyFile(src, finalPath, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
        } catch (e) {
          throw blockedError(e, dir);
        } finally {
          S.reserved.delete(finalPath);
        }
        const name = path.basename(finalPath);
        const item = {
          id: newId(), type: 'file', space: space.id, name, size: st.size, mime: mimeOf(name), kind: kindOf(name),
          abs: finalPath, from, at: Date.now(), clientKey: '',
        };
        addItem(item);
        items.push(item);
      } else if (st.isDirectory()) {
        const target = await uniqueDir(dir, safeName(path.basename(src), 'Folder'));
        const files = [];
        const walk = async (from_, to) => {
          for (const e of await fsp.readdir(from_, { withFileTypes: true })) {
            if (/^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(e.name)) continue;
            const a = path.join(from_, e.name);
            const b = path.join(to, safeName(e.name, '_'));
            if (e.isDirectory()) {
              await fsp.mkdir(b, { recursive: true });
              await walk(a, b);
            } else if (e.isFile()) {
              if (files.length >= 20000) throw httpError(413, 'That folder has too many files. Send a smaller one.');
              await fsp.copyFile(a, b, fs.constants.COPYFILE_FICLONE);
              const size = (await fsp.stat(b)).size;
              files.push({ id: newId(), abs: b, name: path.basename(b), size, mime: mimeOf(b), rel: path.relative(target, b).split(path.sep).join('/') });
            }
          }
        };
        await walk(src, target);
        if (!files.length) {
          await fsp.rm(target, { recursive: true, force: true });
          continue;
        }
        const item = {
          id: newId(), type: 'folder', space: space.id, name: path.basename(target), abs: target, count: files.length,
          size: files.reduce((n, f) => n + f.size, 0), files, from, at: Date.now(), clientKey: '',
        };
        addItem(item);
        items.push(item);
      }
    }
    return items;
  }

  /* ---------- request handling */

  const fromOf = (req, local) => ({
    id: cleanDeviceId(req.headers['x-device-id']) || 'unknown',
    name: cleanDeviceName(headerText(req, 'x-device-name')) || (local ? hostName : 'Another device'),
    host: local,
  });

  async function handleUpload(req, res, from) {
    const name = safeName(headerText(req, 'x-filename'), 'file');
    const batchId = req.headers['x-batch'];
    let space = null;
    let dir;
    let batch = null;
    if (batchId) {
      batch = S.batches.get(batchId);
      if (!batch || batch.deviceId !== from.id) throw httpError(404, 'That folder upload has expired. Drop the folder again.');
      dir = path.join(batch.dir, ...safeRelSegments(headerText(req, 'x-relpath')));
      if (dir !== batch.dir && !isInside(batch.dir, dir)) throw httpError(400, 'Bad folder path');
    } else {
      space = spaceFor(req, headerText(req, 'x-space'));
      dir = spaceDir(space);
    }
    const lenHeader = req.headers['content-length'];
    const declared = lenHeader === undefined ? null : Number(lenHeader);
    if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0)) throw httpError(400, 'Bad Content-Length');
    if (declared !== null && declared > MAX_UPLOAD_BYTES) throw httpError(413, `Files can be up to ${formatBytes(MAX_UPLOAD_BYTES)}.`);

    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (e) {
      throw blockedError(e, dir);
    }
    const finalPath = await uniquePath(dir, name);
    const partPath = path.join(dir, `.${path.basename(finalPath)}.dropspace-part`);
    let received = 0;
    let crc = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        if (received > MAX_UPLOAD_BYTES) return cb(httpError(413, `Files can be up to ${formatBytes(MAX_UPLOAD_BYTES)}.`));
        crc = crc32(chunk, crc);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, fs.createWriteStream(partPath, { flags: 'wx' }));
      if (declared !== null && received !== declared) throw httpError(400, 'The upload was cut off. Try again.');
      await fsp.rename(partPath, finalPath);
      rememberCrc(finalPath, await fsp.stat(finalPath), crc);
    } catch (e) {
      await fsp.rm(partPath, { force: true }).catch(() => {});
      throw blockedError(e, dir);
    } finally {
      S.reserved.delete(finalPath);
    }

    const file = { id: newId(), abs: finalPath, name: path.basename(finalPath), size: received, mime: mimeOf(finalPath) };
    if (batch) {
      file.rel = path.relative(batch.dir, finalPath).split(path.sep).join('/');
      batch.files.push(file);
      batch.size += received;
      S.files.set(file.id, file);
      return sendJson(res, 200, { ok: true, id: file.id });
    }
    const item = {
      id: file.id, type: 'file', space: findSpace(space.id) ? space.id : config.spaces[0].id,
      name: file.name, size: received, mime: file.mime, kind: kindOf(file.name),
      abs: finalPath, from, at: Date.now(), clientKey: String(req.headers['x-client-key'] || '').slice(0, 64),
    };
    addItem(item);
    log(`Received "${item.name}" (${formatBytes(received)}) in ${findSpace(item.space).name} from ${from.name}`);
    return sendJson(res, 200, { ok: true, item: publicItem(item) });
  }

  async function serveFile(req, res, id, url) {
    const f = S.files.get(id);
    if (!f) throw httpError(404, 'That file is no longer on the board.');
    let st;
    try {
      st = await fsp.stat(f.abs);
    } catch {
      throw httpError(404, 'That file was moved or deleted on the host computer.');
    }
    if (!st.isFile()) throw httpError(404, 'Not a file');
    const kind = kindOf(f.name);
    const inline = !url.searchParams.has('dl') && (kind === 'image' || kind === 'video' || kind === 'audio');
    const headers = {
      'Content-Type': mimeOf(f.name),
      'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', f.name),
      'Content-Security-Policy': FILE_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=86400',
      'Last-Modified': st.mtime.toUTCString(),
    };
    const size = st.size;
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m && (m[1] || m[2])) {
        if (m[1]) {
          start = Number(m[1]);
          end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        } else {
          start = Math.max(0, size - Number(m[2]));
        }
        if (start >= size || start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` });
          return res.end();
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      }
    }
    headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || size === 0) return res.end();
    const stream = fs.createReadStream(f.abs, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  /* ---------- several items at once, as one zip */

  async function zipPlan(ids) {
    const items = ids.map((id) => S.items.find((it) => it.id === id)).filter(Boolean);
    if (!items.length) throw httpError(404, 'Those items are no longer in Dropspace.');
    const spaces = new Set(items.map((it) => it.space));
    // Picked from search results across folders? Keep each folder's things together.
    const prefix = (it) => (spaces.size > 1 ? `${safeName((findSpace(it.space) || {}).name || 'Folder', 'Folder')}/` : '');
    const taken = new Set();
    const unique = (want, isDir = false) => {
      const slash = want.lastIndexOf('/');
      const dot = isDir ? -1 : want.lastIndexOf('.');
      const hasExt = dot > slash + 1;
      const base = hasExt ? want.slice(0, dot) : want;
      const ext = hasExt ? want.slice(dot) : '';
      for (let i = 0; ; i++) {
        const candidate = i ? `${base} (${i})${ext}` : want;
        if (!taken.has(candidate.toLowerCase())) {
          taken.add(candidate.toLowerCase());
          return candidate;
        }
      }
    };
    const entries = [];
    const fileEntry = async (abs, name) => {
      let st;
      try {
        st = await fsp.stat(abs);
      } catch {
        return; // moved or deleted on the host: leave it out
      }
      if (!st.isFile()) return;
      let crc = S.crcs.get(crcKey(abs, st));
      if (crc === undefined) {
        crc = await crcFile(abs, st.size);
        rememberCrc(abs, st, crc);
      }
      entries.push({ name, path: abs, size: st.size, crc, mtime: st.mtimeMs });
    };
    for (const it of items) {
      if (it.type === 'file') await fileEntry(it.abs, unique(prefix(it) + it.name));
      else if (it.type === 'folder') {
        const top = unique(prefix(it) + it.name, true);
        for (const f of it.files) await fileEntry(f.abs, `${top}/${f.rel}`);
      } else if (it.type === 'text') {
        const data = Buffer.from(it.text, 'utf8');
        entries.push({ name: unique(prefix(it) + noteFileName(it.text)), data, size: data.length, crc: crc32(data), mtime: it.at });
      }
    }
    if (!entries.length) throw httpError(404, 'Those files were moved or deleted on the host computer.');
    return planZip(entries);
  }

  function zipName(items) {
    if (items.length === 1 && items[0].type === 'folder') return `${items[0].name}.zip`;
    const spaces = new Set(items.map((it) => it.space));
    const label = spaces.size === 1 ? (findSpace(items[0].space) || {}).name || 'Dropspace' : 'Dropspace';
    return `${safeName(label, 'Dropspace')} - ${items.length} ${items.length === 1 ? 'item' : 'items'}.zip`;
  }

  /* ---------- the Share button on a phone */

  const hashSecret = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const shareKeyFor = (req, url) => {
    let raw = url.searchParams.get('key') || '';
    const auth = req.headers.authorization;
    if (!raw && typeof auth === 'string' && /^Bearer\s+/i.test(auth)) raw = auth.replace(/^Bearer\s+/i, '').trim();
    const m = /^([A-Za-z0-9_-]{6,32})\.([A-Za-z0-9_-]{20,128})$/.exec(raw);
    if (!m) return null;
    const key = config.shareKeys.find((k) => k.id === m[1]);
    if (!key) return null;
    const a = Buffer.from(key.hash, 'hex');
    const b = Buffer.from(hashSecret(m[2]), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? key : null;
  };

  /** The address a phone's shortcut should use: the one it chose, if it's one of this computer's. */
  const shareBase = (req, wanted) => {
    const current = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
    let base = current;
    if (typeof wanted === 'string' && wanted) {
      try {
        const u = new URL(wanted);
        if (['http:', 'https:'].includes(u.protocol) && hostAllowed(u.host, extraHosts) && u.pathname === '/' && !u.search) base = u.origin;
      } catch {
        /* keep the current address */
      }
    }
    if (config.secureOnly && S.httpsPort && base.startsWith('http:')) {
      const u = new URL(base);
      base = `https://${u.hostname.includes(':') ? `[${u.hostname}]` : u.hostname}${S.httpsPort === 443 ? '' : `:${S.httpsPort}`}`;
    }
    return base;
  };

  const waitDrain = (out) => new Promise((resolve, reject) => {
    const done = (err) => {
      out.off('drain', onDrain);
      out.off('error', done);
      if (err) reject(err);
      else resolve();
    };
    const onDrain = () => done();
    out.on('drain', onDrain);
    out.on('error', done);
  });

  /** A file arriving in pieces. Written next to its final name, then renamed when complete. */
  async function incomingFile(dir, name) {
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (e) {
      throw blockedError(e, dir);
    }
    const finalPath = await uniquePath(dir, name);
    const partPath = path.join(dir, `.${path.basename(finalPath)}.dropspace-part`);
    const out = fs.createWriteStream(partPath, { flags: 'wx' });
    let failed = null;
    out.on('error', (e) => {
      failed = e;
    });
    let size = 0;
    let crc = 0;
    const cleanup = async () => {
      out.destroy();
      await fsp.rm(partPath, { force: true }).catch(() => {});
      S.reserved.delete(finalPath);
    };
    return {
      async write(chunk) {
        if (failed) throw blockedError(failed, dir);
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) throw httpError(413, `Files can be up to ${formatBytes(MAX_UPLOAD_BYTES)}.`);
        crc = crc32(chunk, crc);
        if (!out.write(chunk)) await waitDrain(out);
      },
      async finish() {
        try {
          await new Promise((resolve, reject) => {
            if (failed) return reject(failed);
            out.once('error', reject);
            out.end(() => resolve());
          });
          await fsp.rename(partPath, finalPath);
        } catch (e) {
          await cleanup();
          throw blockedError(e, dir);
        }
        S.reserved.delete(finalPath);
        rememberCrc(finalPath, await fsp.stat(finalPath), crc);
        return { abs: finalPath, name: path.basename(finalPath), size };
      },
      abort: cleanup,
    };
  }

  /**
   * Photos and files from a phone's Share button (an Apple Shortcut). It signs in with its own key
   * instead of a cookie, and lands in the folder open on the host computer.
   * Takes form uploads (what Shortcuts sends), a raw file, or plain text.
   */
  async function handleShare(req, res, url) {
    if (req.method !== 'POST') throw httpError(405, 'Send with POST.');
    const ip = clientIp(req);
    if (pairLocked(ip)) throw httpError(429, 'Too many wrong keys. Wait 5 minutes, then try again.');
    const key = shareKeyFor(req, url);
    if (!key) {
      recordFail(ip);
      throw httpError(401, 'This Share button was turned off in Dropspace. Set it up again in Settings on your phone.');
    }
    const from = { id: `share-${key.id}`, name: key.name, host: false };
    const wanted = cleanSpaceName(url.searchParams.get('folder') || '');
    let space;
    if (wanted) {
      space = config.spaces.find((s) => s.name.toLowerCase() === wanted.toLowerCase());
      if (!space) throw httpError(404, `There's no folder called "${wanted}" in Dropspace.`);
    } else {
      space = findSpace(focus.get('local')) || findSpace(config.lastSpace) || config.spaces[0];
    }
    const dir = spaceDir(space);
    const items = [];
    const addFile = (f) => {
      const item = {
        id: newId(), type: 'file', space: space.id, name: f.name, size: f.size, mime: mimeOf(f.name), kind: kindOf(f.name),
        abs: f.abs, from, at: Date.now(), clientKey: '',
      };
      addItem(item);
      items.push(item);
    };
    const addText = (text) => {
      if (!text.trim()) return;
      const item = { id: newId(), type: 'text', space: space.id, text, from, at: Date.now(), clientKey: '' };
      addItem(item);
      items.push(item);
    };

    const type = String(req.headers['content-type'] || '');
    const boundary = boundaryOf(type);
    if (boundary) {
      const parser = new MultipartParser(boundary);
      let file = null;
      let fileHadName = false;
      let text = null;
      let textBytes = 0;
      try {
        for await (const chunk of req) {
          for (const ev of parser.feed(chunk)) {
            if (ev.type === 'part') {
              if (ev.filename !== null) {
                fileHadName = !!ev.filename;
                file = await incomingFile(dir, sharedFileName(ev.filename, ev.contentType));
              } else {
                text = [];
                textBytes = 0;
              }
            } else if (ev.type === 'data') {
              if (file) await file.write(ev.data);
              else if (text && textBytes < MAX_TEXT_BYTES) {
                text.push(Buffer.from(ev.data));
                textBytes += ev.data.length;
              }
            } else if (ev.type === 'end') {
              if (file) {
                const done = file;
                file = null;
                const f = await done.finish();
                if (f.size === 0 && !fileHadName) await fsp.rm(f.abs, { force: true }); // an empty, unnamed field
                else addFile(f);
              } else if (text) {
                addText(Buffer.concat(text).toString('utf8').slice(0, MAX_TEXT_BYTES));
                text = null;
              }
            }
          }
        }
        parser.finish();
      } catch (e) {
        if (file) await file.abort();
        throw e;
      }
    } else if (/^text\/plain/i.test(type) && !req.headers['x-filename'] && !url.searchParams.get('name')) {
      addText((await readBody(req, MAX_TEXT_BYTES)).toString('utf8'));
    } else {
      const file = await incomingFile(dir, sharedFileName(headerText(req, 'x-filename') || url.searchParams.get('name'), type));
      try {
        for await (const chunk of req) await file.write(chunk);
      } catch (e) {
        await file.abort();
        throw e;
      }
      addFile(await file.finish());
    }
    if (!items.length) throw httpError(400, 'Nothing was shared.');
    S.fails.delete(ip);
    key.lastUsed = Date.now();
    saveConfig().catch(() => {});
    const what = items.length === 1 ? (items[0].type === 'text' ? 'a note' : `"${items[0].name}"`) : `${items.length} items`;
    log(`Received ${what} in ${space.name} from ${from.name} (Share button)`);
    return sendJson(res, 200, { ok: true, count: items.length, folder: space.name, message: `Sent to ${space.name}` });
  }

  /** The certificate for devices to trust, as a file for a Mac or PC, or a profile for an iPhone. */
  function serveCertificate(req, res, pathname) {
    const profile = pathname === '/dropspace.mobileconfig';
    const body = profile ? Buffer.from(mobileConfig(S.tls.caPem, hostName)) : pathname === '/ca.pem' ? Buffer.from(S.tls.caPem) : fromPem(S.tls.caPem);
    res.writeHead(200, {
      'Content-Type': profile ? 'application/x-apple-aspen-config' : pathname === '/ca.pem' ? 'application/x-pem-file' : 'application/x-x509-ca-cert',
      'Content-Disposition': contentDisposition('attachment', profile ? 'Dropspace.mobileconfig' : pathname === '/ca.pem' ? 'Dropspace.pem' : 'Dropspace.crt'),
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  function openEvents(req, res, url, local) {
    const client = {
      id: newId(),
      res,
      local,
      secure: !!req.socket.encrypted,
      deviceId: cleanDeviceId(url.searchParams.get('device')) || `anon-${newId()}`,
      name: cleanDeviceName(url.searchParams.get('name')) || (local ? hostName : 'Another device'),
    };
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    S.clients.set(client.id, client);
    sendEvent(client, 'hello', {
      version: VERSION,
      author: AUTHOR,
      you: { deviceId: client.deviceId, local, secure: client.secure },
      host: local ? hostInfo() : publicHost(),
      spaces: config.spaces.map((s) => publicSpace(s, local)),
      items: S.items.map(publicItem),
      devices: presence(),
    });
    broadcastPresence();
    req.on('close', () => {
      S.clients.delete(client.id);
      broadcastPresence();
    });
  }

  async function api(req, res, url, local, authed) {
    const p = url.pathname;
    const m = req.method;
    const from = fromOf(req, local);

    if (p === '/api/whoami' && m === 'GET') {
      const secure = !!req.socket.encrypted;
      const headers = {};
      // A device that came over from the plain address: from now on its pairing only travels encrypted.
      if (secure && authed && !local) headers['Set-Cookie'] = sessionCookie(true);
      return sendJson(res, 200, {
        paired: authed, local, hostName, version: VERSION, secure, httpsPort: S.httpsPort, secureOnly: !!(config.secureOnly && S.httpsPort),
      }, headers);
    }

    if (p === '/api/pair' && m === 'POST') {
      const ip = clientIp(req);
      if (authed) return sendJson(res, 200, { ok: true, hostName });
      if (pairLocked(ip)) throw httpError(429, 'Too many wrong codes. Wait 5 minutes, then try again.');
      const body = await readJson(req);
      const ok = body.token ? consumeToken(body.token) : checkPin(body.pin);
      if (!ok) {
        recordFail(ip);
        throw httpError(401, body.token ? 'That QR code has expired. Type the code instead.' : 'That code does not match. Check the code on the host computer.');
      }
      S.fails.delete(ip);
      log(`Paired a new device: ${from.name} (${ip})`);
      broadcast('paired', { name: from.name }, (c) => c.local);
      return sendJson(res, 200, { ok: true, hostName }, { 'Set-Cookie': sessionCookie(!!req.socket.encrypted) });
    }

    if (!authed) throw httpError(401, 'This device is not paired yet.');

    if (p === '/api/events' && m === 'GET') return openEvents(req, res, url, local);

    if (p === '/api/text' && m === 'POST') {
      const body = await readJson(req, MAX_TEXT_BYTES * 2);
      const text = typeof body.text === 'string' ? body.text : '';
      if (!text.trim()) throw httpError(400, 'Nothing to send');
      if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw httpError(413, 'That is too long to send as text. Drop it as a file instead.');
      const space = spaceFor(req, body.space);
      const item = { id: newId(), type: 'text', space: space.id, text, from, at: Date.now(), clientKey: String(body.clientKey || '').slice(0, 64) };
      addItem(item);
      log(`Received text (${text.length} characters) in ${space.name} from ${from.name}`);
      return sendJson(res, 200, { ok: true, item: publicItem(item) });
    }

    if (p === '/api/upload' && m === 'POST') return handleUpload(req, res, from);

    if (p === '/api/batch' && m === 'POST') {
      const body = await readJson(req);
      const space = spaceFor(req, body.space);
      const parent = spaceDir(space);
      await fsp.mkdir(parent, { recursive: true });
      const dir = await uniqueDir(parent, safeName(body.name, 'Folder'));
      const batch = { id: newId(), deviceId: from.id, space: space.id, dir, name: path.basename(dir), files: [], size: 0, created: Date.now() };
      S.batches.set(batch.id, batch);
      return sendJson(res, 200, { ok: true, batchId: batch.id, name: batch.name });
    }

    let match = /^\/api\/batch\/([A-Za-z0-9_-]+)\/done$/.exec(p);
    if (match && m === 'POST') {
      const batch = S.batches.get(match[1]);
      if (!batch || batch.deviceId !== from.id) throw httpError(404, 'That folder upload has expired.');
      const body = await readJson(req);
      S.batches.delete(batch.id);
      if (!batch.files.length) {
        await fsp.rmdir(batch.dir).catch(() => {});
        return sendJson(res, 200, { ok: true, item: null });
      }
      const item = {
        id: newId(), type: 'folder', space: findSpace(batch.space) ? batch.space : config.spaces[0].id,
        name: batch.name, abs: batch.dir, count: batch.files.length, size: batch.size,
        files: batch.files, from, at: Date.now(), clientKey: String(body.clientKey || '').slice(0, 64),
      };
      addItem(item);
      log(`Received folder "${item.name}" (${item.count} files, ${formatBytes(item.size)}) from ${from.name}`);
      return sendJson(res, 200, { ok: true, item: publicItem(item) });
    }

    match = /^\/api\/file\/([A-Za-z0-9_-]+)(?:\/[^/]*)?$/.exec(p);
    if (match && (m === 'GET' || m === 'HEAD')) return serveFile(req, res, match[1], url);

    match = /^\/api\/items\/([A-Za-z0-9_-]+)$/.exec(p);
    if (match && m === 'DELETE') {
      const i = S.items.findIndex((it) => it.id === match[1]);
      if (i >= 0) {
        unregisterFiles(S.items[i]);
        S.items.splice(i, 1);
        saveHistory();
        broadcast('remove', { id: match[1] });
      }
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/items/delete' && m === 'POST') {
      const body = await readJson(req, 512 * 1024);
      const ids = new Set((Array.isArray(body.ids) ? body.ids : []).filter((x) => typeof x === 'string'));
      const removed = [];
      S.items = S.items.filter((it) => {
        if (!ids.has(it.id)) return true;
        unregisterFiles(it);
        removed.push(it.id);
        return false;
      });
      if (removed.length) {
        saveHistory();
        broadcast('remove', { ids: removed });
      }
      return sendJson(res, 200, { ok: true, removed: removed.length });
    }

    if (p === '/api/zip' && m === 'POST') {
      const body = await readJson(req, 512 * 1024);
      const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).filter((x) => typeof x === 'string'))];
      const items = ids.map((id) => S.items.find((it) => it.id === id)).filter(Boolean);
      if (!items.length) throw httpError(404, 'Those items are no longer in Dropspace.');
      const now = Date.now();
      for (const [t, z] of S.zips) if (z.expires < now) S.zips.delete(t);
      const token = crypto.randomBytes(18).toString('base64url');
      const name = zipName(items);
      S.zips.set(token, { ids: items.map((it) => it.id), name, expires: now + ZIP_TOKEN_TTL_MS });
      return sendJson(res, 200, { url: `/api/zip/${token}/${encodeURIComponent(name)}`, name, count: items.length });
    }

    match = /^\/api\/zip\/([A-Za-z0-9_-]+)(?:\/[^/]*)?$/.exec(p);
    if (match && (m === 'GET' || m === 'HEAD')) {
      const job = S.zips.get(match[1]);
      if (!job || job.expires < Date.now()) throw httpError(404, 'That download has expired. Select the items and download them again.');
      const plan = await zipPlan(job.ids);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': plan.total,
        'Content-Disposition': contentDisposition('attachment', job.name),
        'Content-Security-Policy': FILE_CSP,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      if (m === 'HEAD') return res.end();
      await writeZip(res, plan);
      return res.end();
    }

    /* ---------- the Share button on phones */

    const publicKey = ({ id, name, created, lastUsed }) => ({ id, name, created, lastUsed });
    if (p === '/api/share-keys' && m === 'GET') return sendJson(res, 200, { keys: config.shareKeys.map(publicKey) });

    if (p === '/api/share-keys' && m === 'POST') {
      const body = await readJson(req);
      if (config.shareKeys.length >= MAX_SHARE_KEYS) {
        throw httpError(400, `There are already ${MAX_SHARE_KEYS} Share buttons. Remove one in Settings on ${hostName} first.`);
      }
      const name = cleanDeviceName(body.name) || from.name;
      const id = crypto.randomBytes(6).toString('base64url');
      const secret = crypto.randomBytes(24).toString('base64url');
      config.shareKeys.push({ id, hash: hashSecret(secret), name, created: Date.now(), lastUsed: 0 });
      await saveConfig();
      const shareUrl = `${shareBase(req, body.base)}/api/share?key=${id}.${secret}`;
      let download = null;
      try {
        const signed = await (opts.signShortcut || shortcut.signShortcut)(shortcut.shortcutXml({ url: shareUrl }));
        if (signed) {
          const token = crypto.randomBytes(18).toString('base64url');
          for (const [t, s] of S.shortcuts) if (s.expires < Date.now()) S.shortcuts.delete(t);
          S.shortcuts.set(token, { file: signed, expires: Date.now() + ZIP_TOKEN_TTL_MS });
          download = `/api/shortcut/${token}/${encodeURIComponent(SHORTCUT_FILE)}`;
        }
      } catch (e) {
        log(`Couldn't sign the Share shortcut, so it has to be made by hand: ${e.message}`);
      }
      broadcastHost();
      log(`Set up the Share button on ${name}`);
      return sendJson(res, 200, { ok: true, key: publicKey(config.shareKeys[config.shareKeys.length - 1]), url: shareUrl, download });
    }

    match = /^\/api\/share-keys\/([A-Za-z0-9_-]+)$/.exec(p);
    if (match && m === 'DELETE') {
      const before = config.shareKeys.length;
      config.shareKeys = config.shareKeys.filter((k) => k.id !== match[1]);
      if (config.shareKeys.length !== before) {
        await saveConfig();
        broadcastHost();
      }
      return sendJson(res, 200, { ok: true });
    }

    match = /^\/api\/shortcut\/([A-Za-z0-9_-]+)(?:\/[^/]*)?$/.exec(p);
    if (match && (m === 'GET' || m === 'HEAD')) {
      const job = S.shortcuts.get(match[1]);
      if (!job || job.expires < Date.now()) throw httpError(404, 'That link has expired. Tap Set Up Share Button again.');
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': contentDisposition('attachment', SHORTCUT_FILE),
        'Content-Length': job.file.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(m === 'HEAD' ? undefined : job.file);
    }

    if (p === '/api/items' && m === 'DELETE') {
      const spaceId = url.searchParams.get('space');
      const keep = [];
      for (const it of S.items) {
        if (!spaceId || it.space === spaceId) unregisterFiles(it);
        else keep.push(it);
      }
      S.items = keep;
      saveHistory();
      broadcast('clear', spaceId ? { space: spaceId } : {});
      return sendJson(res, 200, { ok: true });
    }

    /* ---------- folders */

    if (p === '/api/spaces' && m === 'POST') {
      const body = await readJson(req);
      const name = cleanSpaceName(body.name);
      if (!name) throw httpError(400, 'Give the folder a name.');
      if (config.spaces.length >= MAX_SPACES) throw httpError(400, `You can have up to ${MAX_SPACES} folders.`);
      if (nameTaken(name)) throw httpError(409, `There's already a folder called "${name}".`);
      const space = { id: newId(), name, dir: null, created: Date.now() };
      config.spaces.push(space);
      await saveConfig();
      broadcastSpaces();
      log(`New folder: ${name}`);
      return sendJson(res, 200, { ok: true, space: publicSpace(space, local) });
    }

    match = /^\/api\/spaces\/([A-Za-z0-9_-]+)$/.exec(p);
    if (match && m === 'PATCH') {
      const space = getSpace(match[1]);
      const body = await readJson(req);
      const name = cleanSpaceName(body.name);
      if (!name) throw httpError(400, 'Give the folder a name.');
      if (name === space.name) return sendJson(res, 200, { ok: true, space: publicSpace(space, local) });
      if (nameTaken(name, space.id)) throw httpError(409, `There's already a folder called "${name}".`);
      const oldName = space.name;
      if (!space.dir) await renameSpaceDir(space, name);
      space.name = name;
      await saveConfig();
      broadcastSpaces();
      log(`Renamed folder "${oldName}" to "${name}"`);
      return sendJson(res, 200, { ok: true, space: publicSpace(space, local) });
    }

    if (match && m === 'DELETE') {
      const space = getSpace(match[1]);
      if (config.spaces.length <= 1) throw httpError(400, 'Keep at least one folder.');
      config.spaces = config.spaces.filter((s) => s.id !== space.id);
      S.items = S.items.filter((it) => {
        if (it.space !== space.id) return true;
        unregisterFiles(it);
        return false;
      });
      saveHistory();
      await saveConfig();
      broadcastSpaces();
      broadcast('clear', { space: space.id });
      log(`Deleted folder "${space.name}" from Dropspace (its files are still in ${displayPath(spaceDir(space))})`);
      return sendJson(res, 200, { ok: true });
    }

    match = /^\/api\/spaces\/([A-Za-z0-9_-]+)\/(location|reveal)$/.exec(p);
    if (match && m === 'POST') {
      if (!local) throw httpError(403, 'Only the computer running Dropspace can do this.');
      const space = getSpace(match[1]);
      if (match[2] === 'reveal') {
        await fsp.mkdir(spaceDir(space), { recursive: true });
        revealInFileManager(spaceDir(space), true);
        return sendJson(res, 200, { ok: true });
      }
      const body = await readJson(req);
      const raw = typeof body.folder === 'string' ? body.folder.trim() : '';
      if (!raw || !path.isAbsolute(expandHome(raw))) throw httpError(400, 'Enter a full folder path, like ~/Desktop/Game/Assets');
      const next = path.resolve(expandHome(raw));
      try {
        await fsp.mkdir(next, { recursive: true });
        if (!(await fsp.stat(next)).isDirectory()) throw new Error('not a folder');
        await fsp.access(next, fs.constants.W_OK);
      } catch {
        throw httpError(400, `Dropspace can't save into ${displayPath(next)}. Pick a folder you own.`);
      }
      const automatic = path.join(config.root, safeName(space.name, 'Folder'));
      space.dir = next === automatic ? null : next;
      await saveConfig();
      broadcastSpaces();
      log(`"${space.name}" now saves to ${displayPath(next)}`);
      return sendJson(res, 200, { ok: true, space: publicSpace(space, local) });
    }

    // Everything below can only be done from the computer running Dropspace.
    if (p === '/api/focus' && m === 'POST') {
      const body = await readJson(req);
      const space = getSpace(body.space);
      focus.set(deviceKey(req), space.id);
      if (config.lastSpace !== space.id) {
        config.lastSpace = space.id;
        saveConfig().catch(() => {});
      }
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/spaces' && m === 'GET') {
      return sendJson(res, 200, { spaces: config.spaces.map((sp) => publicSpace(sp, local)), current: spaceFor(req).id });
    }

    if (p === '/api/clipboard' && m === 'POST') {
      // Reads this computer's clipboard, so only the computer running Dropspace can ask.
      if (!local) throw httpError(403, 'Only the computer running Dropspace can do this.');
      if (process.platform !== 'darwin' && !opts.readClipboard) throw httpError(400, 'Sending the clipboard this way only works on a Mac. Paste with Ctrl+V instead.');
      const body = await readJson(req);
      const space = spaceFor(req, body.space);
      const clip = await (opts.readClipboard || readMacClipboard)();
      let items = [];
      if (clip.kind === 'files') items = await importPaths(clip.paths, space, from);
      else if (clip.kind === 'image') {
        try {
          items = await importPaths([clip.path], space, from, { names: { [clip.path]: clip.name } });
        } finally {
          await fsp.rm(clip.path, { force: true }).catch(() => {});
        }
      } else if (clip.kind === 'text') {
        const text = clip.text.length > MAX_TEXT_BYTES ? clip.text.slice(0, MAX_TEXT_BYTES) : clip.text;
        const item = { id: newId(), type: 'text', space: space.id, text, from, at: Date.now(), clientKey: '' };
        addItem(item);
        items = [item];
      } else {
        throw httpError(400, 'The clipboard is empty. Copy something first.');
      }
      log(`Sent the clipboard (${clip.kind}) to ${space.name}`);
      return sendJson(res, 200, { ok: true, kind: clip.kind, items: items.map(publicItem), space: publicSpace(space, local) });
    }

    if (p === '/api/move-token' && m === 'POST') {
      // A paired device moving to the permanent address carries its pairing over with a one-time token.
      const token = crypto.randomBytes(18).toString('base64url');
      S.pairTokens.set(token, Date.now() + 2 * 60 * 1000);
      return sendJson(res, 200, { token, address: addresses().stable });
    }

    const hostOnly = ['/api/pair-token', '/api/reveal', '/api/open', '/api/forget-devices', '/api/settings'];
    if (hostOnly.includes(p) && !local) throw httpError(403, 'Only the computer running Dropspace can do this.');

    if (p === '/api/settings' && m === 'POST') {
      const body = await readJson(req);
      if (typeof body.secureOnly === 'boolean' && body.secureOnly !== config.secureOnly) {
        if (body.secureOnly && !S.httpsPort) throw httpError(400, "Secure connections aren't available on this computer.");
        config.secureOnly = body.secureOnly;
        await saveConfig();
        // Devices still on the plain address get disconnected, then shown how to connect securely.
        if (config.secureOnly) for (const c of S.clients.values()) if (!c.local && !c.secure) c.res.end();
        log(config.secureOnly ? 'Only secure connections are allowed now.' : 'Plain connections are allowed again.');
        broadcastHost();
      }
      return sendJson(res, 200, { ok: true, secure: secureInfo() });
    }

    if (p === '/api/pair-token' && m === 'POST') {
      const token = crypto.randomBytes(18).toString('base64url');
      S.pairTokens.set(token, Date.now() + PAIR_TOKEN_TTL_MS);
      return sendJson(res, 200, { token, expiresIn: PAIR_TOKEN_TTL_MS });
    }

    if (p === '/api/open' && m === 'POST') {
      const body = await readJson(req);
      const item = S.items.find((it) => it.id === body.id);
      if (item && item.type === 'folder') {
        openWithDefaultApp(item.abs);
        return sendJson(res, 200, { ok: true });
      }
      const f = S.files.get(body.id);
      if (!f) throw httpError(404, 'That file is no longer on the board.');
      try {
        await fsp.access(f.abs);
      } catch {
        throw httpError(404, 'That file was moved or deleted on this computer.');
      }
      openWithDefaultApp(f.abs);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/reveal' && m === 'POST') {
      const body = await readJson(req);
      const item = S.items.find((it) => it.id === body.id);
      if (item && item.type === 'folder') {
        revealInFileManager(item.abs, true);
        return sendJson(res, 200, { ok: true });
      }
      const f = S.files.get(body.id);
      if (!f) throw httpError(404, 'That file is no longer on the board.');
      revealInFileManager(f.abs, false);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/forget-devices' && m === 'POST') {
      config.secret = crypto.randomBytes(32).toString('base64url');
      config.shareKeys = []; // phones' Share buttons stop working too
      await saveConfig();
      S.pin = newPin();
      S.pairTokens.clear();
      S.shortcuts.clear();
      for (const c of S.clients.values()) if (!c.local) c.res.end();
      log(`Forgot all paired devices. New pairing code: ${S.pin.slice(0, 3)} ${S.pin.slice(3)}`);
      broadcastHost();
      return sendJson(res, 200, { ok: true });
    }

    throw httpError(404, 'Not found');
  }

  async function serveStatic(req, res, pathname) {
    const entry = STATIC[pathname];
    if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const body = await fsp.readFile(path.join(PUBLIC_DIR, entry[0]));
    res.writeHead(200, {
      'Content-Type': entry[1],
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': pageCsp(entry[0] === 'index.html' ? [addresses().stable, secureOrigin(req), secureStable()] : []),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  /** The secure version of the address this request came in on, e.g. https://dropspace.local. */
  const secureOrigin = (req) => {
    const h = hostnameOf(req.headers.host);
    if (!S.httpsPort || !h) return null;
    return `https://${h.includes(':') ? `[${h}]` : h}${S.httpsPort === 443 ? '' : `:${S.httpsPort}`}`;
  };

  /** The permanent address over https, e.g. https://dropspace.local. */
  const secureStable = () => {
    const stable = addresses().stable;
    if (!S.httpsPort || !stable) return null;
    return `https://${new URL(stable).hostname}${S.httpsPort === 443 ? '' : `:${S.httpsPort}`}`;
  };

  const CERT_FILES = ['/ca.pem', '/dropspace-ca.crt', '/dropspace.mobileconfig'];

  async function handle(req, res) {
    try {
      if (!hostAllowed(req.headers.host, extraHosts)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Dropspace only answers on local network addresses.');
      }
      const url = new URL(req.url, 'http://dropspace.invalid');
      const encrypted = !!req.socket.encrypted;
      if (S.tls && CERT_FILES.includes(url.pathname) && (req.method === 'GET' || req.method === 'HEAD')) {
        return serveCertificate(req, res, url.pathname);
      }
      // "Secure connections only": other devices on the plain address get the page (which explains
      // how to connect securely) but nothing else.
      if (config.secureOnly && S.httpsPort && !encrypted && !isLocal(req)
        && url.pathname.startsWith('/api/') && url.pathname !== '/api/whoami') {
        throw httpError(403, `This Dropspace only allows secure connections. Open ${secureOrigin(req)} instead.`);
      }
      if (url.pathname === '/api/share') return await handleShare(req, res, url);
      if (!url.pathname.startsWith('/api/')) return await serveStatic(req, res, url.pathname);

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // A custom header can't be sent cross-site without permission, so other websites can't post here.
        if (req.headers['x-dropspace'] !== '1') throw httpError(403, 'Missing X-Dropspace header');
        const origin = req.headers.origin;
        if (origin && origin.toLowerCase() !== `${encrypted ? 'https' : 'http'}://${String(req.headers.host).toLowerCase()}`) {
          throw httpError(403, 'Requests from other websites are blocked');
        }
      }
      const local = isLocal(req);
      const authed = local || sessionValid(parseCookies(req.headers.cookie)[COOKIE]);
      return await api(req, res, url, local, authed);
    } catch (err) {
      // 499: the other computer cancelled or lost its connection mid-upload. Nothing to report.
      const aborted = ['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'ECONNABORTED'].includes(err.code);
      const status = err.status || (aborted ? 499 : 500);
      if (status >= 500) log(`Error: ${err.stack || err.message}`);
      if (status === 499 || res.headersSent || res.destroyed) return res.destroy();
      sendJson(res, status, { error: err.expose ? err.message : 'Something went wrong on the host computer.' }, status === 413 ? { Connection: 'close' } : {});
    }
  }

  const tune = (srv) => {
    srv.requestTimeout = 0; // big files can take a while; don't cut them off
    srv.headersTimeout = 60 * 1000;
    srv.keepAliveTimeout = 5 * 1000;
    return srv;
  };
  const server = tune(http.createServer(handle));

  const listenOn = (srv, port) =>
    new Promise((resolve, reject) => {
      const onError = (e) => {
        srv.off('listening', onListening);
        reject(e);
      };
      const onListening = () => {
        srv.off('error', onError);
        resolve(srv.address().port);
      };
      srv.once('error', onError);
      srv.once('listening', onListening);
      srv.listen(port, opts.bind);
    });
  const listen = (port) => listenOn(server, port);

  // On a Mac, port 80 means the address needs no ":number" at all. Otherwise (or if 80 is taken) use 8765.
  let candidates;
  if (opts.port === 0) candidates = [0];
  else if (opts.port !== undefined && opts.port !== null) candidates = opts.strictPort ? [opts.port] : Array.from({ length: 11 }, (_, i) => opts.port + i);
  else candidates = [...(process.platform === 'darwin' ? [80] : []), ...Array.from({ length: 11 }, (_, i) => DEFAULT_PORT + i)];
  for (let i = 0; ; i++) {
    try {
      S.port = await listen(candidates[i]);
      break;
    } catch (e) {
      if (!['EADDRINUSE', 'EACCES'].includes(e.code) || i >= candidates.length - 1) throw e;
    }
  }

  /* ---------- the secure address: the same app over HTTPS, with Dropspace's own certificate */
  const tlsDir = path.join(home, 'tls');
  let fixedHost = null;
  try {
    fixedHost = fixedAddress ? new URL(fixedAddress).hostname.replace(/^\[|\]$/g, '') : null;
  } catch {
    fixedHost = null;
  }
  const certNames = () => [NICE_HOST, 'localhost', bonjourName(), os.hostname(), ...extraHosts, ...(fixedHost && !net.isIP(fixedHost) ? [fixedHost] : [])];
  const certIps = () => ['127.0.0.1', ...lanAddresses(), ...(fixedHost && net.isIP(fixedHost) === 4 ? [fixedHost] : [])];
  let httpsServer = null;
  let renewTimer = null;
  if (opts.https !== false && process.env.DROPSPACE_HTTPS !== '0') {
    try {
      S.tls = await ensureCertificates(tlsDir, { label: hostName, dnsNames: certNames(), ips: certIps() });
      httpsServer = tune(https.createServer({ key: S.tls.keyPem, cert: S.tls.certPem }, handle));
      httpsServer.on('tlsClientError', () => {}); // a device that doesn't trust it yet; nothing to log
      let secureCandidates;
      if (opts.httpsPort !== undefined && opts.httpsPort !== null) secureCandidates = [opts.httpsPort];
      else if (S.port === 80) secureCandidates = [443, ...Array.from({ length: 10 }, (_, i) => DEFAULT_PORT + 1 + i)];
      else if (opts.port === 0) secureCandidates = [0];
      else secureCandidates = Array.from({ length: 10 }, (_, i) => S.port + 1 + i);
      for (let i = 0; ; i++) {
        try {
          S.httpsPort = await listenOn(httpsServer, secureCandidates[i]);
          break;
        } catch (e) {
          if (!['EADDRINUSE', 'EACCES'].includes(e.code) || i >= secureCandidates.length - 1) throw e;
        }
      }
      // Keep the certificate current: renew it before it runs out and when this computer's address changes.
      renewTimer = setInterval(async () => {
        try {
          const next = await ensureCertificates(tlsDir, { label: hostName, dnsNames: certNames(), ips: certIps() });
          if (next.changed) {
            S.tls = next;
            httpsServer.setSecureContext({ key: next.keyPem, cert: next.certPem });
          }
        } catch (e) {
          log(`Couldn't update the secure certificate: ${e.message}`);
        }
      }, 5 * 60 * 1000);
      renewTimer.unref();
    } catch (e) {
      log(`Secure connections are off: ${e.message}`);
      if (httpsServer) httpsServer.close();
      httpsServer = null;
      S.httpsPort = null;
    }
  }

  // Remember where this copy is running, so opening Dropspace again goes to it instead of starting a second one.
  await fsp.writeFile(statusPath, JSON.stringify({ pid: process.pid, port: S.port, httpsPort: S.httpsPort, version: VERSION, started: Date.now() }), { mode: 0o600 }).catch(() => {});

  /* ---------- the permanent address: advertise dropspace.local with the Mac's built-in Bonjour tool */
  let mdns = null;
  let mdnsIp = null;
  let mdnsTimer = null;
  const DNS_SD = '/usr/bin/dns-sd';
  const useMdns = !fixedAddress && opts.mdns !== false && process.platform === 'darwin' && fs.existsSync(DNS_SD);
  const verifyNice = (ip) => {
    dns.lookup(NICE_HOST, { all: true, family: 4 }, (err, found) => {
      if (ip !== mdnsIp) return;
      const ok = !err && Array.isArray(found) && found.some((a) => a.address === ip);
      if (ok === !!S.nice) return;
      S.nice = ok ? NICE_HOST : null;
      if (ok) log(`Other devices can always use http://${NICE_HOST}${S.port === 80 ? '' : ':' + S.port}`);
      broadcastHost();
    });
  };
  const advertise = () => {
    const ip = lanAddresses()[0] || null;
    if (mdns && ip === mdnsIp) return;
    if (mdns) mdns.kill();
    mdns = null;
    mdnsIp = ip;
    if (S.nice) {
      S.nice = null;
      broadcastHost();
    }
    if (!ip) return;
    const child = spawn(DNS_SD, ['-P', 'Dropspace', '_http._tcp', 'local', String(S.port), NICE_HOST, ip, 'path=/'], { stdio: 'ignore' });
    mdns = child;
    child.on('error', () => {});
    child.on('exit', () => {
      if (mdns === child) {
        mdns = null;
        mdnsIp = null;
        if (S.nice) {
          S.nice = null;
          broadcastHost();
        }
      }
    });
    setTimeout(() => verifyNice(ip), 1500).unref();
    setTimeout(() => verifyNice(ip), 6000).unref();
  };
  if (useMdns) {
    advertise();
    mdnsTimer = setInterval(advertise, 20 * 1000);
    mdnsTimer.unref();
  }

  const ping = setInterval(() => {
    for (const c of S.clients.values()) if (!c.res.writableEnded) c.res.write(': ping\n\n');
  }, 20 * 1000);
  const sweep = setInterval(() => {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [id, b] of S.batches) if (b.created < cutoff) S.batches.delete(id);
  }, 10 * 60 * 1000);
  ping.unref();
  sweep.unref();

  const close = async () => {
    clearInterval(ping);
    clearInterval(sweep);
    clearInterval(mdnsTimer);
    clearInterval(renewTimer);
    if (mdns) mdns.kill();
    mdns = null;
    try {
      const st = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      if (st.pid === process.pid && st.port === S.port) fs.unlinkSync(statusPath);
    } catch {
      /* already gone */
    }
    if (saveTimer) {
      clearTimeout(saveTimer);
      try {
        fs.writeFileSync(historyPath, historySnapshot(), { mode: 0o600 });
      } catch {
        /* ignore */
      }
    }
    for (const c of S.clients.values()) c.res.end();
    S.clients.clear();
    const closing = [server, httpsServer].filter(Boolean).map((srv) => new Promise((resolve) => srv.close(() => resolve())));
    for (const srv of [server, httpsServer]) if (srv && srv.closeAllConnections) srv.closeAllConnections();
    await Promise.all(closing);
  };

  return {
    server,
    port: S.port,
    httpsPort: S.httpsPort,
    localUrl: localUrlFor(S.port),
    home,
    get pin() {
      return S.pin;
    },
    hostInfo,
    config,
    close,
  };
}

/* ------------------------------------------------------------------ CLI */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--port' || a === '-p') out.port = Number(value());
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
    else if (a === '--folder' || a === '-f') out.folder = value();
    else if (a.startsWith('--folder=')) out.folder = a.slice(9);
    else if (a === '--name' || a === '-n') out.hostName = value();
    else if (a.startsWith('--name=')) out.hostName = a.slice(7);
    else if (a === '--no-open') out.open = false;
    else if (a === '--no-https') out.https = false;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version' || a === '-v') out.version = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  if (out.port !== undefined && (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535)) {
    throw new Error('--port must be a number between 1 and 65535');
  }
  return out;
}

const HELP = `
Dropspace ${VERSION}
Drag something onto one computer, it shows up on the other.

Usage: node server.js [options]

  -f, --folder <path>   Where files are saved, in one subfolder per Dropspace folder
                        (remembered for next time). Default: ~/Downloads/Dropspace
                        A folder can also save somewhere else; set that in the app.
  -n, --name <name>     Name other devices see for this computer
  -p, --port <number>   Port to use (default: 80 on a Mac if it's free, otherwise ${DEFAULT_PORT})
      --no-open         Don't open the browser on start
      --no-https        Don't offer the secure (https) address
  -h, --help            Show this help
`;

async function main() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) {
    console.error(`Dropspace needs Node.js 18 or newer. You have ${process.versions.node}. Get it at https://nodejs.org`);
    process.exit(1);
  }
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message + '\nRun with --help to see the options.');
    process.exit(1);
  }
  if (args.help) return console.log(HELP);
  if (args.version) return console.log(VERSION);

  // Already running (for example in the background after installing)? Open that one instead of starting another.
  const running = await findRunning(dropspaceHome());
  if (running) {
    const url = localUrlFor(running.port);
    console.log(`\n  Dropspace is already running at ${url}\n`);
    if (args.open !== false && !process.env.CI) openInBrowser(url);
    return;
  }

  const time = () => new Date().toLocaleTimeString();
  let app;
  try {
    app = await startDropspace({ ...args, log: (msg) => console.log(`  [${time()}] ${msg}`) });
  } catch (e) {
    console.error(`\n  Dropspace could not start: ${e.message}\n`);
    process.exit(1);
  }
  const info = app.hostInfo();
  const pin = `${app.pin.slice(0, 3)} ${app.pin.slice(3)}`;
  const lines = [
    '',
    `  Dropspace ${VERSION} is running.${AUTHOR ? ` Made by ${AUTHOR}.` : ''}`,
    '',
    `  On this computer:      ${app.localUrl}`,
  ];
  if (info.addresses.primary) {
    lines.push(`  On the other computer: ${info.addresses.primary}`);
    for (const other of info.addresses.others.slice(0, 2)) lines.push(`                     or: ${other}`);
  } else {
    lines.push('  No network found. Connect this computer to Wi-Fi, then restart Dropspace.');
  }
  if (info.secure) {
    const where = info.addresses.stable || info.addresses.primary;
    const shown = where ? new URL(where).hostname : 'localhost';
    lines.push(`  Secure address:        https://${shown.includes(':') ? `[${shown}]` : shown}${info.secure.port === 443 ? '' : `:${info.secure.port}`} (devices that trust it switch by themselves)`);
  }
  lines.push(
    `  Pairing code:          ${pin}`,
    '',
    `  Files are saved in:    ${displayPath(app.config.root)}`,
    process.env.DROPSPACE_SERVICE ? '  Running in the background.' : '  Keep this window open. Press Ctrl+C to stop.',
    '',
  );
  console.log(lines.join('\n'));

  if (args.open !== false && !process.env.CI) openInBrowser(app.localUrl);

  let stopping = false;
  const stop = async () => {
    if (stopping) return process.exit(0);
    stopping = true;
    console.log('\n  Stopping Dropspace…');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) main();

module.exports = { startDropspace, safeName, safeRelSegments, hostAllowed, findRunning, dropspaceHome, localUrlFor, formatBytes, computerName };
