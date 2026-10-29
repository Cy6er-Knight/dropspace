#!/usr/bin/env node
'use strict';
/*
 * Send files, folders or the clipboard to Dropspace. This is what "Send to Dropspace" in
 * Finder's right-click menu and the Control-Option-Command-V shortcut run, and it works
 * from Terminal too:
 *
 *   node send.js photo.png "Level 1"           send files and folders
 *   node send.js --clipboard                   send what you copied
 *   node send.js --to "Game Dev" photo.png     choose the folder (normally: the one you have open)
 *   node send.js --pair http://dropspace.local 123456
 *                                              let this Mac send to Dropspace running on another Mac
 *   node send.js --check                       is this Mac set up to send? (also turns on the secure connection)
 *
 * On the Mac running Dropspace it sends straight to it. Any other Mac pairs once first, and from then
 * on sends over the secure (https) connection, checking it against the certificate saved when pairing.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { findRunning, dropspaceHome, computerName } = require('./server.js');
const { readMacClipboard } = require('./clipboard.js');

const HOME = dropspaceHome();
const SENDER = path.join(HOME, 'sender.json');
// The main Mac's certificate authority, saved when pairing. The installer asks macOS to trust it, so browsers use https too.
const CA_FILE = path.join(HOME, 'ca.pem');
const LABEL = 'com.dropspace.server';
const AGENT = path.join(require('os').homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

class SendError extends Error {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Mac notification (and the same text in Terminal). */
function notify(message, error = false) {
  (error ? console.error : console.log)(message);
  if (process.platform !== 'darwin' || process.env.DROPSPACE_NO_NOTIFY) return Promise.resolve();
  const esc = (t) => String(t).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', `display notification "${esc(message)}" with title "Dropspace"`], () => resolve());
  });
}

function readSender() {
  try {
    const s = JSON.parse(fs.readFileSync(SENDER, 'utf8'));
    return s && typeof s.address === 'string' && typeof s.cookie === 'string' ? s : null;
  } catch {
    return null;
  }
}

/** Where to send: the Dropspace on this Mac, or the one this Mac is paired with. */
async function findTarget() {
  let running = await findRunning(HOME);
  if (!running && process.platform === 'darwin' && fs.existsSync(AGENT)) {
    // Installed here but not running right now: start it.
    execFile('/bin/launchctl', ['kickstart', `gui/${process.getuid()}/${LABEL}`], () => {});
    for (let i = 0; i < 40 && !running; i++) {
      await sleep(250);
      running = await findRunning(HOME);
    }
  }
  if (running) return { base: new URL(`http://127.0.0.1:${running.port}`), host: 'localhost', deviceId: 'this-mac', local: true };
  const sender = readSender();
  if (sender) {
    const plain = new URL(sender.address);
    const t = { base: plain, host: plain.host, cookie: sender.cookie, deviceId: sender.deviceId, local: false };
    const ca = readCa();
    // Once the secure connection is set up it's the only one used. Never falling back to the plain
    // address means someone on the Wi-Fi can't force a downgrade by faking the main Mac.
    if (sender.secure && ca) {
      const base = new URL(sender.secure);
      return { ...t, base, host: base.host, ca };
    }
    return t;
  }
  throw new SendError("Dropspace isn't set up on this Mac yet. Double-click Install Dropspace first.");
}

function readCa() {
  try {
    const pem = fs.readFileSync(CA_FILE, 'utf8');
    return pem.includes('BEGIN CERTIFICATE') ? pem : null;
  } catch {
    return null;
  }
}

