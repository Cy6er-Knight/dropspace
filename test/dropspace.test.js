'use strict';
// Run with: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { startDropspace, safeName, safeRelSegments, hostAllowed } = require('../server.js');
const { crc32 } = require('../zip.js');
const { execFile } = require('node:child_process');

// Stands in for macOS's `shortcuts sign`, which only exists on a Mac.
const fakeSign = async (xml) => Buffer.from(`signed:${xml.length}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dropspace-test-'));
const folder = path.join(tmp, 'inbox');
const home = path.join(tmp, 'home');
let app;
let cookie = '';

const REMOTE_HOST = () => `10.0.0.5:${app.port}`; // looks like another computer on the Wi-Fi

function request({ method = 'GET', path: p = '/', headers = {}, body, remote = false, auth = true }) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (remote) {
      h.Host = h.Host || REMOTE_HOST();
      if (auth && cookie) h.Cookie = cookie;
    }
    if (method !== 'GET' && method !== 'HEAD' && h['X-Dropspace'] === undefined) h['X-Dropspace'] = '1';
    let payload = body;
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      payload = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
    }
    if (payload !== undefined) h['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port: app.port, method, path: p, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try {
          json = JSON.parse(buf.toString());
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Open the live event stream and resolve with the first event of the given type. */
function waitForEvent(type, { remote = true } = {}) {
  return new Promise((resolve, reject) => {
    const headers = remote ? { Host: REMOTE_HOST(), Cookie: cookie } : {};
    const req = http.get({ host: '127.0.0.1', port: app.port, path: '/api/events?device=testdevice01&name=Tester', headers }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`status ${res.statusCode}`));
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block);
          const data = /^data: (.+)$/m.exec(block);
          if (ev && data && ev[1] === type) {
            req.destroy();
            resolve(JSON.parse(data[1]));
          }
        }
      });
    });
    req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
    setTimeout(() => reject(new Error(`no ${type} event`)), 4000).unref();
  });
}

/** The same request over the secure address, checked against Dropspace's own certificate. */
function secureRequest({ method = 'GET', path: p = '/', headers = {}, body, remote = false }) {
  return new Promise((resolve, reject) => {
    const h = { Host: remote ? `dropspace.local:${app.httpsPort}` : `localhost:${app.httpsPort}`, ...headers };
    if (remote && cookie && h.Cookie === undefined) h.Cookie = cookie;
    if (method !== 'GET' && h['X-Dropspace'] === undefined) h['X-Dropspace'] = '1';
    const payload = body && typeof body === 'object' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body;
    if (payload !== undefined) h['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request({
      host: '127.0.0.1', port: app.httpsPort, method, path: p, headers: h,
      servername: remote ? 'dropspace.local' : 'localhost', ca: fs.readFileSync(path.join(home, 'tls', 'ca.pem')),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try {
          json = JSON.parse(buf.toString());
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** A tiny zip reader: names to contents, checking every checksum. */
function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const skip = buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const at = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    const data = buf.subarray(start, start + size);
    assert.equal(crc32(data), crc, `checksum of ${name}`);
    out[name] = data.toString();
    p += 46 + nameLen + skip;
  }
  return out;
}

function multipartBody(boundary, parts) {
  const chunks = [];
  for (const part of parts) {
    const disp = part.filename !== undefined ? `form-data; name="${part.name}"; filename="${part.filename}"` : `form-data; name="${part.name}"`;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disp}\r\n${part.type ? `Content-Type: ${part.type}\r\n` : ''}\r\n`), Buffer.from(part.data), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

before(async () => {
  app = await startDropspace({ port: 0, folder, home, log: false, hostName: 'Test Mac', signShortcut: fakeSign });
});

