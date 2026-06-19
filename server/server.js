// Бэкенд сайта МБУ «ВЯЗ».
// Отдаёт статический сайт и папку uploads/, принимает загрузки фото и PDF,
// автоматически оптимизирует изображения в WebP, рендерит страницы PDF в
// картинки и хранит общий контент сайта (content.json) + карту слотов
// изображений (.image-slots.state.json) на диске, чтобы загруженное видели
// все посетители.
//
// Запуск:
//   cd server && npm install && npm start
// Переменные окружения (необязательно):
//   PORT                 — порт (по умолчанию 8000)
//   VYAZ_ADMIN_PASSWORD  — пароль для загрузок/сохранения (по умолчанию "vyaz-admin")

import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import * as mupdf from 'mupdf';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');           // корень репозитория = статический сайт
const DATA_DIR = path.join(__dirname, 'data');
const CONTENT_FILE = path.join(DATA_DIR, 'content.json');
const STATE_FILE = path.join(ROOT, '.image-slots.state.json');
const UP_IMG = path.join(ROOT, 'uploads', 'img');
const UP_DOC = path.join(ROOT, 'uploads', 'docs');

const PORT = process.env.PORT || 8000;
const PASSWORD = process.env.VYAZ_ADMIN_PASSWORD || 'vyaz';

// Размеры/качество оптимизации
const GALLERY_W = 1600;   // ширина картинок галереи/страниц PDF
const PDF_SCALE = 2;      // масштаб рендера страниц PDF (резкость)
const WEBP_Q = 80;

for (const d of [DATA_DIR, UP_IMG, UP_DOC]) fs.mkdirSync(d, { recursive: true });

const app = express();
app.use(express.json({ limit: '4mb' }));

// ── Вспомогательное ────────────────────────────────────────────────────────
const rid = () => crypto.randomBytes(5).toString('hex');
const slug = (s) => String(s || 'item')
  .toLowerCase()
  .replace(/[^a-z0-9а-яё]+/gi, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 40) || 'item';

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf-8')); }
  catch { return fallback; }
}

// Сериализуем запись state.json, чтобы параллельные загрузки не затёрли друг друга.
let stateChain = Promise.resolve();
function updateState(mutator) {
  stateChain = stateChain.then(async () => {
    const state = await readJson(STATE_FILE, {});
    await mutator(state);
    await fsp.writeFile(STATE_FILE, JSON.stringify(state));
  }).catch((e) => console.error('state write error:', e));
  return stateChain;
}

// Простая защита записи: заголовок Authorization: Bearer <пароль>
function auth(req, res, next) {
  const h = req.get('authorization') || '';
  const token = h.replace(/^Bearer\s+/i, '');
  if (token === PASSWORD) return next();
  res.status(401).json({ error: 'Не авторизовано' });
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

async function toWebp(buffer, width) {
  return sharp(buffer).rotate()
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: WEBP_Q })
    .toBuffer();
}

// ── API ──────────────────────────────────────────────────────────────────
// Проверка пароля
app.post('/api/login', (req, res) => {
  if ((req.body && req.body.password) === PASSWORD) return res.json({ ok: true, token: PASSWORD });
  res.status(401).json({ error: 'Неверный пароль' });
});

// Общий контент сайта (работы, новости, документы, услуги и т.д.)
app.get('/api/data', async (req, res) => {
  const data = await readJson(CONTENT_FILE, null);
  if (!data) return res.status(204).end();
  res.json(data);
});
app.put('/api/data', auth, async (req, res) => {
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Нужен JSON' });
  await fsp.writeFile(CONTENT_FILE, JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

// Пакетная загрузка фото: поле "files" (несколько), query: prefix (id проекта)
app.post('/api/images', auth, upload.array('files', 40), async (req, res) => {
  try {
    const prefix = slug(req.query.prefix);
    const out = [];
    for (const f of req.files || []) {
      const webp = await toWebp(f.buffer, GALLERY_W);
      const slot = `${prefix}-${rid()}`;
      const name = `${slot}.webp`;
      await fsp.writeFile(path.join(UP_IMG, name), webp);
      const url = `uploads/img/${name}`;
      out.push({ slot, url });
    }
    await updateState((state) => { for (const o of out) state[o.slot] = { u: o.url, s: 1, x: 0, y: 0 }; });
    res.json({ ok: true, images: out });
  } catch (e) {
    console.error('images error:', e);
    res.status(500).json({ error: 'Не удалось обработать изображения' });
  }
});

// Загрузка PDF: поле "file", query: name (название документа), prefix (id для слотов)
// Возвращает ссылку на документ для скачивания + слоты-картинки страниц.
app.post('/api/pdf', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Нет файла' });
    const title = (req.query.name || req.file.originalname || 'Документ').replace(/\.pdf$/i, '');
    const prefix = slug(req.query.prefix || title);
    const base = `${prefix}-${rid()}`;

    // 1) Сохраняем сам PDF для скачивания
    const pdfName = `${base}.pdf`;
    await fsp.writeFile(path.join(UP_DOC, pdfName), req.file.buffer);
    const docUrl = `uploads/docs/${pdfName}`;

    // 2) Рендерим страницы в WebP (mupdf — WASM, без нативной сборки)
    const pages = [];
    const doc = mupdf.Document.openDocument(req.file.buffer, 'application/pdf');
    const count = doc.countPages();
    const matrix = mupdf.Matrix.scale(PDF_SCALE, PDF_SCALE);
    for (let i = 1; i <= count; i++) {
      const pix = doc.loadPage(i - 1).toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
      const png = pix.asPNG();
      const webp = await toWebp(Buffer.from(png), GALLERY_W);
      const slot = `${base}-p${i}`;
      const name = `${slot}.webp`;
      await fsp.writeFile(path.join(UP_IMG, name), webp);
      pages.push({ slot, url: `uploads/img/${name}` });
    }
    const i = count;
    await updateState((state) => { for (const p of pages) state[p.slot] = { u: p.url, s: 1, x: 0, y: 0 }; });

    res.json({ ok: true, doc: { title, url: docUrl }, pages, pageCount: i });
  } catch (e) {
    console.error('pdf error:', e);
    res.status(500).json({ error: 'Не удалось обработать PDF' });
  }
});

// ── Статика сайта ──────────────────────────────────────────────────────────
// Папка загрузок и сам сайт (index.html, support.js, image-slot.js, assets, state.json)
app.use(express.static(ROOT, { extensions: ['html'] }));

app.listen(PORT, () => {
  console.log(`МБУ «ВЯЗ» — сервер запущен:  http://localhost:${PORT}`);
  console.log(`Загрузки — в админке сайта:  Панель управления (вход admin / ${PASSWORD})`);
});