function call(t, method, pathname, { json, file, headers = {}, pairing = false, raw = false, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const h = {
      'X-Dropspace': '1',
      Host: t.host,
      'X-Device-Id': t.deviceId || 'this-mac',
      'X-Device-Name': encodeURIComponent(computerName()),
      ...headers,
    };
    if (t.cookie) h.Cookie = t.cookie;
    let body = null;
    if (json !== undefined) {
      body = Buffer.from(JSON.stringify(json));
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = body.length;
    } else if (file) {
      h['Content-Length'] = file.size;
    }
    const secure = t.base.protocol === 'https:';
    const options = { hostname: t.base.hostname, port: t.base.port || (secure ? 443 : 80), path: pathname, method, headers: h, timeout };
    if (secure) options.ca = t.ca; // only the main Mac's own certificate authority is accepted
    const req = (secure ? https : http).request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        let data = null;
        try {
          data = raw ? body : JSON.parse(body.toString('utf8'));
        } catch {
          /* not JSON */
        }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ data, headers: res.headers });
        if (res.statusCode === 401 && !pairing) {
          return reject(new SendError("This Mac isn't paired with Dropspace anymore. Double-click Install Dropspace on this Mac to pair it again."));
        }
        reject(new SendError((data && data.error) || `Dropspace couldn't take that (error ${res.statusCode}).`));
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => {
      if (e instanceof SendError) return reject(e);
      if (['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(e.code)) {
        return reject(new SendError(`Can't reach Dropspace at ${t.host}. Check that your main Mac is awake and on the same Wi-Fi.`));
      }
      if (/CERT|SELF_SIGNED|ALTNAME|UNABLE_TO/.test(String(e.code))) {
        return reject(new SendError("The secure connection to your main Mac didn't check out. Double-click Install Dropspace on this Mac to set it up again."));
      }
      reject(e);
    });
    if (file) {
      const stream = fs.createReadStream(file.path);
      stream.on('error', (e) => req.destroy(e));
      stream.pipe(req);
    } else {
      req.end(body);
    }
  });
}

async function listFiles(dir, rel = '', out = []) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (/^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await listFiles(abs, rel ? `${rel}/${e.name}` : e.name, out);
    else if (e.isFile()) out.push({ abs, rel, name: e.name, size: (await fsp.stat(abs)).size });
  }
  return out;
}

/** Upload one file or folder. Resolves with the items Dropspace created. */
async function sendPath(t, p, spaceId, name) {
  let st;
  try {
    st = await fsp.stat(p);
  } catch {
    throw new SendError(`Couldn't open ${path.basename(p)}.`);
  }
  if (st.isFile()) {
    const { data } = await call(t, 'POST', '/api/upload', {
      file: { path: p, size: st.size },
      headers: { 'X-Filename': encodeURIComponent(name || path.basename(p)), 'X-Space': spaceId },
    });
    return [data.item];
  }
  if (st.isDirectory()) {
    const files = await listFiles(p);
    if (!files.length) return [];
    const { data: batch } = await call(t, 'POST', '/api/batch', { json: { name: path.basename(p), space: spaceId } });
    for (const f of files) {
      await call(t, 'POST', '/api/upload', {
        file: { path: f.abs, size: f.size },
        headers: { 'X-Filename': encodeURIComponent(f.name), 'X-Batch': batch.batchId, 'X-Relpath': encodeURIComponent(f.rel) },
      });
    }
    const { data: done } = await call(t, 'POST', `/api/batch/${batch.batchId}/done`, { json: {} });
    return done.item ? [done.item] : [];
  }
  return [];
}

/** The folder to send to: the one named with --to, or the one open in Dropspace on this Mac. */
async function chooseSpace(t, wanted) {
  const { data } = await call(t, 'GET', '/api/spaces');
  if (!wanted) return data.spaces.find((s) => s.id === data.current) || data.spaces[0];
  const match = data.spaces.find((s) => s.name.toLowerCase() === wanted.trim().toLowerCase());
  if (!match) throw new SendError(`There's no folder called "${wanted}" in Dropspace.`);
  return match;
}

function describe(items, space) {
  if (items.length === 1) {
    const it = items[0];
    const what = it.type === 'text' ? 'your note' : it.type === 'folder' ? `the ${it.name} folder` : it.name;
    return `Sent ${what} to ${space.name}`;
  }
  return `Sent ${items.length} items to ${space.name}`;
}

async function sendClipboard(t, space) {
  if (t.local) {
    const { data } = await call(t, 'POST', '/api/clipboard', { json: { space: space.id } });
    if (data.kind === 'image') return `Sent the copied image to ${space.name}`;
    if (data.kind === 'text') return `Sent the copied text to ${space.name}`;
    return describe(data.items, space);
  }
  if (process.platform !== 'darwin') throw new SendError('Sending the clipboard this way only works on a Mac.');
  const clip = await readMacClipboard();
  if (clip.kind === 'files') {
    const items = [];
    for (const p of clip.paths) items.push(...(await sendPath(t, p, space.id)));
    return describe(items, space);
  }
  if (clip.kind === 'image') {
    try {
      await sendPath(t, clip.path, space.id, clip.name);
    } finally {
      fs.rmSync(clip.path, { force: true });
    }
    return `Sent the copied image to ${space.name}`;
  }
  if (clip.kind === 'text') {
    await call(t, 'POST', '/api/text', { json: { text: clip.text, space: space.id } });
    return `Sent the copied text to ${space.name}`;
  }
  throw new SendError('The clipboard is empty. Copy something first.');
}