after(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('file names cannot escape the folder', () => {
  assert.equal(safeName('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(safeName('..'), 'file');
  assert.equal(safeName('.hidden'), 'hidden');
  assert.equal(safeName('CON.txt'), '_CON.txt');
  assert.ok(Buffer.byteLength(safeName('a'.repeat(400) + '.png')) <= 200);
  assert.deepEqual(safeRelSegments('../a/./../b//c'), ['a', 'b', 'c']);
  assert.deepEqual(safeRelSegments('..\\..\\windows'), ['windows']);
});

test('only local network host names are answered (blocks DNS rebinding)', async () => {
  assert.equal(hostAllowed('192.168.1.20:8765', []), true);
  assert.equal(hostAllowed('my-mac.local:8765', []), true);
  assert.equal(hostAllowed('localhost:8765', []), true);
  assert.equal(hostAllowed('evil.example.com', []), false);
  const res = await request({ path: '/', headers: { Host: 'attacker.example.com' } });
  assert.equal(res.status, 403);
});

test('the host computer is trusted, other devices are not until paired', async () => {
  const local = await request({ path: '/api/whoami' });
  assert.equal(local.json.paired, true);
  assert.equal(local.json.local, true);
  const remote = await request({ path: '/api/whoami', remote: true, auth: false });
  assert.equal(remote.json.paired, false);
  const events = await request({ path: '/api/events', remote: true, auth: false });
  assert.equal(events.status, 401);
});

test('other websites cannot post to Dropspace', async () => {
  const noHeader = await request({ method: 'POST', path: '/api/text', body: { text: 'x' }, headers: { 'X-Dropspace': '' } });
  assert.equal(noHeader.status, 403);
  const crossSite = await request({ method: 'POST', path: '/api/text', body: { text: 'x' }, headers: { Origin: 'https://evil.example.com' } });
  assert.equal(crossSite.status, 403);
});

test('pairing with the code gives the device a session', async () => {
  const wrongPin = app.pin === '000000' ? '111111' : '000000';
  const wrong = await request({ method: 'POST', path: '/api/pair', body: { pin: wrongPin }, remote: true, auth: false });
  assert.equal(wrong.status, 401);
  const ok = await request({ method: 'POST', path: '/api/pair', body: { pin: app.pin }, remote: true, auth: false });
  assert.equal(ok.status, 200);
  const setCookie = ok.headers['set-cookie'][0];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  cookie = setCookie.split(';')[0];
  const who = await request({ path: '/api/whoami', remote: true });
  assert.equal(who.json.paired, true);
  assert.equal(who.json.local, false);
});

test('text sent from one device reaches the others live', async () => {
  const arrival = waitForEvent('item');
  await new Promise((r) => setTimeout(r, 100));
  const sent = await request({ method: 'POST', path: '/api/text', body: { text: 'hello from the other computer' }, headers: { 'X-Device-Name': 'iMac' }, remote: true });
  assert.equal(sent.status, 200);
  const item = await arrival;
  assert.equal(item.text, 'hello from the other computer');
  assert.equal(item.from.name, 'iMac');
});

test('files are saved into the folder, downloadable, and support ranges', async () => {
  const data = Buffer.from('fake png bytes 0123456789');
  const up = await request({ method: 'POST', path: '/api/upload', body: data, headers: { 'X-Filename': encodeURIComponent('../../sneaky.png') }, remote: true });
  assert.equal(up.status, 200);
  const item = up.json.item;
  assert.equal(item.kind, 'image');
  assert.equal(item.abs, undefined, 'never leak paths to other devices');
  const saved = path.join(folder, 'General', item.name);
  assert.ok(fs.existsSync(saved), 'saved inside the General folder');
  assert.equal(item.space, 'general');
  assert.deepEqual(fs.readFileSync(saved), data);

  const again = await request({ method: 'POST', path: '/api/upload', body: data, headers: { 'X-Filename': encodeURIComponent('../../sneaky.png') }, remote: true });
  assert.notEqual(again.json.item.name, item.name, 'same name does not overwrite');

  const dl = await request({ path: `/api/file/${item.id}/${encodeURIComponent(item.name)}`, remote: true });
  assert.equal(dl.status, 200);
  assert.deepEqual(dl.body, data);
  assert.match(dl.headers['content-security-policy'], /sandbox/);

  const part = await request({ path: `/api/file/${item.id}`, headers: { Range: 'bytes=5-7' }, remote: true });
  assert.equal(part.status, 206);
  assert.equal(part.body.toString(), 'png');

  const unpaired = await request({ path: `/api/file/${item.id}`, remote: true, auth: false });
  assert.equal(unpaired.status, 401);
});

test('risky file types download instead of opening in the browser', async () => {
  const up = await request({ method: 'POST', path: '/api/upload', body: Buffer.from('<script>alert(1)</script>'), headers: { 'X-Filename': 'page.html' }, remote: true });
  const res = await request({ path: `/api/file/${up.json.item.id}`, remote: true });
  assert.match(res.headers['content-disposition'], /^attachment/);
});

test('folders keep their structure and cannot escape', async () => {
  const start = await request({ method: 'POST', path: '/api/batch', body: { name: 'Game Assets' }, headers: { 'X-Device-Id': 'folderdevice' }, remote: true });
  assert.equal(start.status, 200);
  const { batchId } = start.json;
  for (const [rel, name] of [['textures', 'wood.png'], ['../../outside', 'evil.txt'], ['', 'readme.txt']]) {
    const r = await request({
      method: 'POST', path: '/api/upload', body: Buffer.from(name),
      headers: { 'X-Filename': name, 'X-Batch': batchId, 'X-Relpath': encodeURIComponent(rel), 'X-Device-Id': 'folderdevice' }, remote: true,
    });
    assert.equal(r.status, 200);
  }
  const done = await request({ method: 'POST', path: `/api/batch/${batchId}/done`, body: {}, headers: { 'X-Device-Id': 'folderdevice' }, remote: true });
  assert.equal(done.json.item.count, 3);
  assert.ok(fs.existsSync(path.join(folder, 'General', 'Game Assets', 'textures', 'wood.png')));
  assert.ok(fs.existsSync(path.join(folder, 'General', 'Game Assets', 'outside', 'evil.txt')));
  assert.ok(!fs.existsSync(path.join(tmp, 'outside')));
});

test('host-only controls are refused from other devices', async () => {
  for (const p of ['/api/pair-token', '/api/spaces/general/location', '/api/forget-devices', '/api/spaces/general/reveal', '/api/open', '/api/clipboard']) {
    const r = await request({ method: 'POST', path: p, body: { folder: '/tmp' }, remote: true });
    assert.equal(r.status, 403, p);
  }
});

test('folders keep their items and files separate', async () => {
  const made = await request({ method: 'POST', path: '/api/spaces', body: { name: '  Game   Dev ' }, remote: true });
  assert.equal(made.status, 200);
  const game = made.json.space;
  assert.equal(game.name, 'Game Dev');
  assert.equal(game.folderDisplay, undefined, 'other devices never see paths');

  const dupe = await request({ method: 'POST', path: '/api/spaces', body: { name: 'game dev' }, remote: true });
  assert.equal(dupe.status, 409);

  const up = await request({ method: 'POST', path: '/api/upload', body: Buffer.from('sprite'), headers: { 'X-Filename': 'knight.png', 'X-Space': game.id }, remote: true });
  assert.equal(up.json.item.space, game.id);
  assert.ok(fs.existsSync(path.join(folder, 'Game Dev', 'knight.png')), 'saved in its own folder on disk');

  const note = await request({ method: 'POST', path: '/api/text', body: { text: 'work note', space: game.id }, remote: true });
  assert.equal(note.json.item.space, game.id);

  const gone = await request({ method: 'POST', path: '/api/text', body: { text: 'x', space: 'nope' }, remote: true });
  assert.equal(gone.status, 404);

  // Clearing one folder leaves the others alone.
  await request({ method: 'DELETE', path: `/api/items?space=${game.id}`, remote: true });
  const hello = await waitForEvent('hello', { remote: false });
  assert.ok(!hello.items.some((i) => i.space === game.id));
  assert.ok(hello.items.some((i) => i.space === 'general'));
  assert.ok(fs.existsSync(path.join(folder, 'Game Dev', 'knight.png')), 'clearing never deletes files');
});

test('renaming a folder renames it on disk and keeps its files working', async () => {
  const { json } = await request({ method: 'POST', path: '/api/spaces', body: { name: 'Work' } });
  const id = json.space.id;
  const up = await request({ method: 'POST', path: '/api/upload', body: Buffer.from('report'), headers: { 'X-Filename': 'report.pdf', 'X-Space': id } });
  const renamed = await request({ method: 'PATCH', path: `/api/spaces/${id}`, body: { name: 'School' }, remote: true });
  assert.equal(renamed.status, 200);
  assert.ok(fs.existsSync(path.join(folder, 'School', 'report.pdf')));
  assert.ok(!fs.existsSync(path.join(folder, 'Work')));
  const dl = await request({ path: `/api/file/${up.json.item.id}`, remote: true });
  assert.equal(dl.body.toString(), 'report');
});

test('a folder can save somewhere else, set from the host only', async () => {
  const { json } = await request({ method: 'POST', path: '/api/spaces', body: { name: 'Assets' } });
  const target = path.join(tmp, 'MyGame', 'Assets');
  const remoteTry = await request({ method: 'POST', path: `/api/spaces/${json.space.id}/location`, body: { folder: target }, remote: true });
  assert.equal(remoteTry.status, 403);
  const set = await request({ method: 'POST', path: `/api/spaces/${json.space.id}/location`, body: { folder: target } });
  assert.equal(set.status, 200);
  await request({ method: 'POST', path: '/api/upload', body: Buffer.from('tex'), headers: { 'X-Filename': 'stone.png', 'X-Space': json.space.id }, remote: true });
  assert.ok(fs.existsSync(path.join(target, 'stone.png')));
});

test('deleting a folder removes it from the board but keeps files, and one folder always stays', async () => {
  const { json } = await request({ method: 'POST', path: '/api/spaces', body: { name: 'Temp' } });
  await request({ method: 'POST', path: '/api/upload', body: Buffer.from('t'), headers: { 'X-Filename': 'keep.txt', 'X-Space': json.space.id } });
  const del = await request({ method: 'DELETE', path: `/api/spaces/${json.space.id}`, remote: true });
  assert.equal(del.status, 200);
  assert.ok(fs.existsSync(path.join(folder, 'Temp', 'keep.txt')));
  const hello = await waitForEvent('hello', { remote: false });
  assert.ok(!hello.spaces.some((s) => s.id === json.space.id));
  assert.ok(!hello.items.some((i) => i.space === json.space.id));
  for (const s of hello.spaces.slice(1)) await request({ method: 'DELETE', path: `/api/spaces/${s.id}` });
  const last = await request({ method: 'DELETE', path: `/api/spaces/${hello.spaces[0].id}` });
  assert.equal(last.status, 400);
});

test('app icons and the web app manifest are served', async () => {
  const manifest = await request({ path: '/manifest.webmanifest', remote: true, auth: false });
  assert.equal(manifest.status, 200);
  assert.equal(JSON.parse(manifest.body.toString()).name, 'Dropspace');
  const icon = await request({ path: '/apple-touch-icon.png', remote: true, auth: false });
  assert.equal(icon.headers['content-type'], 'image/png');
  assert.deepEqual([...icon.body.subarray(1, 4)].map((c) => String.fromCharCode(c)).join(''), 'PNG');
});

test('a paired device can carry its pairing to the permanent address', async () => {
  const unpaired = await request({ method: 'POST', path: '/api/move-token', remote: true, auth: false });
  assert.equal(unpaired.status, 401);
  const r = await request({ method: 'POST', path: '/api/move-token', remote: true });
  assert.equal(r.status, 200);
  const moved = await request({ method: 'POST', path: '/api/pair', body: { token: r.json.token }, remote: true, auth: false, headers: { Host: `dropspace.local:${app.port}` } });
  assert.equal(moved.status, 200);
});

test('Dropspace notes where it is running, and a second start opens the first instead', async () => {
  const status = JSON.parse(fs.readFileSync(path.join(home, 'status.json'), 'utf8'));
  assert.equal(status.port, app.port);
  assert.equal(status.pid, process.pid);
  const out = await new Promise((resolve) => {
    execFile(process.execPath, [path.join(__dirname, '..', 'server.js'), '--no-open'], { env: { ...process.env, DROPSPACE_HOME: home }, timeout: 8000 }, (err, stdout) => resolve({ err, stdout }));
  });
  assert.equal(out.err, null, 'exits cleanly');
  assert.match(out.stdout, /already running/);
});

test('sending without picking a folder uses the folder that device has open', async () => {
  const { json } = await request({ method: 'POST', path: '/api/spaces', body: { name: 'Sprites' } });
  const focus = await request({ method: 'POST', path: '/api/focus', body: { space: json.space.id }, remote: true });
  assert.equal(focus.status, 200);
  const list = await request({ path: '/api/spaces', remote: true });
  assert.equal(list.json.current, json.space.id);
  const up = await request({ method: 'POST', path: '/api/upload', body: Buffer.from('px'), headers: { 'X-Filename': 'hero.png' }, remote: true });
  assert.equal(up.json.item.space, json.space.id);
  assert.ok(fs.existsSync(path.join(folder, 'Sprites', 'hero.png')));
});

const SEND = path.join(__dirname, '..', 'send.js');
function runSend(args, envHome) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SEND, ...args], { env: { ...process.env, DROPSPACE_HOME: envHome, DROPSPACE_NO_NOTIFY: '1' }, timeout: 20000 },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr }));
  });
}

