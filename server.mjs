import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.LICENSE_SERVER_PORT || 3001;
const JWT_SECRET = process.env.LICENSE_JWT_SECRET || 'your-secret-key-change-in-production';
// Учётные данные для входа в веб-админку
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DB_FILE = 'license-database.json';

// Каталог с артефактами релизов и манифестом releases.json.
// Файлы туда кладёт скрипт сборки release.sh (по scp), сервер их только раздаёт.
const RELEASES_DIR = process.env.RELEASES_DIR || path.resolve('releases');
const MANIFEST_FILE = path.join(RELEASES_DIR, 'releases.json');

// Middleware
app.use(cors());
app.use(express.json());

// Веб-админка (одностраничное приложение без сборки) на /admin
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));

// ============================================================================
// Database Functions (JSON-based)
// ============================================================================

let database = {
  licenses: [],
  domainBindings: [],
  validationLogs: [],
  downloadLogs: [],
  nextId: {
    license: 1,
    binding: 1,
    log: 1,
    download: 1
  }
};

// Load database from file
async function loadDatabase() {
  try {
    const data = await fs.readFile(DB_FILE, 'utf8');
    database = JSON.parse(data);
    console.log('✅ Database loaded from file');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('ℹ️  Creating new database file');
      await saveDatabase();
    } else {
      console.error('Error loading database:', error);
    }
  }
}

// Save database to file
async function saveDatabase() {
  try {
    await fs.writeFile(DB_FILE, JSON.stringify(database, null, 2));
  } catch (error) {
    console.error('Error saving database:', error);
  }
}

// Initialize database
await loadDatabase();

// ============================================================================
// Helper Functions
// ============================================================================

function generateLicenseKey() {
  const segments = [];
  for (let i = 0; i < 4; i++) {
    segments.push(crypto.randomBytes(2).toString('hex').toUpperCase());
  }
  return `LIC-${segments.join('-')}`;
}

function generateToken(licenseKey, customerId) {
  return jwt.sign({ licenseKey, customerId }, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

function getLicenseByKey(licenseKey) {
  return database.licenses.find(l => l.licenseKey === licenseKey);
}

function getDomainBindings(licenseId) {
  return database.domainBindings.filter(b => b.licenseId === licenseId && b.isActive);
}

function logValidation(licenseId, domain, success, ipAddress, userAgent, errorMessage = null) {
  database.validationLogs.push({
    id: database.nextId.log++,
    licenseId,
    domain,
    success,
    ipAddress,
    userAgent,
    errorMessage,
    validatedAt: Date.now()
  });
  saveDatabase();
}

function isDomainMatch(bindings, domain) {
  for (const binding of bindings) {
    if (binding.domain === domain) return true;
    if (binding.domain.startsWith('*.')) {
      const baseDomain = binding.domain.substring(2);
      if (domain.endsWith(`.${baseDomain}`) || domain === baseDomain) return true;
    }
    if ((binding.domain === 'localhost' || binding.domain === '127.0.0.1') &&
        (domain === 'localhost' || domain === '127.0.0.1')) return true;
  }
  return false;
}

// ============================================================================
// Release Distribution
// ============================================================================

// Прочитать манифест релизов releases.json. Формат:
// { "stable": { version, file, sha256, signature, size, publishedAt }, ... }
async function readManifest() {
  try {
    const raw = await fs.readFile(MANIFEST_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Error reading releases manifest:', error);
    return {};
  }
}

// Единая проверка лицензии для выдачи релиза: активна, не истекла, домен привязан.
// Возвращает { ok, license } либо { ok:false, code, error, message }.
function checkLicenseForRelease(licenseKey, domain) {
  if (!licenseKey || !domain) {
    return { ok: false, code: 400, error: 'INVALID_REQUEST', message: 'License key and domain are required' };
  }
  const license = getLicenseByKey(licenseKey);
  if (!license) {
    return { ok: false, code: 404, error: 'INVALID_KEY', message: 'License key not found' };
  }
  if (license.status === 'suspended' || license.status === 'revoked') {
    return { ok: false, code: 403, error: license.status.toUpperCase(), message: `License is ${license.status}` };
  }
  if (license.expiresAt && license.expiresAt < Date.now()) {
    license.status = 'expired';
    saveDatabase();
    return { ok: false, code: 403, error: 'EXPIRED', message: 'License has expired' };
  }
  const bindings = getDomainBindings(license.id);
  if (!isDomainMatch(bindings, domain)) {
    return { ok: false, code: 403, error: 'DOMAIN_MISMATCH', message: 'Domain not authorized for this license' };
  }
  return { ok: true, license };
}

// ============================================================================
// Authentication Middleware
// ============================================================================

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Missing or invalid token' });
  }

  const token = authHeader.substring(7);
  const decoded = verifyToken(token);

  if (!decoded) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token' });
  }

  req.user = decoded;
  next();
}

