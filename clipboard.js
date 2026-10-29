'use strict';
/*
 * Reads what's on a Mac's clipboard, using tools built into macOS:
 * files copied in Finder, a copied image, or copied text (checked in that order,
 * because copying files in Finder also puts their names and icons on the clipboard).
 */
const { execFile } = require('child_process');
const { fileURLToPath } = require('url');
const fs = require('fs');
const os = require('os');
const path = require('path');

function defaultRun(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 20000, ...opts }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

// Every file URL on the clipboard (Finder puts one per copied file).
const FILE_URLS_JXA = `ObjC.import('AppKit');
const items = $.NSPasteboard.generalPasteboard.pasteboardItems;
const out = [];
for (let i = 0; i < items.count; i++) {
  const u = ObjC.unwrap(items.objectAtIndex(i).stringForType('public.file-url'));
  if (u) out.push(u);
}
JSON.stringify(out);`;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

/**
 * Resolves with one of:
 *   { kind: 'files', paths: [...] }
 *   { kind: 'image', path, name }   (a temporary PNG; delete it when done)
 *   { kind: 'text', text }
 *   { kind: 'empty' }
 */
async function readMacClipboard({ run = defaultRun, tmpdir = os.tmpdir() } = {}) {
  const info = await run('/usr/bin/osascript', ['-e', 'clipboard info']).catch(() => '');

  if (/furl/.test(info)) {
    let urls = [];
    try {
      urls = JSON.parse((await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', FILE_URLS_JXA])).trim() || '[]');
    } catch {
      // Fall back to AppleScript, which can read the first copied file.
      const one = await run('/usr/bin/osascript', ['-e', 'POSIX path of (the clipboard as «class furl»)']).catch(() => '');
      if (one.trim()) urls = [`file://${encodeURI(one.trim())}`];
    }
    const paths = urls
      .map((u) => {
        try {
          return fileURLToPath(u);
        } catch {
          return null;
        }
      })
      .filter((p) => p && fs.existsSync(p))
      .map((p) => p.replace(/\/+$/, '') || p);
    if (paths.length) return { kind: 'files', paths };
  }

  const png = /PNGf/.test(info);
  if (png || /TIFF/.test(info)) {
    const base = path.join(tmpdir, `dropspace-clipboard-${process.pid}-${Date.now()}`);
    const raw = `${base}.${png ? 'png' : 'tiff'}`;
    const script = [
      `set img to the clipboard as «class ${png ? 'PNGf' : 'TIFF'}»`,
      `set f to open for access (POSIX file "${raw}") with write permission`,
      'set eof f to 0',
      'write img to f',
      'close access f',
    ];
    try {
      await run('/usr/bin/osascript', script.flatMap((line) => ['-e', line]));
      let out = raw;
      if (!png) {
        // Many apps copy images as TIFF, which most browsers can't show. Convert with the Mac's sips tool.
        out = `${base}.png`;
        await run('/usr/bin/sips', ['-s', 'format', 'png', raw, '--out', out]);
        fs.rmSync(raw, { force: true });
      }
      if (fs.existsSync(out) && fs.statSync(out).size > 0) return { kind: 'image', path: out, name: `Clipboard image ${stamp()}.png` };
    } catch {
      fs.rmSync(raw, { force: true });
    }
  }

  // pbpaste needs a UTF-8 locale, or accented letters and emoji come out garbled.
  const text = await run('/usr/bin/pbpaste', [], { env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } }).catch(() => '');
  if (text.trim()) return { kind: 'text', text };
  return { kind: 'empty' };
}

module.exports = { readMacClipboard, stamp };