test('the send tool (used by Finder\'s right-click) sends files and folders on the main Mac', async () => {
  const src = path.join(tmp, 'to-send');
  fs.mkdirSync(path.join(src, 'Level 1', 'tiles'), { recursive: true });
  fs.writeFileSync(path.join(src, 'boss.png'), 'boss');
  fs.writeFileSync(path.join(src, 'Level 1', 'tiles', 'grass.png'), 'grass');
  fs.writeFileSync(path.join(src, 'Level 1', 'map.json'), '{}');
  const r = await runSend(['--to', 'sprites', path.join(src, 'boss.png'), path.join(src, 'Level 1')], home);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Sent 2 items to Sprites/);
  assert.ok(fs.existsSync(path.join(folder, 'Sprites', 'boss.png')));
  assert.ok(fs.existsSync(path.join(folder, 'Sprites', 'Level 1', 'tiles', 'grass.png')));
  const missing = await runSend(['--to', 'Nope', path.join(src, 'boss.png')], home);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /no folder called "Nope"/);
});

test('another Mac pairs once, then its right-click sends over the Wi-Fi', async (t) => {
  const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && (a.family === 'IPv4' || a.family === 4) && !a.internal);
  if (!lan) return t.skip('no network address to test with');
  const senderHome = path.join(tmp, 'other-mac');
  const notSetUp = await runSend([path.join(tmp, 'to-send', 'boss.png')], senderHome);
  assert.equal(notSetUp.code, 1);
  assert.match(notSetUp.out, /isn't set up on this Mac/);

  const wrong = await runSend(['--pair', `http://${lan.address}:${app.port}`, app.pin === '000000' ? '111111' : '000000'], senderHome);
  assert.equal(wrong.code, 1);
  assert.match(wrong.out, /does not match/);
  const paired = await runSend(['--pair', `http://${lan.address}:${app.port}`, app.pin], senderHome);
  assert.equal(paired.code, 0, paired.out);
  const saved = JSON.parse(fs.readFileSync(path.join(senderHome, 'sender.json'), 'utf8'));
  assert.match(saved.cookie, /^dropspace_session=/);
  assert.equal((fs.statSync(path.join(senderHome, 'sender.json')).mode & 0o777).toString(8), '600');

  const sent = await runSend(['--to', 'Sprites', path.join(tmp, 'to-send', 'boss.png')], senderHome);
  assert.equal(sent.code, 0, sent.out);
  assert.match(sent.out, /Sent boss( \(1\))?\.png to Sprites/);
  const hello = await waitForEvent('hello', { remote: false });
  const item = hello.items.filter((i) => i.name && i.name.startsWith('boss')).pop();
  assert.equal(item.from.host, false, 'arrived as another device');
});