// Сравнение строк, устойчивое к timing-атакам
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Admin-токен веб-админки (отдельная роль 'admin' в payload)
function generateAdminToken(username) {
  return jwt.sign({ role: 'admin', username }, JWT_SECRET, { expiresIn: '12h' });
}

// Доступ к admin-эндпоинтам: либо Bearer admin-токен, либо заголовок
// x-admin-password (для обратной совместимости со скриптами/curl).
function authenticateAdmin(req, res, next) {
  const adminPassword = req.headers['x-admin-password'];
  if (adminPassword && ADMIN_PASSWORD && safeEqual(adminPassword, ADMIN_PASSWORD)) {
    req.admin = { username: ADMIN_USERNAME, via: 'password' };
    return next();
  }

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const decoded = verifyToken(authHeader.substring(7));
    if (decoded && decoded.role === 'admin') {
      req.admin = { username: decoded.username, via: 'token' };
      return next();
    }
  }

  return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Admin authentication required' });
}

// ============================================================================
// API Endpoints
// ============================================================================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    version: '2.0.0',
    totalLicenses: database.licenses.length,
    activeLicenses: database.licenses.filter(l => l.status === 'active').length
  });
});

// Вход в веб-админку по логину и паролю → выдаёт admin-токен на 12 часов
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};

  if (!ADMIN_PASSWORD) {
    return res.status(500).json({
      success: false,
      error: 'NOT_CONFIGURED',
      message: 'ADMIN_PASSWORD is not set on the server',
    });
  }

  if (!safeEqual(username || '', ADMIN_USERNAME) || !safeEqual(password || '', ADMIN_PASSWORD)) {
    return res.status(401).json({
      success: false,
      error: 'INVALID_CREDENTIALS',
      message: 'Invalid username or password',
    });
  }

  res.json({
    success: true,
    token: generateAdminToken(ADMIN_USERNAME),
    username: ADMIN_USERNAME,
    expiresIn: 43200,
  });
});

// Список всех лицензий с привязанными доменами (для веб-админки)
app.get('/api/admin/licenses', authenticateAdmin, (req, res) => {
  const licenses = database.licenses.map(license => ({
    ...license,
    boundDomains: getDomainBindings(license.id),
  }));

  res.json({
    success: true,
    total: licenses.length,
    licenses: licenses.sort((a, b) => b.issuedAt - a.issuedAt),
  });
});

app.post('/api/admin/licenses', authenticateAdmin, async (req, res) => {
  // Все лицензии одного типа: Professional, бессрочно, на один домен.
  // При генерации указывается ТОЛЬКО ключ — почта и домен не задаются.
  // Привязка к почте и домену происходит при активации клиентом на его сервере.
  const licenseType = 'professional';
  const maxDomains = 1;
  const canChangeDomain = true;

  const features = {
    crypto: true,
    telegram: true,
    kyc: true,
    customBranding: true,
    prioritySupport: true,
    api: true,
    multiCurrency: true,
    analytics: true,
  };

  const licenseKey = generateLicenseKey();
  const now = Date.now();

  const license = {
    id: database.nextId.license++,
    licenseKey,
    licenseType,
    status: 'active',
    customerId: null,        // присваивается при активации
    customerEmail: null,     // привязывается при активации
    issuedAt: now,
    expiresAt: null,         // бессрочно
    activatedAt: null,
    maxDomains,
    canChangeDomain,
    features,
    validationCount: 0,
    lastValidated: null
  };

  database.licenses.push(license);
  await saveDatabase();

  res.json({
    success: true,
    license,
    message: 'License created successfully',
  });
});

