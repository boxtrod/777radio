require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { parseFile } = require('music-metadata');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'playlist.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// Make sure the folders/files this app depends on actually exist.
// Don't assume they were committed to git or pre-created by the host —
// create them on boot if missing.
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, '[]');
}
if (!fs.existsSync(SETTINGS_FILE)) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ shuffle: false, shuffledOrder: [] }));
}

// --- Admin auth ---
// Username/password come from environment variables so the password is
// never committed to code. Set ADMIN_USER / ADMIN_PASSWORD wherever you
// host this (locally via .env, or your host's dashboard/secrets).
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD) {
  console.warn(
    '\n⚠️  WARNING: ADMIN_PASSWORD is not set. Admin routes are UNPROTECTED.\n' +
    '   Set ADMIN_PASSWORD (and optionally ADMIN_USER) before deploying.\n'
  );
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return require('crypto').timingSafeEqual(bufA, bufB);
}

function requireAdminAuth(req, res, next) {
  // If no password is configured, don't lock the operator out of their own
  // prototype — but this should never happen in a real deployment.
  if (!ADMIN_PASSWORD) return next();

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');

  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sepIndex = decoded.indexOf(':');
    const user = decoded.slice(0, sepIndex);
    const pass = decoded.slice(sepIndex + 1);

    if (timingSafeEqual(user, ADMIN_USER) && timingSafeEqual(pass, ADMIN_PASSWORD)) {
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="Station Admin"');
  res.status(401).send('Authentication required.');
}

// --- Playlist persistence ---
function loadPlaylist() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function savePlaylist(playlist) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(playlist, null, 2));
}

let playlist = loadPlaylist();

// --- Shuffle settings persistence ---
// shuffledOrder holds track IDs in the order they'll actually broadcast
// while shuffle is on. It's stored separately from `playlist` (the
// admin's manually-arranged base order) so turning shuffle off always
// cleanly restores the manual order, and reordering the base list doesn't
// get clobbered by whatever shuffle happened to be doing.
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return { shuffle: false, shuffledOrder: [] };
  }
}

function saveSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ shuffle: shuffleEnabled, shuffledOrder }, null, 2));
}

const settings = loadSettings();
let shuffleEnabled = !!settings.shuffle;
let shuffledOrder = Array.isArray(settings.shuffledOrder) ? settings.shuffledOrder : [];

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// The order tracks actually broadcast in right now: the manual playlist
// order when shuffle is off, or the current shuffled sequence when it's on.
function getPlayOrder() {
  if (!shuffleEnabled) return playlist;

  const byId = Object.fromEntries(playlist.map(t => [t.id, t]));
  const ordered = shuffledOrder.map(id => byId[id]).filter(Boolean);
  // Any tracks not yet represented in shuffledOrder (e.g. freshly uploaded
  // before the insert logic ran) get appended so nothing silently drops
  // out of rotation.
  const missingIds = playlist.map(t => t.id).filter(id => !shuffledOrder.includes(id));
  return [...ordered, ...missingIds.map(id => byId[id])];
}

// The moment the "radio station" started broadcasting.
// All playback position math is relative to this fixed anchor,
// so every listener computes the same "current" position.
const STATION_START = Date.now();

function getTotalDuration() {
  return getPlayOrder().reduce((sum, t) => sum + t.duration, 0);
}

// Given elapsed ms since station start, figure out which track is
// "on air" right now and how far into it we are.
function getNowPlaying() {
  const order = getPlayOrder();
  if (order.length === 0) return null;

  const totalDuration = getTotalDuration();
  if (totalDuration <= 0) return null;

  const elapsedSec = ((Date.now() - STATION_START) / 1000) % totalDuration;

  let acc = 0;
  for (let i = 0; i < order.length; i++) {
    const track = order[i];
    if (elapsedSec < acc + track.duration) {
      return {
        track,
        index: i,
        order,
        positionInTrack: elapsedSec - acc,
        serverTime: Date.now(),
      };
    }
    acc += track.duration;
  }
  // Fallback (floating point edge case) — first track, position 0
  return { track: order[0], index: 0, order, positionInTrack: 0, serverTime: Date.now() };
}

// --- Multer upload config ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Unsupported file type: ' + ext));
  },
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB per file
});

app.use(express.json());