test('Send Clipboard on the main Mac adds what was copied: files, an image, or text', async () => {
  const clipHome = path.join(tmp, 'clip-home');
  const clipFolder = path.join(tmp, 'clip-inbox');
  const queue = [];
  const local = await startDropspace({ port: 0, folder: clipFolder, home: clipHome, log: false, readClipboard: async () => queue.shift() });
  const post = (body, headers = {}) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: local.port, method: 'POST', path: '/api/clipboard', headers: { Host: `localhost:${local.port}`, 'X-Dropspace': '1', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
    });
    req.on('error', reject);
    req.end(data);
  });
  try {
    queue.push({ kind: 'text', text: 'copied prompt ✨' });
    const text = await post({});
    assert.equal(text.status, 200);
    assert.equal(text.json.items[0].text, 'copied prompt ✨');

    const img = path.join(tmp, 'clip.png');
    fs.writeFileSync(img, 'png-bytes');
    queue.push({ kind: 'image', path: img, name: 'Clipboard image 2026-10-23 at 20.00.00.png' });
    const image = await post({});
    assert.equal(image.json.items[0].name, 'Clipboard image 2026-10-23 at 20.00.00.png');
    assert.ok(!fs.existsSync(img), 'temporary image cleaned up');

    const dir = path.join(tmp, 'copied-folder');
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'a');
    fs.symlinkSync('/etc/passwd', path.join(dir, 'sneaky-link'));
    fs.writeFileSync(path.join(tmp, 'copied.txt'), 'c');
    queue.push({ kind: 'files', paths: [dir, path.join(tmp, 'copied.txt')] });
    const files = await post({});
    assert.equal(files.json.items.length, 2);
    assert.equal(files.json.items[0].count, 1, 'links inside folders are skipped');
    assert.ok(fs.existsSync(path.join(clipFolder, 'General', 'copied-folder', 'sub', 'a.txt')));
    assert.ok(!fs.existsSync(path.join(clipFolder, 'General', 'copied-folder', 'sneaky-link')));

    queue.push({ kind: 'empty' });
    const empty = await post({});
    assert.equal(empty.status, 400);
    assert.match(empty.json.error, /clipboard is empty/);

    const remote = await post({}, { Host: `10.0.0.5:${local.port}` });
    assert.ok([401, 403].includes(remote.status), 'other devices cannot read this Mac\'s clipboard');
  } finally {
    await local.close();
  }
});

