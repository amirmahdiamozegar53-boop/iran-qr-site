const express = require('express');
const session = require('express-session');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const QRCode = require('qrcode');
const mongoose = require('mongoose');
const MongoStore = require('connect-mongo');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'IRAN1405@';
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI || !process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET || !BASE_URL || !process.env.SESSION_SECRET) {
  console.error('Missing required environment variables. See README-FA.md');
  process.exit(1);
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

mongoose.connect(MONGODB_URI).then(() => console.log('MongoDB connected')).catch(err => {
  console.error('MongoDB connection failed:', err.message);
  process.exit(1);
});

const imageSchema = new mongoose.Schema({
  serial: { type: String, required: true, unique: true, trim: true },
  publicId: { type: String, required: true },
  imageUrl: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true }
});
const ImageRecord = mongoose.model('ImageRecord', imageSchema);

app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(session({
  name: 'iranqr.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGODB_URI, collectionName: 'sessions' }),
  cookie: { httpOnly: true, secure: 'auto', sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype))
});

function adminOnly(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'ابتدا وارد پنل مدیریت شوید.' });
}

function uploadToCloudinary(buffer, serial) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({
      folder: 'islamic-republic-of-iran',
      public_id: `image-${serial}-${Date.now()}`,
      resource_type: 'image',
      overwrite: false
    }, (error, result) => error ? reject(error) : resolve(result));
    stream.end(buffer);
  });
}

async function removeExpired() {
  const expired = await ImageRecord.find({ expiresAt: { $lte: new Date() } });
  for (const item of expired) {
    try { await cloudinary.uploader.destroy(item.publicId, { resource_type: 'image' }); }
    catch (e) { console.error('Cloudinary delete failed:', item.publicId, e.message); }
    await ImageRecord.deleteOne({ _id: item._id });
  }
}
setInterval(() => removeExpired().catch(e => console.error('Expiry cleanup:', e.message)), 60 * 60 * 1000);

app.get('/api/session', (req, res) => res.json({ loggedIn: !!req.session.isAdmin }));
app.post('/api/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'رمز عبور اشتباه است.' });
  req.session.isAdmin = true;
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.post('/api/upload', adminOnly, upload.single('image'), async (req, res) => {
  try {
    await removeExpired();
    if (!req.file) return res.status(400).json({ error: 'یک تصویر معتبر انتخاب کنید (حداکثر ۱۰ مگابایت).' });
    const serial = String(req.body.serial || '').trim();
    if (!serial || serial.length > 40 || !/^[\p{L}\p{N}._-]+$/u.test(serial)) {
      return res.status(400).json({ error: 'سریال را وارد کنید؛ فقط حروف، عدد، نقطه، خط تیره و زیرخط مجاز است.' });
    }
    if (await ImageRecord.findOne({ serial })) return res.status(409).json({ error: 'این سریال قبلاً ثبت شده است. سریال دیگری انتخاب کنید.' });

    const uploaded = await uploadToCloudinary(req.file.buffer, serial);
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    await ImageRecord.create({ serial, publicId: uploaded.public_id, imageUrl: uploaded.secure_url, expiresAt });
    const viewUrl = `${BASE_URL}/view/${encodeURIComponent(serial)}`;
    const qrDataUrl = await QRCode.toDataURL(viewUrl, { errorCorrectionLevel: 'H', margin: 2, width: 420, color: { dark: '#000000', light: '#FFFFFF' } });
    res.json({ ok: true, serial, viewUrl, qrDataUrl, expiresAt: expiresAt.toISOString() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'ثبت تصویر انجام نشد. تنظیمات سرویس ذخیره‌سازی را بررسی کنید.' });
  }
});

app.get('/api/search/:serial', async (req, res) => {
  try {
    await removeExpired();
    const item = await ImageRecord.findOne({ serial: req.params.serial, expiresAt: { $gt: new Date() } });
    if (!item) return res.status(404).json({ error: 'تصویری با این سریال پیدا نشد یا مهلت ۱۴ روزه آن تمام شده است.' });
    res.json({ serial: item.serial, imageUrl: item.imageUrl, expiresAt: item.expiresAt });
  } catch (e) { res.status(500).json({ error: 'خطا در جست‌وجو.' }); }
});

app.get('/view/:serial', async (req, res) => {
  try {
    await removeExpired();
    const item = await ImageRecord.findOne({ serial: req.params.serial, expiresAt: { $gt: new Date() } });
    if (!item) return res.status(404).sendFile(path.join(__dirname, 'public', 'expired.html'));
    res.send(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>مشاهده تصویر | Islamic Republic of Iran</title><style>body{margin:0;background:#f3f5f7;font-family:Tahoma,Arial,sans-serif;display:grid;place-items:center;min-height:100vh}.card{background:white;padding:22px;border-radius:18px;max-width:900px;width:calc(100% - 36px);box-sizing:border-box;text-align:center;box-shadow:0 8px 30px #0001}img{max-width:100%;max-height:78vh;object-fit:contain;border-radius:10px}.muted{color:#687386;font-size:13px}h2{font-size:18px}</style></head><body><main class="card"><h2>ISLAMIC REPUBLIC OF IRAN</h2><p class="muted">سریال: ${escapeHtml(item.serial)}</p><img src="${escapeHtml(item.imageUrl)}" alt="Uploaded image"><p class="muted">این لینک تا ${new Date(item.expiresAt).toLocaleString('fa-IR')} معتبر است.</p></main></body></html>`);
  } catch (e) { res.status(500).send('خطا در نمایش تصویر'); }
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}

app.get('/api/admin/images', adminOnly, async (req, res) => {
  await removeExpired();
  const rows = await ImageRecord.find({ expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean();
  res.json(rows.map(x => ({ serial: x.serial, createdAt: x.createdAt, expiresAt: x.expiresAt, viewUrl: `${BASE_URL}/view/${encodeURIComponent(x.serial)}` })));
});

app.delete('/api/admin/images/:serial', adminOnly, async (req, res) => {
  const item = await ImageRecord.findOne({ serial: req.params.serial });
  if (!item) return res.status(404).json({ error: 'تصویر پیدا نشد.' });
  try { await cloudinary.uploader.destroy(item.publicId, { resource_type: 'image' }); } catch (e) { console.error(e.message); }
  await ImageRecord.deleteOne({ _id: item._id });
  res.json({ ok: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
