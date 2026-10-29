'use strict';
/*
 * The secure connection: Dropspace's own little certificate authority.
 *
 * The first time Dropspace runs it makes a certificate authority that exists only on this computer,
 * then uses it to issue the certificate for https://dropspace.local. A Mac or phone that trusts the
 * authority (the installer sets that up on your other Mac) gets an encrypted connection.
 *
 * The authority is limited with name constraints: it can only vouch for local network names
 * (.local, localhost) and private addresses (192.168.x.x and friends). Even if its key were stolen,
 * it could not be used to impersonate a real website.
 *
 * Built only on Node's crypto module: this file writes the certificates' bytes itself.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const net = require('net');

const DAY = 24 * 60 * 60 * 1000;
const CA_DAYS = 3650;
// Apple devices refuse server certificates valid for more than 825 days.
const LEAF_DAYS = 800;
const RENEW_BEFORE_DAYS = 60;
// Names and addresses the authority is allowed to vouch for.
const PERMITTED_DNS = ['local', 'localhost', 'lan', 'home', 'internal', 'home.arpa'];
const PERMITTED_V4 = [
  ['10.0.0.0', '255.0.0.0'],
  ['172.16.0.0', '255.240.0.0'],
  ['192.168.0.0', '255.255.0.0'],
  ['127.0.0.0', '255.0.0.0'],
  ['100.64.0.0', '255.192.0.0'],
  ['169.254.0.0', '255.255.0.0'],
];

/* ------------------------------------------------------------------ DER, the bytes inside a certificate */

function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), len(content.length), content]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const octet = (buf) => tlv(0x04, buf);
const bitString = (buf, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), buf]));
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const explicit = (n, content) => tlv(0xa0 + n, content);

function int(value) {
  let b = Buffer.isBuffer(value) ? value : Buffer.from([value]);
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  b = b.subarray(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const stack = [p & 0x7f];
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128)) stack.unshift(0x80 | (v & 0x7f));
    bytes.push(...stack);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function time(date) {
  const y = date.getUTCFullYear();
  const p = (n) => String(n).padStart(2, '0');
  const rest = `${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return y >= 1950 && y < 2050 ? tlv(0x17, Buffer.from(`${p(y % 100)}${rest}`)) : tlv(0x18, Buffer.from(`${y}${rest}`));
}

const OID = {
  ecdsaSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  subjectKeyId: '2.5.29.14',
  authorityKeyId: '2.5.29.35',
  nameConstraints: '2.5.29.30',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

const name = (cn) => seq(set(seq(oid(OID.organization), utf8('Dropspace'))), set(seq(oid(OID.commonName), utf8(cn))));
const ext = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octet(value));
const ipBytes = (ip) => Buffer.from(ip.split('.').map(Number));

function keyId(publicKey) {
  const { x, y } = publicKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(x, 'base64url'), Buffer.from(y, 'base64url')]);
  return crypto.createHash('sha1').update(point).digest();
}

function toPem(der) {
  const lines = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`;
}
function fromPem(pem) {
  return Buffer.from(String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
}

function buildCert({ subject, issuer, publicKey, signingKey, days, extensions }) {
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  serial[0] |= 0x01;
  const notBefore = new Date(Date.now() - DAY);
  const notAfter = new Date(Date.now() + days * DAY);
  const tbs = seq(
    explicit(0, int(2)),
    int(serial),
    seq(oid(OID.ecdsaSha256)),
    issuer,
    seq(time(notBefore), time(notAfter)),
    subject,
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(...extensions)),
  );
  const signature = crypto.sign('sha256', tbs, signingKey);
  return seq(tbs, seq(oid(OID.ecdsaSha256)), bitString(signature));
}