test('reading a Mac clipboard picks files first, then an image, then text', async () => {
  const { readMacClipboard } = require('../clipboard.js');
  const dir = fs.mkdtempSync(path.join(tmp, 'clip-'));
  const copied = path.join(dir, 'copied file.png');
  fs.writeFileSync(copied, 'x');
  // Pretend to be macOS's osascript, sips and pbpaste.
  const fake = (info, extra = {}) => async (cmd, args) => {
    if (cmd.endsWith('osascript') && args[1] === 'clipboard info') return info;
    if (cmd.endsWith('osascript') && args[1] === 'JavaScript') return JSON.stringify([`file://${encodeURI(copied)}`]);
    if (cmd.endsWith('osascript')) {
      const target = /POSIX file "([^"]+)"/.exec(args.join(' '))[1];
      fs.writeFileSync(target, 'image-bytes');
      return '';
    }
    if (cmd.endsWith('sips')) {
      fs.writeFileSync(args[args.length - 1], 'png-bytes');
      return '';
    }
    if (cmd.endsWith('pbpaste')) return extra.text || '';
    throw new Error(`unexpected ${cmd}`);
  };
  const files = await readMacClipboard({ run: fake('«class furl», 40, «class icns», 9000, «class utf8», 14'), tmpdir: dir });
  assert.deepEqual(files, { kind: 'files', paths: [copied] });

  const png = await readMacClipboard({ run: fake('«class PNGf», 2000, «class TIFF», 9000'), tmpdir: dir });
  assert.equal(png.kind, 'image');
  assert.match(png.name, /^Clipboard image .+\.png$/);
  assert.equal(fs.readFileSync(png.path, 'utf8'), 'image-bytes');

  const tiff = await readMacClipboard({ run: fake('«class TIFF», 9000'), tmpdir: dir });
  assert.equal(tiff.kind, 'image');
  assert.match(tiff.path, /\.png$/, 'TIFF is converted to PNG');
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tiff')).length, 0);

  const text = await readMacClipboard({ run: fake('«class utf8», 12, string, 12', { text: 'hello there' }), tmpdir: dir });
  assert.deepEqual(text, { kind: 'text', text: 'hello there' });

  const empty = await readMacClipboard({ run: fake(''), tmpdir: dir });
  assert.deepEqual(empty, { kind: 'empty' });
});