// Смена статуса лицензии из веб-админки: active | suspended | revoked
app.patch('/api/admin/licenses/:id/status', authenticateAdmin, async (req, res) => {
  const { status } = req.body || {};
  const allowed = ['active', 'suspended', 'revoked'];

  if (!allowed.includes(status)) {
    return res.status(400).json({
      success: false,
      error: 'INVALID_STATUS',
      message: `Status must be one of: ${allowed.join(', ')}`,
    });
  }

  const license = database.licenses.find(l => l.id === parseInt(req.params.id, 10));
  if (!license) {
    return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'License not found' });
  }

  license.status = status;
  await saveDatabase();

  res.json({
    success: true,
    license: { ...license, boundDomains: getDomainBindings(license.id) },
    message: `License status changed to ${status}`,
  });
});

app.post('/api/license/activate', async (req, res) => {
  const { licenseKey, customerEmail, domain, protocol = 'https', termsAgreed } = req.body;

  if (!licenseKey || !customerEmail || !domain) {
    return res.status(400).json({
      success: false,
      error: 'INVALID_REQUEST',
      message: 'License key, email, and domain are required',
    });
  }

  if (!termsAgreed) {
    return res.status(400).json({
      success: false,
      error: 'TERMS_NOT_AGREED',
      message: 'You must agree to the license terms',
    });
  }

  const license = getLicenseByKey(licenseKey);

  if (!license) {
    return res.status(404).json({
      success: false,
      error: 'INVALID_KEY',
      message: 'License key not found',
    });
  }

  // Первая активация: привязываем e-mail, введённый клиентом, к лицензии.
  // Повторные активации должны использовать тот же e-mail.
  if (!license.customerEmail) {
    license.customerEmail = customerEmail;
    if (!license.customerId) license.customerId = crypto.randomBytes(8).toString('hex');
    license.activatedAt = Date.now();
  } else if (license.customerEmail.toLowerCase() !== customerEmail.toLowerCase()) {
    return res.status(403).json({
      success: false,
      error: 'EMAIL_MISMATCH',
      message: 'Email does not match the one used to activate this license',
    });
  }

  if (license.status !== 'active') {
    return res.status(403).json({
      success: false,
      error: 'LICENSE_INACTIVE',
      message: `License is ${license.status}`,
    });
  }

  if (license.expiresAt && license.expiresAt < Date.now()) {
    license.status = 'expired';
    await saveDatabase();
    return res.status(403).json({
      success: false,
      error: 'EXPIRED',
      message: 'License has expired',
    });
  }

  const bindings = getDomainBindings(license.id);
  const existingBinding = bindings.find(b => b.domain === domain);
  
  if (!existingBinding && bindings.length >= license.maxDomains) {
    return res.status(403).json({
      success: false,
      error: 'DOMAIN_LIMIT_REACHED',
      message: `Maximum ${license.maxDomains} domain allowed`,
    });
  }

  const now = Date.now();

  if (existingBinding) {
    existingBinding.protocol = protocol;
    existingBinding.lastValidated = now;
    existingBinding.isActive = true;
  } else {
    database.domainBindings.push({
      id: database.nextId.binding++,
      licenseId: license.id,
      domain,
      protocol,
      boundAt: now,
      lastValidated: now,
      validationCount: 0,
      isActive: true
    });
  }

  license.lastValidated = now;
  license.validationCount++;
  
  await saveDatabase();
  logValidation(license.id, domain, true, req.ip, req.get('user-agent'));

  const updatedBindings = getDomainBindings(license.id);
  const token = generateToken(licenseKey, license.customerId);

  res.json({
    success: true,
    license: {
      ...license,
      boundDomains: updatedBindings
    },
    token,
    message: 'License activated successfully',
  });
});