async function pair(address, code) {
  if (!address || !code) throw new SendError('Usage: node send.js --pair http://dropspace.local 123456');
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(address) ? address : `http://${address}`);
  } catch {
    throw new SendError(`"${address}" isn't an address. It looks like http://dropspace.local`);
  }
  const old = readSender();
  const deviceId = (old && old.deviceId) || crypto.randomBytes(9).toString('base64url');
  const t = { base: url, host: url.host, deviceId };
  const { headers } = await call(t, 'POST', '/api/pair', { json: { pin: String(code).replace(/\D/g, '') }, pairing: true });
  const cookie = (headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('dropspace_session='));
  if (!cookie) throw new SendError("Pairing didn't finish. Try again.");
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const sender = { address: url.origin, cookie, deviceId };
  fs.writeFileSync(SENDER, JSON.stringify(sender, null, 2), { mode: 0o600 });
  const secure = await setUpSecure({ ...t, cookie }, sender);
  return `This Mac can now send to Dropspace at ${secure || url.origin}.`;
}

/**
 * Save the main Mac's certificate and switch to its secure address, if it has one.
 * Resolves with the secure address, or null if it isn't available.
 */
async function setUpSecure(t, sender) {
  let who;
  try {
    ({ data: who } = await call(t, 'GET', '/api/whoami', { timeout: 5000 }));
  } catch {
    return null;
  }
  if (!who || !who.httpsPort) return null;
  const { data: pem } = await call(t, 'GET', '/ca.pem', { raw: true, timeout: 5000 });
  const ca = pem && pem.toString('utf8');
  if (!ca || !ca.includes('BEGIN CERTIFICATE')) return null;
  const host = t.base.hostname.includes(':') ? `[${t.base.hostname}]` : t.base.hostname;
  const base = new URL(`https://${host}${who.httpsPort === 443 ? '' : `:${who.httpsPort}`}`);
  try {
    const { data } = await call({ ...t, base, host: base.host, ca }, 'GET', '/api/whoami', { timeout: 5000 });
    if (!data || !data.paired) return null;
  } catch {
    return null;
  }
  fs.writeFileSync(CA_FILE, ca, { mode: 0o644 });
  fs.writeFileSync(SENDER, JSON.stringify({ ...sender, secure: base.origin }, null, 2), { mode: 0o600 });
  return base.origin;
}

/** For the installer: is this Mac set up to send, and is the secure connection on? */
async function check() {
  const t = await findTarget();
  if (t.local) return 'This is the Mac running Dropspace.';
  await call(t, 'GET', '/api/spaces');
  const sender = readSender();
  if (!sender.secure || !readCa()) {
    const plain = new URL(sender.address);
    const secure = await setUpSecure({ base: plain, host: plain.host, cookie: sender.cookie, deviceId: sender.deviceId }, sender);
    if (secure) return `Paired with ${sender.address}, now using ${secure}.`;
  }
  return `Paired with ${sender.secure || sender.address}.`;
}

async function main(argv) {
  const paths = [];
  let to = null;
  let clipboard = false;
  let pairArgs = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--clipboard') clipboard = true;
    else if (a === '--check') {
      console.log(await check());
      return 0;
    }
    else if (a === '--to') to = argv[++i];
    else if (a === '--pair') pairArgs = [argv[++i], argv[++i]];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node send.js [--to "Folder"] <files or folders…> | --clipboard | --pair <address> <code> | --check');
      return 0;
    } else paths.push(path.resolve(a));
  }
  if (pairArgs) {
    console.log(await pair(...pairArgs));
    return 0;
  }
  if (!clipboard && !paths.length) throw new SendError('Choose some files or folders to send.');
  const t = await findTarget();
  const space = await chooseSpace(t, to);
  let message;
  if (clipboard) message = await sendClipboard(t, space);
  else {
    const items = [];
    for (const p of paths) items.push(...(await sendPath(t, p, space.id)));
    if (!items.length) throw new SendError('There was nothing in there to send.');
    message = describe(items, space);
  }
  await notify(message);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    async (e) => {
      await notify(e instanceof SendError ? e.message : `Dropspace couldn't send that: ${e.message}`, true);
      process.exit(1);
    },
  );
}

module.exports = { main, pair, check };
