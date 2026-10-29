'use strict';
/*
 * Reads multipart/form-data uploads (what the iPhone's Shortcuts app sends) as a stream, so a
 * 4 GB video goes straight to disk instead of into memory.
 *
 *   const parser = new MultipartParser(boundary);
 *   for await (const chunk of req) for (const ev of parser.feed(chunk)) ...
 *   parser.finish();
 *
 * Events: { type: 'part', headers, name, filename, contentType }, { type: 'data', data }, { type: 'end' }.
 */

const MAX_HEADER_BYTES = 16 * 1024;

function badUpload(message) {
  const err = new Error(message);
  err.status = 400;
  err.expose = true;
  return err;
}

function parseDisposition(value) {
  const out = { name: '', filename: null };
  const param = (key) => {
    const quoted = new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'i').exec(value);
    if (quoted) return quoted[1].replace(/\\(.)/g, '$1');
    const bare = new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*([^;\\s]+)`, 'i').exec(value);
    return bare ? bare[1] : null;
  };
  out.name = param('name') || '';
  const star = /(?:^|;)\s*filename\*\s*=\s*([^']*)'[^']*'([^;\s]+)/i.exec(value);
  if (star) {
    try {
      out.filename = decodeURIComponent(star[2]);
    } catch {
      out.filename = star[2];
    }
  } else {
    out.filename = param('filename');
  }
  return out;
}

class MultipartParser {
  constructor(boundary) {
    if (!boundary || boundary.length > 200) throw badUpload('Bad upload boundary');
    this.delim = Buffer.from(`\r\n--${boundary}`);
    // Pretend the body starts with a line break, so the first boundary looks like all the others.
    this.buf = Buffer.from('\r\n');
    this.state = 'preamble';
  }

  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (this.state === 'preamble') {
        const i = this.buf.indexOf(this.delim);
        if (i < 0) {
          this.buf = this.buf.subarray(Math.max(0, this.buf.length - this.delim.length + 1));
          break;
        }
        this.buf = this.buf.subarray(i + this.delim.length);
        this.state = 'boundary';
      } else if (this.state === 'boundary') {
        if (this.buf.length < 2) break;
        if (this.buf[0] === 0x2d && this.buf[1] === 0x2d) {
          this.state = 'done';
          this.buf = Buffer.alloc(0);
          break;
        }
        const eol = this.buf.indexOf('\r\n');
        if (eol < 0) {
          if (this.buf.length > 1024) throw badUpload('Bad upload');
          break;
        }
        this.buf = this.buf.subarray(eol + 2);
        this.state = 'headers';
      } else if (this.state === 'headers') {
        let headerText;
        if (this.buf.length >= 2 && this.buf[0] === 0x0d && this.buf[1] === 0x0a) {
          headerText = '';
          this.buf = this.buf.subarray(2);
        } else {
          const end = this.buf.indexOf('\r\n\r\n');
          if (end < 0) {
            if (this.buf.length > MAX_HEADER_BYTES) throw badUpload('Upload headers are too long');
            break;
          }
          headerText = this.buf.subarray(0, end).toString('utf8');
          this.buf = this.buf.subarray(end + 4);
        }
        const headers = {};
        for (const line of headerText.split('\r\n')) {
          const i = line.indexOf(':');
          if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }
        const disp = parseDisposition(headers['content-disposition'] || '');
        out.push({ type: 'part', headers, name: disp.name, filename: disp.filename, contentType: (headers['content-type'] || '').toLowerCase() });
        this.state = 'body';
      } else if (this.state === 'body') {
        const i = this.buf.indexOf(this.delim);
        if (i >= 0) {
          if (i > 0) out.push({ type: 'data', data: this.buf.subarray(0, i) });
          out.push({ type: 'end' });
          this.buf = this.buf.subarray(i + this.delim.length);
          this.state = 'boundary';
          continue;
        }
        // Hold back just enough bytes to catch a boundary split across two chunks.
        const keep = this.delim.length - 1;
        if (this.buf.length > keep) {
          out.push({ type: 'data', data: this.buf.subarray(0, this.buf.length - keep) });
          this.buf = this.buf.subarray(this.buf.length - keep);
        }
        break;
      } else {
        this.buf = Buffer.alloc(0); // anything after the last boundary is ignored
        break;
      }
    }
    return out;
  }

  finish() {
    if (this.state !== 'done') throw badUpload('The upload was cut off. Try again.');
  }
}

/** The boundary from a Content-Type header, or null if it isn't multipart/form-data. */
function boundaryOf(contentType) {
  const m = /^multipart\/form-data\s*;.*?\bboundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ''));
  return m ? m[1] || m[2] : null;
}

module.exports = { MultipartParser, boundaryOf, parseDisposition };