app.post('/api/license/validate', (req, res) => {
  const { licenseKey, domain, protocol = 'https' } = req.body;

  if (!licenseKey || !domain) {
    return res.status(400).json({
      valid: false,
      error: 'INVALID_REQUEST',
      message: 'License key and domain are required',
    });
  }

  const license = getLicenseByKey(licenseKey);

  if (!license) {
    logValidation(0, domain, false, req.ip, req.get('user-agent'), 'License not found');
    return res.status(404).json({
      valid: false,
      error: 'INVALID_KEY',
      message: 'License key not found',
    });
  }

  if (license.status === 'suspended') {
    logValidation(license.id, domain, false, req.ip, req.get('user-agent'), 'License suspended');
    return res.json({
      valid: false,
      licenseKey: license.licenseKey,
      licenseType: license.licenseType,
      status: 'suspended',
      error: 'SUSPENDED',
      message: 'License has been suspended',
    });
  }

  if (license.status === 'revoked') {
    logValidation(license.id, domain, false, req.ip, req.get('user-agent'), 'License revoked');
    return res.json({
      valid: false,
      licenseKey: license.licenseKey,
      licenseType: license.licenseType,
      status: 'revoked',
      error: 'REVOKED',
      message: 'License has been revoked',
    });
  }

  const now = Date.now();
  
  if (license.expiresAt && license.expiresAt < now) {
    license.status = 'expired';
    saveDatabase();
    logValidation(license.id, domain, false, req.ip, req.get('user-agent'), 'License expired');
    return res.json({
      valid: false,
      licenseKey: license.licenseKey,
      licenseType: license.licenseType,
      status: 'expired',
      expiresAt: license.expiresAt,
      error: 'EXPIRED',
      message: 'License has expired',
    });
  }

  const bindings = getDomainBindings(license.id);
  const domainMatch = isDomainMatch(bindings, domain);

  if (!domainMatch) {
    logValidation(license.id, domain, false, req.ip, req.get('user-agent'), 'Domain mismatch');
    return res.json({
      valid: false,
      licenseKey: license.licenseKey,
      licenseType: license.licenseType,
      status: license.status,
      domainMatch: false,
      boundDomains: bindings.map(b => b.domain),
      canChangeDomain: license.canChangeDomain,
      error: 'DOMAIN_MISMATCH',
      message: 'Domain not authorized',
    });
  }

  license.lastValidated = now;
  license.validationCount++;
  
  const binding = bindings.find(b => b.domain === domain);
  if (binding) {
    binding.lastValidated = now;
    binding.validationCount++;
  }
  
  saveDatabase();
  logValidation(license.id, domain, true, req.ip, req.get('user-agent'));

  const daysRemaining = license.expiresAt 
    ? Math.ceil((license.expiresAt - now) / (24 * 60 * 60 * 1000))
    : null;

  res.json({
    valid: true,
    licenseKey: license.licenseKey,
    licenseType: license.licenseType,
    status: 'active',
    expiresAt: license.expiresAt,
    daysRemaining,
    features: license.features,
    domainMatch: true,
    canChangeDomain: license.canChangeDomain,
    message: 'License is valid',
    nextCheck: 86400,
    boundDomains: bindings.map(b => b.domain),
    maxDomains: license.maxDomains,
  });
});

app.post('/api/license/unbind-domain', authenticate, async (req, res) => {
  const { licenseKey, domainId } = req.body;

  if (!licenseKey || !domainId) {
    return res.status(400).json({ 
      success: false, 
      error: 'INVALID_REQUEST',
      message: 'License key and domain ID are required' 
    });
  }

  const license = getLicenseByKey(licenseKey);

  if (!license) {
    return res.status(404).json({ 
      success: false, 
      error: 'NOT_FOUND',
      message: 'License not found' 
    });
  }

  if (!license.canChangeDomain) {
    return res.status(403).json({
      success: false,
      error: 'DOMAIN_CHANGE_NOT_ALLOWED',
      message: 'This license type does not allow domain changes. Upgrade to Professional license.',
    });
  }

  const binding = database.domainBindings.find(b => b.id === parseInt(domainId) && b.licenseId === license.id);
  
  if (binding) {
    binding.isActive = false;
    await saveDatabase();
  }

  res.json({
    success: true,
    message: 'Domain unbound successfully. You can now bind a new domain.',
  });
});

app.post('/api/license/heartbeat', authenticate, async (req, res) => {
  const { licenseKey, domain } = req.body;

  const license = getLicenseByKey(licenseKey);

  if (!license) {
    return res.status(404).json({
      acknowledged: false,
      error: 'INVALID_KEY',
      message: 'License not found',
    });
  }

  const now = Date.now();
  license.lastValidated = now;

  if (domain) {
    const binding = database.domainBindings.find(b => b.licenseId === license.id && b.domain === domain);
    if (binding) {
      binding.lastValidated = now;
    }
  }

  await saveDatabase();

  res.json({
    acknowledged: true,
    nextCheckIn: 21600,
    message: 'Heartbeat received',
  });
});