test('another Mac sends over the secure connection after pairing', async () => {
  const prev = process.env.DROPSPACE_ADDRESS;
  process.env.DROPSPACE_ADDRESS = 'http://127.0.0.2'; // an address the certificate covers, standing in for the Wi-Fi one
  const mainHome = path.join(tmp, 'secure-main');
  const mainFolder = path.join(tmp, 'secure-inbox');
  const main = await startDropspace({ port: 0, folder: mainFolder, home: mainHome, log: false, hostName: 'Main Mac' });
  if (prev === undefined) delete process.env.DROPSPACE_ADDRESS;
  else process.env.DROPSPACE_ADDRESS = prev;
  try {
    assert.ok(main.httpsPort, 'the secure address is on');
    const senderHome = path.join(tmp, 'secure-sender');
    const paired = await runSend(['--pair', `http://127.0.0.2:${main.port}`, main.pin], senderHome);
    assert.equal(paired.code, 0, paired.out);
    assert.match(paired.out, new RegExp(`https://127\\.0\\.0\\.2:${main.httpsPort}`));
    const saved = JSON.parse(fs.readFileSync(path.join(senderHome, 'sender.json'), 'utf8'));
    assert.equal(saved.secure, `https://127.0.0.2:${main.httpsPort}`);
    assert.equal(fs.readFileSync(path.join(senderHome, 'ca.pem'), 'utf8'), fs.readFileSync(path.join(mainHome, 'tls', 'ca.pem'), 'utf8'));

    const file = path.join(tmp, 'secure-file.png');
    fs.writeFileSync(file, 'sent securely');
    const sent = await runSend([file], senderHome);
    assert.equal(sent.code, 0, sent.out);
    assert.equal(fs.readFileSync(path.join(mainFolder, 'General', 'secure-file.png'), 'utf8'), 'sent securely');

    const checked = await runSend(['--check'], senderHome);
    assert.equal(checked.code, 0, checked.out);
    assert.match(checked.out, /Paired with https:/);

    // A different certificate (someone pretending to be the main Mac) is refused.
    fs.writeFileSync(path.join(senderHome, 'ca.pem'), require('../tls.js').createAuthority('impostor').certPem);
    const tricked = await runSend([file], senderHome);
    assert.equal(tricked.code, 1, 'never trusts the wrong certificate, and never falls back to the plain address');
    assert.match(tricked.out, /secure connection to your main Mac didn't check out/);
  } finally {
    await main.close();
  }
});

test('several items download as one zip, with folders and notes inside', async () => {
  const a = await request({ method: 'POST', path: '/api/upload', body: Buffer.from('first'), headers: { 'X-Filename': 'tile.png', 'X-Space': 'general' }, remote: true });
  const b = await request({ method: 'POST', path: '/api/upload', body: Buffer.from('second'), headers: { 'X-Filename': 'tile.png', 'X-Space': 'general' }, remote: true });
  const note = await request({ method: 'POST', path: '/api/text', body: { text: 'Zip me please. moonlit castle', space: 'general' }, remote: true });
  const hello = await waitForEvent('hello', { remote: false });
  const folderItem = hello.items.find((i) => i.type === 'folder' && i.name === 'Game Assets');
  const ids = [a.json.item.id, b.json.item.id, note.json.item.id, folderItem.id];

  const unpaired = await request({ method: 'POST', path: '/api/zip', body: { ids }, remote: true, auth: false });
  assert.equal(unpaired.status, 401);
  const made = await request({ method: 'POST', path: '/api/zip', body: { ids }, remote: true });
  assert.equal(made.status, 200);
  assert.equal(made.json.name, 'General - 4 items.zip');
  const zip = await request({ path: made.json.url, remote: true });
  assert.equal(zip.status, 200);
  assert.equal(zip.headers['content-type'], 'application/zip');
  assert.equal(Number(zip.headers['content-length']), zip.body.length, 'exact size up front, so downloads show progress');
  assert.match(zip.headers['content-disposition'], /^attachment/);
  const files = readZip(zip.body);
  assert.equal(files['tile.png'], 'first');
  assert.equal(files[b.json.item.name], 'second');
  assert.equal(files['Zip me please.txt'], 'Zip me please. moonlit castle');
  assert.equal(files['Game Assets/textures/wood.png'], 'wood.png');
  assert.equal(files['Game Assets/readme.txt'], 'readme.txt');

  const folderOnly = await request({ method: 'POST', path: '/api/zip', body: { ids: [folderItem.id] }, remote: true });
  assert.equal(folderOnly.json.name, 'Game Assets.zip');
  const gone = await request({ path: '/api/zip/notarealtoken/x.zip', remote: true });
  assert.equal(gone.status, 404);
});

test('a zip over 4 GB uses ZIP64, and other zip tools can read it', async (t) => {
  const { planZip, writeZip } = require('../zip.js');
  const data = Buffer.from('hello');
  const plan = planZip([{ name: 'a.txt', data, size: data.length, crc: crc32(data), mtime: Date.now() }], { forceZip64: true });
  const out = path.join(tmp, 'z64.zip');
  const stream = fs.createWriteStream(out);
  await writeZip(stream, plan);
  await new Promise((r) => stream.end(r));
  assert.equal(fs.statSync(out).size, plan.total);
  const unzip = await new Promise((resolve) => execFile('unzip', ['-p', out, 'a.txt'], (err, stdout) => resolve(err ? null : stdout)));
  if (unzip === null) return t.skip('unzip is not installed here');
  assert.equal(unzip, 'hello');
});

test('several items can be deleted together, and their files stay', async () => {
  const one = await request({ method: 'POST', path: '/api/upload', body: Buffer.from('1'), headers: { 'X-Filename': 'bulk-one.txt', 'X-Space': 'general' }, remote: true });
  const two = await request({ method: 'POST', path: '/api/text', body: { text: 'bulk note', space: 'general' }, remote: true });
  const removal = waitForEvent('remove', { remote: false });
  await new Promise((r) => setTimeout(r, 100));
  const del = await request({ method: 'POST', path: '/api/items/delete', body: { ids: [one.json.item.id, two.json.item.id, 'missing'] }, remote: true });
  assert.equal(del.json.removed, 2);
  assert.deepEqual((await removal).ids.sort(), [one.json.item.id, two.json.item.id].sort());
  const hello = await waitForEvent('hello', { remote: false });
  assert.ok(!hello.items.some((i) => i.id === one.json.item.id || i.id === two.json.item.id));
  assert.ok(fs.existsSync(path.join(folder, 'General', 'bulk-one.txt')), 'deleting from Dropspace keeps the saved file');
});

test("a phone's Share button sends photos and files with its own key", async () => {
  const made = await request({ method: 'POST', path: '/api/share-keys', body: { name: 'Ansar’s iPhone' }, remote: true });
  assert.equal(made.status, 200);
  const url = new URL(made.json.url);
  assert.equal(url.pathname, '/api/share');
  assert.match(made.json.download, /\/api\/shortcut\/.+\/Send%20to%20Dropspace\.shortcut$/);
  const shortcutFile = await request({ path: made.json.download, remote: true });
  assert.match(shortcutFile.body.toString(), /^signed:\d+$/);
  assert.match(shortcutFile.headers['content-disposition'], /Send to Dropspace\.shortcut/);

  // What the Shortcuts app sends: a form with the photo (and here, a note and an empty field too).
  const boundary = 'ShortcutsBoundary42';
  const body = multipartBody(boundary, [
    { name: 'file', filename: 'IMG_0001.HEIC', type: 'image/heic', data: 'heic-bytes' },
    { name: 'comment', data: 'from my phone' },
    { name: 'empty', filename: '', type: 'application/octet-stream', data: '' },
  ]);
  const share = (headers, payload, pathAndQuery = url.pathname + url.search) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, method: 'POST', path: pathAndQuery, headers: { Host: url.host, 'Content-Length': payload.length, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
    });
    req.on('error', reject);
    req.end(payload);
  });
  const sent = await share({ 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body);
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.equal(sent.json.count, 2);
  assert.equal(sent.json.folder, 'Sprites', 'lands in the folder open on the host');
  assert.equal(fs.readFileSync(path.join(folder, 'Sprites', 'IMG_0001.HEIC'), 'utf8'), 'heic-bytes');
  const hello = await waitForEvent('hello', { remote: false });
  const photo = hello.items.find((i) => i.name === 'IMG_0001.HEIC');
  assert.equal(photo.from.name, 'Ansar’s iPhone');
  assert.ok(hello.items.some((i) => i.text === 'from my phone'));
  assert.ok(hello.host.shareKeys.some((k) => k.name === 'Ansar’s iPhone' && k.lastUsed > 0));

  // A raw file with the key in a header works too, and gets an extension from its type.
  const [id, secret] = url.searchParams.get('key').split('.');
  const raw = await share({ Authorization: `Bearer ${id}.${secret}`, 'Content-Type': 'image/jpeg' }, Buffer.from('jpeg'), '/api/share');
  assert.equal(raw.status, 200);
  assert.ok(fs.readdirSync(path.join(folder, 'Sprites')).some((f) => /^Shared photo .+\.jpg$/.test(f)));

  const wrong = await share({ 'Content-Type': 'text/plain' }, Buffer.from('x'), `/api/share?key=${id}.${'A'.repeat(32)}`);
  assert.equal(wrong.status, 401);
  const noCsrfBypass = await request({ method: 'POST', path: '/api/text', body: { text: 'x' }, headers: { Authorization: `Bearer ${id}.${secret}`, Host: url.host } });
  assert.equal(noCsrfBypass.status, 401, 'the key only works for sharing, nothing else');

  await request({ method: 'DELETE', path: `/api/share-keys/${id}`, remote: true });
  const revoked = await share({ 'Content-Type': 'text/plain' }, Buffer.from('x'));
  assert.equal(revoked.status, 401);
});