/** A new certificate authority. Returns PEM strings. */
function createAuthority(label) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const id = keyId(publicKey);
  const subtrees = [
    ...PERMITTED_DNS.map((d) => seq(tlv(0x82, Buffer.from(d, 'ascii')))),
    ...PERMITTED_V4.map(([ip, mask]) => seq(tlv(0x87, Buffer.concat([ipBytes(ip), ipBytes(mask)])))),
  ];
  const cn = `Dropspace Local CA${label ? ` (${label})` : ''}`.slice(0, 64);
  const der = buildCert({
    subject: name(cn),
    issuer: name(cn),
    publicKey,
    signingKey: privateKey,
    days: CA_DAYS,
    extensions: [
      ext(OID.basicConstraints, true, seq(bool(true), int(0))),
      ext(OID.keyUsage, true, bitString(Buffer.from([0x86]), 1)), // digitalSignature, keyCertSign, cRLSign
      ext(OID.subjectKeyId, false, octet(id)),
      ext(OID.nameConstraints, true, seq(tlv(0xa0, Buffer.concat(subtrees)))),
    ],
  });
  return { certPem: toPem(der), keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

/** Only names and addresses the authority may vouch for go into the server certificate. */
function permittedDns(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+$/.test(h) || h.length > 253) return false;
  return PERMITTED_DNS.some((d) => h === d || h.endsWith(`.${d}`));
}
function permittedIp(ip) {
  if (net.isIP(ip) !== 4) return false;
  const v = ipBytes(ip);
  return PERMITTED_V4.some(([base, mask]) => {
    const b = ipBytes(base);
    const m = ipBytes(mask);
    return v.every((byte, i) => (byte & m[i]) === b[i]);
  });
}

/** The server certificate for dropspace.local, this computer's names and its current addresses. */
function issueServerCert(ca, { dnsNames = [], ips = [] }) {
  const caKey = crypto.createPrivateKey(ca.keyPem);
  const caCert = new crypto.X509Certificate(ca.certPem);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const dns = [...new Set(dnsNames.map((d) => String(d).toLowerCase()))].filter(permittedDns);
  const addrs = [...new Set(ips)].filter(permittedIp);
  if (!dns.length) throw new Error('No local name to put in the certificate');
  const san = seq(...dns.map((d) => tlv(0x82, Buffer.from(d, 'ascii'))), ...addrs.map((ip) => tlv(0x87, ipBytes(ip))));
  const der = buildCert({
    subject: name(dns[0]),
    issuer: issuerOf(caCert),
    publicKey,
    signingKey: caKey,
    days: LEAF_DAYS,
    extensions: [
      ext(OID.basicConstraints, true, seq()),
      ext(OID.keyUsage, true, bitString(Buffer.from([0x80]), 7)), // digitalSignature
      ext(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
      ext(OID.subjectAltName, false, san),
      ext(OID.subjectKeyId, false, octet(keyId(publicKey))),
      ext(OID.authorityKeyId, false, seq(tlv(0x80, keyId(caCert.publicKey)))),
    ],
  });
  return { certPem: toPem(der), keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), dns, ips: addrs };
}

/** The authority's own subject, byte for byte, so the server certificate's issuer matches exactly. */
function issuerOf(caCert) {
  const der = caCert.raw;
  // Certificate ::= SEQUENCE { tbsCertificate SEQUENCE { [0] version, serial, sigAlg, issuer, validity, subject, ... } }
  let pos = 0;
  const read = () => {
    const tag = der[pos];
    let length = der[pos + 1];
    let head = 2;
    if (length & 0x80) {
      const n = length & 0x7f;
      length = 0;
      for (let i = 0; i < n; i++) length = length * 256 + der[pos + 2 + i];
      head = 2 + n;
    }
    const start = pos;
    return { tag, start, head, length, end: start + head + length };
  };
  const enter = () => {
    const el = read();
    pos = el.start + el.head;
    return el;
  };
  const skip = () => {
    const el = read();
    pos = el.end;
    return el;
  };
  enter(); // Certificate
  enter(); // TBSCertificate
  skip(); // version
  skip(); // serial
  skip(); // signature algorithm
  skip(); // issuer
  skip(); // validity
  const subject = skip();
  return der.subarray(subject.start, subject.end);
}

const sha256Fingerprint = (pem) => crypto.createHash('sha256').update(fromPem(pem)).digest('hex').toUpperCase().match(/.{2}/g).join(':');