app.get('/api/license/status', authenticate, (req, res) => {
  const licenseKey = req.get('X-License-Key');

  if (!licenseKey) {
    return res.status(400).json({ error: 'INVALID_REQUEST', message: 'License key required' });
  }

  const license = getLicenseByKey(licenseKey);

  if (!license) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'License not found' });
  }

  const bindings = getDomainBindings(license.id);
  const now = Date.now();
  const daysRemaining = license.expiresAt 
    ? Math.ceil((license.expiresAt - now) / (24 * 60 * 60 * 1000))
    : null;

  res.json({
    valid: license.status === 'active' && (!license.expiresAt || license.expiresAt > now),
    licenseKey: license.licenseKey,
    licenseType: license.licenseType,
    status: license.status,
    expiresAt: license.expiresAt,
    daysRemaining,
    features: license.features,
    boundDomains: bindings.map(b => b.domain),
    maxDomains: license.maxDomains,
    canChangeDomain: license.canChangeDomain,
    message: 'License status retrieved',
  });
});

// ---- GET /api/release/latest ---- метаданные последнего релиза для лицензии
// Параметры: licenseKey, domain, channel (по умолчанию stable).
app.get('/api/release/latest', async (req, res) => {
  const { licenseKey, domain, channel = 'stable' } = req.query;

  const check = checkLicenseForRelease(licenseKey, domain);
  if (!check.ok) {
    logValidation(0, domain || '', false, req.ip, req.get('user-agent'), `release/latest: ${check.error}`);
    return res.status(check.code).json({ error: check.error, message: check.message });
  }

  const manifest = await readManifest();
  const rel = manifest[channel];
  if (!rel) {
    return res.status(404).json({ error: 'NO_RELEASE', message: `No release published for channel "${channel}"` });
  }

  res.json({
    version: rel.version,
    channel,
    sha256: rel.sha256,
    signature: rel.signature,
    size: rel.size,
    publishedAt: rel.publishedAt,
    downloadUrl: `/api/release/download/${rel.version}?licenseKey=${encodeURIComponent(licenseKey)}&domain=${encodeURIComponent(domain)}`,
  });
});

// ---- GET /api/release/download/:version ---- отдать подписанный архив релиза
app.get('/api/release/download/:version', async (req, res) => {
  const { licenseKey, domain } = req.query;
  const { version } = req.params;

  const check = checkLicenseForRelease(licenseKey, domain);
  if (!check.ok) {
    logValidation(0, domain || '', false, req.ip, req.get('user-agent'), `release/download: ${check.error}`);
    return res.status(check.code).json({ error: check.error, message: check.message });
  }

  const manifest = await readManifest();
  // Ищем релиз с такой версией в любом канале.
  const rel = Object.values(manifest).find(r => r && r.version === version);
  if (!rel || !rel.file) {
    return res.status(404).json({ error: 'NO_RELEASE', message: `Release ${version} not found` });
  }

  // Защита от path traversal: используем только basename из манифеста.
  const filePath = path.join(RELEASES_DIR, path.basename(rel.file));

  // Журнал скачиваний (поля могли отсутствовать в старой БД — инициализируем)
  database.downloadLogs = database.downloadLogs || [];
  database.nextId.download = database.nextId.download || 1;
  database.downloadLogs.push({
    id: database.nextId.download++,
    licenseId: check.license.id,
    version,
    domain,
    ipAddress: req.ip,
    downloadedAt: Date.now(),
  });
  await saveDatabase();

  res.download(filePath, path.basename(rel.file), (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: 'FILE_MISSING', message: 'Release artifact not found on server' });
    }
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    error: 'SERVER_ERROR',
    message: 'An unexpected error occurred',
  });
});

// Start Server
app.listen(PORT, () => {
  console.log('');
  console.log('════════════════════════════════════════════════════════');
  console.log('  🔐 License Server v2.0.0');
  console.log('════════════════════════════════════════════════════════');
  console.log('');
  console.log(`  ✅ Server running on port ${PORT}`);
  console.log(`  🌐 Health check: http://localhost:${PORT}/api/health`);
  console.log(`  💾 Database: ${DB_FILE}`);
  console.log(`  📦 Releases:  ${RELEASES_DIR}`);
  console.log('');
  console.log('  License model:');
  console.log('    • Professional — бессрочно, 1 домен (привязка при активации)');
  console.log('');
  console.log('  Press Ctrl+C to stop');
  console.log('');
  console.log('════════════════════════════════════════════════════════');
});