// Admin page requires auth. The listener page, now-playing, and streaming
// stay public — only serve admin.html through the guarded route below,
// so don't let express.static hand it out unprotected.
app.get('/admin.html', requireAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', redirect: false }));

// --- API: current playlist (metadata only) ---
app.get('/api/playlist', (req, res) => {
  res.json(playlist.map(({ id, title, artist, filename, duration, uploadedAt }) => ({
    id, title, artist, filename, duration, uploadedAt,
  })));
});

// --- API: what's playing right now ---
app.get('/api/now-playing', (req, res) => {
  const now = getNowPlaying();
  if (!now) return res.json({ status: 'empty' });

  res.json({
    status: 'on-air',
    id: now.track.id,
    title: now.track.title,
    artist: now.track.artist,
    filename: now.track.filename,
    duration: now.track.duration,
    positionInTrack: now.positionInTrack,
    serverTime: now.serverTime,
    uploadedAt: now.track.uploadedAt,
    upNext: now.order[(now.index + 1) % now.order.length]
      ? {
          title: now.order[(now.index + 1) % now.order.length].title,
          artist: now.order[(now.index + 1) % now.order.length].artist,
        }
      : null,
  });
});

// --- Stream audio with range support (needed for seeking) ---
app.get('/stream/:filename', (req, res) => {
  const filePath = path.join(UPLOADS_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.aac': 'audio/aac',
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    const stream = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
    });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// --- Upload endpoint ---
app.post('/api/upload', requireAdminAuth, upload.array('audioFiles', 20), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  const added = [];
  for (const file of req.files) {
    let duration = 0;
    let title = path.basename(file.originalname, path.extname(file.originalname));
    let artist = 'Unknown';

    try {
      const metadata = await parseFile(file.path);
      duration = metadata.format.duration || 0;
      if (metadata.common.title) title = metadata.common.title;
      if (metadata.common.artist) artist = metadata.common.artist;
    } catch (err) {
      console.error('Metadata parse failed for', file.originalname, err.message);
    }

    if (duration <= 0) {
      // Can't broadcast a track we can't time. Skip it, but keep the file
      // in case you want to inspect it — just don't add it to rotation.
      console.warn('Skipping (no duration):', file.originalname);
      continue;
    }

    const track = {
      id: path.parse(file.filename).name,
      filename: file.filename,
      originalName: file.originalname,
      title,
      artist,
      duration,
      uploadedAt: new Date().toISOString(),
    };
    playlist.push(track);
    added.push(track);

    if (shuffleEnabled) {
      // Insert the new track into the current shuffled sequence at a random
      // spot, rather than reshuffling everything (which would jarringly
      // reorder tracks already queued up mid-broadcast).
      const insertAt = Math.floor(Math.random() * (shuffledOrder.length + 1));
      shuffledOrder.splice(insertAt, 0, track.id);
    }
  }

  savePlaylist(playlist);
  if (shuffleEnabled) saveSettings();
  res.json({ added });
});

// --- Delete a track ---
app.delete('/api/track/:id', requireAdminAuth, (req, res) => {
  const idx = playlist.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const [removed] = playlist.splice(idx, 1);
  savePlaylist(playlist);

  const orderIdx = shuffledOrder.indexOf(removed.id);
  if (orderIdx !== -1) {
    shuffledOrder.splice(orderIdx, 1);
    saveSettings();
  }

  const filePath = path.join(UPLOADS_DIR, removed.filename);
  fs.unlink(filePath, () => {});

  res.json({ removed });
});

// --- Reorder playlist (the manual/base order, used whenever shuffle is off) ---
app.post('/api/reorder', requireAdminAuth, (req, res) => {
  const { order } = req.body; // array of track ids in desired order
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of ids' });

  const byId = Object.fromEntries(playlist.map(t => [t.id, t]));
  const reordered = order.map(id => byId[id]).filter(Boolean);
  // Append any tracks not included in `order` (safety net)
  const missing = playlist.filter(t => !order.includes(t.id));
  playlist = [...reordered, ...missing];

  savePlaylist(playlist);
  res.json({ playlist });
});

// --- Shuffle state ---
app.get('/api/shuffle', (req, res) => {
  res.json({ enabled: shuffleEnabled });
});

app.post('/api/shuffle', requireAdminAuth, (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });

  shuffleEnabled = enabled;
  if (shuffleEnabled) {
    // Fresh shuffle every time it's turned on, so re-enabling gives a
    // genuinely new order rather than picking up wherever it left off.
    shuffledOrder = shuffleArray(playlist.map(t => t.id));
  }
  saveSettings();
  res.json({ enabled: shuffleEnabled });
});

app.listen(PORT, () => {
  console.log(`Radio station running at http://localhost:${PORT}`);
  console.log(`Admin panel at http://localhost:${PORT}/admin.html`);
});
