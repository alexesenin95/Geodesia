'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
try { require('dotenv').config(); } catch (e) { /* dotenv optional */ }

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const CONTENT_FILE = path.join(DATA_DIR, 'content.json');
const SEED_FILE = path.join(__dirname, 'seed.json');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
// Either a bcrypt hash (ADMIN_PASSWORD_HASH) or a plain password (ADMIN_PASSWORD).
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH
  || bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'vyaz', 10);

for (const dir of [DATA_DIR, UPLOADS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---- Content store (atomic JSON file) -------------------------------------
function loadContent() {
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  let data;
  try {
    data = JSON.parse(fs.readFileSync(CONTENT_FILE, 'utf8'));
  } catch (e) {
    saveContent(seed);
    return seed;
  }
  // Backfill any settings keys added after this store was first created.
  data.settings = Object.assign({}, seed.settings, data.settings || {});
  if (runMigrations(data, seed)) saveContent(data);
  return data;
}

// One-time data migrations, guarded by flags so they never undo later edits.
function runMigrations(data, seed) {
  data._migrations = data._migrations || {};
  let changed = false;
  // Seed initial project photos into projects that still have none.
  if (!data._migrations.seedProjectPhotos1) {
    const byId = {};
    (seed.projects || []).forEach(p => { byId[p.id] = p; });
    (data.projects || []).forEach(p => {
      const sp = byId[p.id];
      if (sp && Array.isArray(sp.images) && sp.images.length && (!Array.isArray(p.images) || !p.images.length)) {
        p.images = sp.images.slice();
      }
    });
    data._migrations.seedProjectPhotos1 = true;
    changed = true;
  }
  // Append projects added after the store was created (by id), if missing.
  if (!data._migrations.addProjects2) {
    const have = new Set((data.projects || []).map(p => p.id));
    ['metallurgov', 'simbirtseva'].forEach(id => {
      const sp = (seed.projects || []).find(p => p.id === id);
      if (sp && !have.has(id)) {
        data.projects = data.projects || [];
        data.projects.push(JSON.parse(JSON.stringify(sp)));
      }
    });
    data._migrations.addProjects2 = true;
    changed = true;
  }
  // Correct the organisation name set by earlier versions.
  if (!data._migrations.orgNames1) {
    const s = data.settings || (data.settings = {});
    if (s.aboutTitle && /стратегическог/i.test(s.aboutTitle)) {
      s.aboutTitle = 'Центр компетенций по вопросам городской среды Волгограда';
    }
    data._migrations.orgNames1 = true;
    changed = true;
  }
  return changed;
}
function saveContent(data) {
  const tmp = CONTENT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, CONTENT_FILE);
}
// Ensure the store exists on boot.
loadContent();

// ---- Auth ------------------------------------------------------------------
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'invalid token' });
  }
}

// ---- Uploads ---------------------------------------------------------------
const ALLOWED = new Set([
  // images
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml', 'image/avif',
  // documents (project materials)
  'application/pdf', 'application/zip', 'application/x-zip-compressed',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain'
]);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase().slice(0, 10);
    cb(null, Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED.has(file.mimetype))
});

// ---- App -------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '4mb' }));

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && bcrypt.compareSync(String(password || ''), ADMIN_PASSWORD_HASH)) {
    const token = jwt.sign({ u: username }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Неверный логин или пароль' });
});

app.get('/api/content', (req, res) => {
  res.json(loadContent());
});

app.put('/api/content', auth, (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'bad payload' });
  saveContent(data);
  res.json({ ok: true });
});

app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не принят (формат или размер)' });
  res.json({ url: '/uploads/' + req.file.filename, name: req.file.originalname });
});

// Static files
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '7d' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// SPA fallback to index.html for any non-API route
app.get(/^(?!\/(api|uploads)\/).*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`ВЯЗ site running on http://localhost:${PORT}`);
  console.log(`Admin user: ${ADMIN_USER}`);
});