test("the secure address works with Dropspace's own certificate", async () => {
  assert.ok(app.httpsPort);
  const who = await secureRequest({ path: '/api/whoami' });
  assert.equal(who.status, 200);
  assert.equal(who.json.secure, true);
  assert.equal(who.json.local, true);

  // A device paired on the plain address carries on securely, and its pairing is then only sent encrypted.
  const remoteWho = await secureRequest({ path: '/api/whoami', remote: true });
  assert.equal(remoteWho.json.paired, true);
  assert.match(remoteWho.headers['set-cookie'][0], /; Secure/);
  const plainWho = await request({ path: '/api/whoami', remote: true });
  assert.equal(plainWho.json.httpsPort, app.httpsPort, 'the plain address tells devices where the secure one is');

  const good = await secureRequest({ method: 'POST', path: '/api/text', body: { text: 'over https' }, remote: true, headers: { Origin: `https://dropspace.local:${app.httpsPort}`, 'Content-Type': 'application/json' } });
  assert.equal(good.status, 200);
  const wrongScheme = await secureRequest({ method: 'POST', path: '/api/text', body: { text: 'x' }, remote: true, headers: { Origin: `http://dropspace.local:${app.httpsPort}`, 'Content-Type': 'application/json' } });
  assert.equal(wrongScheme.status, 403);

  const page = await request({ path: '/', remote: true, auth: false });
  assert.match(page.headers['content-security-policy'], new RegExp(`img-src [^;]*https://10\\.0\\.0\\.5:${app.httpsPort}`), 'the page may check whether the secure address works');
  const pem = await request({ path: '/ca.pem', remote: true, auth: false });
  assert.match(pem.body.toString(), /BEGIN CERTIFICATE/);
  const profile = await request({ path: '/dropspace.mobileconfig', remote: true, auth: false });
  assert.equal(profile.headers['content-type'], 'application/x-apple-aspen-config');
  assert.match(profile.body.toString(), /com\.apple\.security\.root/);
  const der = await request({ path: '/dropspace-ca.crt', remote: true, auth: false });
  assert.equal(der.body[0], 0x30, 'a DER certificate for Windows and Android');
});

test('"Secure connections only" turns away the plain address', async () => {
  const remoteTry = await request({ method: 'POST', path: '/api/settings', body: { secureOnly: true }, remote: true });
  assert.equal(remoteTry.status, 403, 'only the host can change it');
  const on = await request({ method: 'POST', path: '/api/settings', body: { secureOnly: true } });
  assert.equal(on.status, 200);
  try {
    const plain = await request({ path: '/api/spaces', remote: true });
    assert.equal(plain.status, 403);
    assert.match(plain.json.error, /only allows secure connections/);
    const who = await request({ path: '/api/whoami', remote: true });
    assert.equal(who.json.secureOnly, true);
    const page = await request({ path: '/', remote: true, auth: false });
    assert.equal(page.status, 200, 'the page still loads, to explain what to do');
    const secure = await secureRequest({ path: '/api/spaces', remote: true });
    assert.equal(secure.status, 200);
    const local = await request({ path: '/api/spaces' });
    assert.equal(local.status, 200, 'the host itself is never locked out');
  } finally {
    await request({ method: 'POST', path: '/api/settings', body: { secureOnly: false } });
  }
  const back = await request({ path: '/api/spaces', remote: true });
  assert.equal(back.status, 200);
});

test('the certificate authority only vouches for local names and addresses', () => {
  const T = require('../tls.js');
  const ca = T.createAuthority('Test');
  const leaf = T.issueServerCert({ certPem: ca.certPem, keyPem: ca.keyPem }, { dnsNames: ['dropspace.local', 'evil.example.com', 'localhost'], ips: ['192.168.1.20', '8.8.8.8'] });
  const cert = new (require('node:crypto').X509Certificate)(leaf.certPem);
  const caCert = new (require('node:crypto').X509Certificate)(ca.certPem);
  assert.ok(cert.verify(caCert.publicKey));
  assert.equal(cert.checkHost('dropspace.local'), 'dropspace.local');
  assert.equal(cert.checkHost('evil.example.com'), undefined);
  assert.equal(cert.checkIP('192.168.1.20'), '192.168.1.20');
  assert.equal(cert.checkIP('8.8.8.8'), undefined);
  const days = (new Date(cert.validTo) - new Date(cert.validFrom)) / 864e5;
  assert.ok(days <= 825, 'Apple devices accept it (825 days at most)');
  assert.ok(caCert.ca);
});

