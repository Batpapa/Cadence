// Packs the built web app for the Android app's over-the-air updates.
//
// The app ships its own copy of dist/ inside the APK, so a push to GitHub
// Pages updates the PWA only. This turns the same build into a zip the app can
// download and switch to (src/native/otaUpdate.ts, @capgo/capacitor-updater in
// self-hosted mode), and records it in version.json — the file the app
// already polls — so one deploy updates both.
//
// Run by the Pages workflow AFTER `npm run build`, never by the build itself:
// `cap sync` copies dist/ into the APK, and an APK carrying a zip of its own
// web app would be several megabytes of nothing.
//
// Usage: node scripts/ota-bundle.js   (expects dist/ and dist/version.json)

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

/** The oldest APK (its versionCode, android/app/build.gradle) whose native
 *  side this web bundle can run on. Raise it — to the versionCode of the APK
 *  that brings it — the day the web code starts calling a native plugin or
 *  method an older APK does not have. An older APK then simply ignores the
 *  update instead of loading code that would call into nothing. */
const MIN_NATIVE_BUILD = 1;

const DIST = path.join(__dirname, '..', 'dist');
const OUT_DIR = 'native';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function listFiles(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    // The bundle never contains bundles.
    if (rel === OUT_DIR) continue;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

/** A plain zip: deflated entries, UTF-8 names, no zip64 (a few megabytes). */
function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const rel of files) {
    const data = fs.readFileSync(path.join(DIST, rel));
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const name = Buffer.from(rel, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // UTF-8 names
    local.writeUInt16LE(8, 8);            // deflate
    local.writeUInt32LE(0, 10);           // mod time/date: irrelevant here
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + deflated.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}

const versionPath = path.join(DIST, 'version.json');
const version = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
if (version.native) throw new Error('version.json already carries a native bundle — run once per build');

const zip = buildZip(listFiles(DIST));
const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
// Named after the build: a deploy never overwrites a bundle an app may be
// halfway through downloading.
const bundle = `${OUT_DIR}/bundle-${version.build}.zip`;
fs.mkdirSync(path.join(DIST, OUT_DIR), { recursive: true });
fs.writeFileSync(path.join(DIST, bundle), zip);

version.native = { bundle, sha256, minNativeBuild: MIN_NATIVE_BUILD };
fs.writeFileSync(versionPath, JSON.stringify(version));
console.log(`OTA bundle: ${bundle} (${(zip.length / 1048576).toFixed(1)} MB, sha256 ${sha256.slice(0, 12)}…)`);