/**
 * Load the authority and server certificate from `dir`, creating or renewing them as needed.
 * Returns { caPem, keyPem, certPem, changed }.
 */
async function ensureCertificates(dir, { label, dnsNames, ips }) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = (n) => path.join(dir, n);
  const read = async (n) => {
    try {
      return await fsp.readFile(file(n), 'utf8');
    } catch {
      return null;
    }
  };
  let caPem = await read('ca.pem');
  let caKeyPem = await read('ca-key.pem');
  let caOk = false;
  if (caPem && caKeyPem) {
    try {
      const c = new crypto.X509Certificate(caPem);
      const k = crypto.createPrivateKey(caKeyPem);
      caOk = c.ca && c.checkPrivateKey(k) && new Date(c.validTo).getTime() - Date.now() > 30 * DAY;
    } catch {
      caOk = false;
    }
  }
  let changed = false;
  if (!caOk) {
    const ca = createAuthority(label);
    caPem = ca.certPem;
    caKeyPem = ca.keyPem;
    await fsp.writeFile(file('ca-key.pem'), caKeyPem, { mode: 0o600 });
    await fsp.writeFile(file('ca.pem'), caPem, { mode: 0o644 });
    changed = true;
  }

  const wantDns = [...new Set(dnsNames.map((d) => String(d).toLowerCase()))].filter(permittedDns);
  const wantIps = [...new Set(ips)].filter(permittedIp);
  let certPem = await read('cert.pem');
  let keyPem = await read('key.pem');
  let leafOk = false;
  if (!changed && certPem && keyPem) {
    try {
      const c = new crypto.X509Certificate(certPem);
      const ca = new crypto.X509Certificate(caPem);
      const covered = wantDns.every((d) => c.checkHost(d, { wildcards: false, subject: 'never' }) === d)
        && wantIps.every((ip) => c.checkIP(ip) === ip);
      leafOk = c.checkIssued(ca) && c.verify(ca.publicKey) && c.checkPrivateKey(crypto.createPrivateKey(keyPem))
        && new Date(c.validTo).getTime() - Date.now() > RENEW_BEFORE_DAYS * DAY && covered;
    } catch {
      leafOk = false;
    }
  }
  if (!leafOk) {
    const leaf = issueServerCert({ certPem: caPem, keyPem: caKeyPem }, { dnsNames: wantDns, ips: wantIps });
    certPem = leaf.certPem;
    keyPem = leaf.keyPem;
    await fsp.writeFile(file('key.pem'), keyPem, { mode: 0o600 });
    await fsp.writeFile(file('cert.pem'), certPem, { mode: 0o644 });
    changed = true;
  }
  return { caPem, certPem, keyPem, changed, fingerprint: sha256Fingerprint(caPem) };
}

/** An iPhone/iPad configuration profile that installs the authority. */
function mobileConfig(caPem, hostLabel) {
  const der = fromPem(caPem);
  const digest = crypto.createHash('sha256').update(der).digest('hex');
  const uuid = (salt) => {
    const h = crypto.createHash('sha256').update(salt + digest).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
  };
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const label = esc(hostLabel || 'your Mac');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>Dropspace.cer</string>
      <key>PayloadContent</key>
      <data>${der.toString('base64')}</data>
      <key>PayloadDescription</key>
      <string>Lets this device connect securely to Dropspace on ${label}.</string>
      <key>PayloadDisplayName</key>
      <string>Dropspace Local CA</string>
      <key>PayloadIdentifier</key>
      <string>com.dropspace.ca.${digest.slice(0, 16)}</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${uuid('cert')}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>Lets this device connect securely to Dropspace on ${label}. It only works for local network names, not websites.</string>
  <key>PayloadDisplayName</key>
  <string>Dropspace Secure Connection</string>
  <key>PayloadIdentifier</key>
  <string>com.dropspace.profile.${digest.slice(0, 16)}</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${uuid('profile')}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
}

module.exports = { ensureCertificates, createAuthority, issueServerCert, mobileConfig, permittedDns, permittedIp, sha256Fingerprint, fromPem };