test('uploads from Shortcuts are read correctly however they arrive', () => {
  const { MultipartParser } = require('../multipart.js');
  const boundary = 'xYz';
  const payload = Buffer.concat([Buffer.from('abc\r\n--xY'), Buffer.alloc(5000, 7)]); // looks almost like a boundary
  const body = multipartBody(boundary, [{ name: 'file', filename: 'clip.mov', type: 'video/quicktime', data: payload }]);
  for (const size of [1, 2, 13, 4096, body.length]) {
    const parser = new MultipartParser(boundary);
    const got = [];
    let name = null;
    for (let i = 0; i < body.length; i += size) {
      for (const ev of parser.feed(body.subarray(i, i + size))) {
        if (ev.type === 'part') name = ev.filename;
        if (ev.type === 'data') got.push(Buffer.from(ev.data));
      }
    }
    parser.finish();
    assert.equal(name, 'clip.mov');
    assert.deepEqual(Buffer.concat(got), payload, `chunks of ${size}`);
  }
});

test('the Share shortcut is a Shortcuts program pointed at this phone’s address', () => {
  const { shortcutXml } = require('../shortcut.js');
  const xml = shortcutXml({ url: 'http://dropspace.local/api/share?key=abc.def&x=<1>' });
  assert.match(xml, /<string>http:\/\/dropspace\.local\/api\/share\?key=abc\.def&amp;x=&lt;1&gt;<\/string>/);
  assert.match(xml, /is\.workflow\.actions\.downloadurl/);
  assert.match(xml, /<string>ActionExtension<\/string>/, 'shows in the Share sheet');
  assert.match(xml, /<string>Repeat Item<\/string>/);
});

test('a QR pairing token works once', async () => {
  const { json } = await request({ method: 'POST', path: '/api/pair-token' });
  const first = await request({ method: 'POST', path: '/api/pair', body: { token: json.token }, remote: true, auth: false, headers: { Host: `10.0.0.9:${app.port}` } });
  assert.equal(first.status, 200);
  const second = await request({ method: 'POST', path: '/api/pair', body: { token: json.token }, remote: true, auth: false, headers: { Host: `10.0.0.9:${app.port}` } });
  assert.equal(second.status, 401);
});

test('forgetting devices signs everyone else out', async () => {
  const oldPin = app.pin;
  const r = await request({ method: 'POST', path: '/api/forget-devices' });
  assert.equal(r.status, 200);
  assert.notEqual(app.pin, oldPin);
  const who = await request({ path: '/api/whoami', remote: true });
  assert.equal(who.json.paired, false);
});

test('too many wrong codes locks pairing for a while', async () => {
  const wrongPin = app.pin === '999999' ? '888888' : '999999';
  let last;
  for (let i = 0; i < 6; i++) {
    last = await request({ method: 'POST', path: '/api/pair', body: { pin: wrongPin }, remote: true, auth: false });
  }
  assert.equal(last.status, 429);
  const evenRight = await request({ method: 'POST', path: '/api/pair', body: { pin: app.pin }, remote: true, auth: false });
  assert.equal(evenRight.status, 429);
});

test('the board survives a restart', async () => {
  const before = (await waitForEvent('hello', { remote: false })).items.length;
  await app.close();
  assert.ok(!fs.existsSync(path.join(home, 'status.json')), 'status cleared on stop');
  app = await startDropspace({ port: 0, folder, home, log: false, hostName: 'Test Mac' });
  const hello = await waitForEvent('hello', { remote: false });
  assert.equal(hello.items.length, before);
  assert.ok(hello.items.some((i) => i.text === 'hello from the other computer'));
});

test('a version 1 setup keeps saving where it did', async () => {
  const legacyHome = path.join(tmp, 'legacy-home');
  const legacyFolder = path.join(tmp, 'legacy-saves');
  fs.mkdirSync(legacyHome, { recursive: true });
  fs.writeFileSync(path.join(legacyHome, 'config.json'), JSON.stringify({ secret: 'x'.repeat(43), folder: legacyFolder }));
  fs.writeFileSync(path.join(legacyHome, 'history.json'), JSON.stringify({ version: 1, items: [{ id: 'oldnote', type: 'text', text: 'from v1', at: 1 }] }));
  const old = await startDropspace({ port: 0, home: legacyHome, log: false, hostName: 'Legacy' });
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(legacyHome, 'config.json'), 'utf8'));
    assert.equal(cfg.spaces.length, 1);
    assert.equal(cfg.spaces[0].dir, legacyFolder);
    assert.equal(cfg.secret, 'x'.repeat(43), 'paired devices stay paired');
    const res = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: old.port, method: 'POST', path: '/api/upload', headers: { 'X-Dropspace': '1', 'X-Filename': 'a.txt', 'Content-Length': 1 } }, (r) => {
        r.resume();
        r.on('end', () => resolve(r.statusCode));
      });
      req.end('a');
    });
    assert.equal(res, 200);
    assert.ok(fs.existsSync(path.join(legacyFolder, 'a.txt')));
  } finally {
    await old.close();
  }
});
