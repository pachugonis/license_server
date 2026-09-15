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

const VERSION = '3.0.0';
const app = express();
const PORT = process.env.LICENSE_SERVER_PORT || 3001;
const JWT_SECRET = process.env.LICENSE_JWT_SECRET || 'your-secret-key-change-in-production';
// Учётные данные для входа в веб-админку
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DB_FILE = 'license-database.json';

// Каталог релизов: releases/<productId>/ с артефактами и манифестом releases.json.
// Файлы туда кладёт скрипт сборки продукта (по scp), сервер их только раздаёт.
const RELEASES_DIR = path.resolve(process.env.RELEASES_DIR || 'releases');

// Модель лицензии одна для всех продуктов: пожизненная, на один домен
// (домен можно сменить через отвязку).
const LICENSE_TYPE = 'lifetime';
const MAX_DOMAINS = 1;

// Middleware
app.use(cors());
app.use(express.json());

// Веб-админка (одностраничное приложение без сборки) на /admin
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));

// ============================================================================
// Database Functions (JSON-based)
// ============================================================================

let database = {
  products: [],
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
    database.products = database.products || [];
    console.log('✅ Database loaded from file');
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('ℹ️  Creating new database file');
      await saveDatabase();
    } else {
      // Не продолжаем с пустой базой: первая же запись затёрла бы файл.
      console.error('❌ Error loading database:', error);
      process.exit(1);
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
// Products
// ============================================================================

// Продукты подключаются из веб-админки и хранятся в базе:
// { id, name, keyPrefix, features: { name: true }, createdAt }.
const PRODUCT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const KEY_PREFIX_RE = /^[A-Z0-9]{1,32}-$/;
const FEATURE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function getProduct(productId) {
  return database.products.find(p => p.id === productId);
}

function normalizeProductId(raw) {
  return raw == null ? '' : String(raw).trim().toLowerCase();
}

// Префикс ключа: заданный вручную (MK или MK-) либо построенный из id (market → MARKET-).
function normalizeKeyPrefix(raw, productId) {
  const base = raw == null || String(raw).trim() === ''
    ? productId.replace(/-/g, '')
    : String(raw).trim().replace(/-+$/, '');
  return `${base.toUpperCase()}-`;
}

// Функции продукта: массив имён или строка через запятую → { name: true }.
function parseFeatures(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,]+/);
  const features = {};
  for (const item of list) {
    const name = String(item).trim();
    if (!name) continue;
    if (!FEATURE_RE.test(name)) return { error: `Invalid feature name "${name}"` };
    features[name] = true;
  }
  return { features };
}

function productView(product) {
  return {
    ...product,
    releasesDir: productReleasesDir(product.id),
    licenseCount: database.licenses.filter(l => l.productId === product.id).length,
  };
}

// Продукт, от имени которого обращается программа (клиент или админка).
// Возвращает { ok, productId } либо { ok:false, code, error, message }.
function resolveProduct(raw) {
  const productId = normalizeProductId(raw);
  if (!productId) {
    return { ok: false, code: 400, error: 'PRODUCT_REQUIRED', message: 'productId is required' };
  }
  if (!getProduct(productId)) {
    return { ok: false, code: 400, error: 'UNKNOWN_PRODUCT', message: `Unknown product "${productId}"` };
  }
  return { ok: true, productId };
}

const productMismatch = (productId) => ({
  error: 'PRODUCT_MISMATCH',
  message: `License key is not valid for product "${productId}"`,
});

// ============================================================================
// Helper Functions
// ============================================================================

function generateLicenseKey(prefix) {
  let key;
  do {
    const segments = [];
    for (let i = 0; i < 4; i++) {
      segments.push(crypto.randomBytes(2).toString('hex').toUpperCase());
    }
    key = `${prefix}${segments.join('-')}`;
  } while (getLicenseByKey(key));
  return key;
}

// Продукт зашит в токен: heartbeat, status и unbind-domain сверяют его
// с productId лицензии.
function generateToken(licenseKey, customerId, productId) {
  return jwt.sign({ licenseKey, customerId, productId }, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

// Клиентский токен выдаётся при активации на одну лицензию: запрос по другому
// ключу отклоняется до поиска лицензии, чтобы не раскрывать, существует ли ключ.
// Возвращает тело ответа 403 либо null.
function tokenLicenseMismatch(tokenPayload, licenseKey) {
  if (tokenPayload.licenseKey === licenseKey) return null;
  return { error: 'TOKEN_LICENSE_MISMATCH', message: 'Token was issued for another license' };
}

function tokenMatchesProduct(tokenPayload, license) {
  return tokenPayload.productId === license.productId;
}

function getLicenseByKey(licenseKey) {
  return database.licenses.find(l => l.licenseKey === licenseKey);
}

// Функции лицензии берутся из продукта на момент запроса: изменение набора
// функций в админке сразу действует для всех ключей продукта.
function licenseFeatures(license) {
  return getProduct(license.productId)?.features || {};
}

function getDomainBindings(licenseId) {
  return database.domainBindings.filter(b => b.licenseId === licenseId && b.isActive);
}

function logValidation(licenseId, productId, domain, success, ipAddress, userAgent, errorMessage = null) {
  database.validationLogs.push({
    id: database.nextId.log++,
    licenseId,
    productId,
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

// Каталог релизов продукта — releases/<productId>/. productId здесь всегда
// проверен PRODUCT_ID_RE, поэтому выйти за RELEASES_DIR нельзя.
function productReleasesDir(productId) {
  return path.join(RELEASES_DIR, productId);
}

// Прочитать манифест релизов releases.json из каталога продукта. Формат:
// { "stable": { version, file, sha256, signature, size, publishedAt }, ... }
async function readManifest(dir) {
  try {
    const raw = await fs.readFile(path.join(dir, 'releases.json'), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Error reading releases manifest in ${dir}:`, error);
    return {};
  }
}

// Единая проверка лицензии для выдачи релиза: продукт совпадает, активна,
// не истекла, домен привязан.
// Возвращает { ok, license } либо { ok:false, code, error, message }.
function checkLicenseForRelease(licenseKey, domain, productId) {
  if (!licenseKey || !domain) {
    return { ok: false, code: 400, error: 'INVALID_REQUEST', message: 'License key and domain are required' };
  }
  const license = getLicenseByKey(licenseKey);
  if (!license) {
    return { ok: false, code: 404, error: 'INVALID_KEY', message: 'License key not found' };
  }
  if (license.productId !== productId) {
    return { ok: false, code: 403, ...productMismatch(productId) };
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

  // Клиентский токен выдаётся при активации и всегда содержит продукт;
  // admin-токен сюда не подходит.
  if (!decoded || !decoded.productId) {
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
    version: VERSION,
    products: database.products.map(p => p.id),
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

// ---- Продукты ----

app.get('/api/admin/products', authenticateAdmin, (req, res) => {
  res.json({ success: true, products: database.products.map(productView) });
});

// Подключить продукт: { id, name, keyPrefix?, features? }.
// id и префикс после создания не меняются: id хранится в лицензиях и токенах
// клиентов и задаёт каталог релизов.
app.post('/api/admin/products', authenticateAdmin, async (req, res) => {
  const body = req.body || {};
  const id = normalizeProductId(body.id);
  const name = String(body.name ?? '').trim();
  const invalid = (message) => res.status(400).json({ success: false, error: 'INVALID_PRODUCT', message });

  if (!PRODUCT_ID_RE.test(id)) {
    return invalid('id: lowercase latin letters, digits and "-", up to 32 chars, starting with a letter or digit');
  }
  if (getProduct(id)) {
    return res.status(409).json({ success: false, error: 'PRODUCT_EXISTS', message: `Product "${id}" already exists` });
  }
  if (!name || name.length > 100) return invalid('name is required (up to 100 chars)');

  const keyPrefix = normalizeKeyPrefix(body.keyPrefix, id);
  if (!KEY_PREFIX_RE.test(keyPrefix)) {
    return invalid('keyPrefix: latin letters and digits, up to 32 chars');
  }
  const prefixOwner = database.products.find(p => p.keyPrefix === keyPrefix);
  if (prefixOwner) {
    return res.status(409).json({
      success: false,
      error: 'PREFIX_IN_USE',
      message: `Key prefix ${keyPrefix} is already used by product "${prefixOwner.id}"`,
    });
  }

  const parsed = parseFeatures(body.features);
  if (parsed.error) return invalid(parsed.error);

  const product = { id, name, keyPrefix, features: parsed.features, createdAt: Date.now() };
  database.products.push(product);
  await saveDatabase();

  // Каталог релизов создаём сразу; без него сервер просто ответит NO_RELEASE.
  await fs.mkdir(productReleasesDir(id), { recursive: true })
    .catch(error => console.warn(`⚠️  Cannot create releases dir for "${id}": ${error.message}`));

  res.json({ success: true, product: productView(product), message: 'Product created' });
});

// Изменить название и набор функций продукта
app.patch('/api/admin/products/:id', authenticateAdmin, async (req, res) => {
  const product = getProduct(req.params.id);
  if (!product) {
    return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Product not found' });
  }

  const body = req.body || {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name || name.length > 100) {
      return res.status(400).json({ success: false, error: 'INVALID_PRODUCT', message: 'name is required (up to 100 chars)' });
    }
    product.name = name;
  }
  if (body.features !== undefined) {
    const parsed = parseFeatures(body.features);
    if (parsed.error) {
      return res.status(400).json({ success: false, error: 'INVALID_PRODUCT', message: parsed.error });
    }
    product.features = parsed.features;
  }

  await saveDatabase();
  res.json({ success: true, product: productView(product), message: 'Product updated' });
});

// Удалить продукт можно, только пока по нему не выпущено ни одного ключа
app.delete('/api/admin/products/:id', authenticateAdmin, async (req, res) => {
  const product = getProduct(req.params.id);
  if (!product) {
    return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Product not found' });
  }
  if (database.licenses.some(l => l.productId === product.id)) {
    return res.status(409).json({
      success: false,
      error: 'PRODUCT_IN_USE',
      message: 'Product has licenses and cannot be deleted',
    });
  }

  database.products = database.products.filter(p => p !== product);
  await saveDatabase();
  res.json({ success: true, message: 'Product deleted' });
});

// ---- Лицензии ----

// Список лицензий с привязанными доменами (для веб-админки).
// Необязательный ?productId= отбирает лицензии одного продукта.
app.get('/api/admin/licenses', authenticateAdmin, (req, res) => {
  const { productId } = req.query;
  const licenses = database.licenses
    .filter(license => !productId || license.productId === productId)
    .map(license => ({
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
  // Все лицензии пожизненные, на один домен. Почта и домен не задаются —
  // привязываются при активации клиентом.
  const resolved = resolveProduct((req.body || {}).productId);
  if (!resolved.ok) {
    return res.status(resolved.code).json({ success: false, error: resolved.error, message: resolved.message });
  }
  const { productId } = resolved;
  const product = getProduct(productId);

  const license = {
    id: database.nextId.license++,
    licenseKey: generateLicenseKey(product.keyPrefix),
    productId,
    licenseType: LICENSE_TYPE,
    status: 'active',
    customerId: null,        // присваивается при активации
    customerEmail: null,     // привязывается при активации
    issuedAt: Date.now(),
    expiresAt: null,         // пожизненная
    activatedAt: null,
    maxDomains: MAX_DOMAINS,
    canChangeDomain: true,
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

// Удалить можно только отозванный ключ: действующий клиент не должен
// потерять лицензию одним кликом. Привязки доменов удаляются вместе с ключом,
// журналы проверок и скачиваний остаются как история.
app.delete('/api/admin/licenses/:id', authenticateAdmin, async (req, res) => {
  const license = database.licenses.find(l => l.id === parseInt(req.params.id, 10));
  if (!license) {
    return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'License not found' });
  }
  if (license.status !== 'revoked') {
    return res.status(409).json({
      success: false,
      error: 'LICENSE_NOT_REVOKED',
      message: 'Only revoked licenses can be deleted',
    });
  }

  database.licenses = database.licenses.filter(l => l !== license);
  database.domainBindings = database.domainBindings.filter(b => b.licenseId !== license.id);
  await saveDatabase();
  res.json({ success: true, message: 'License deleted' });
});

// ---- Клиентские эндпоинты ----

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

  const product = resolveProduct(req.body.productId);
  if (!product.ok) {
    return res.status(product.code).json({ success: false, error: product.error, message: product.message });
  }
  const { productId } = product;

  const license = getLicenseByKey(licenseKey);

  if (!license) {
    return res.status(404).json({
      success: false,
      error: 'INVALID_KEY',
      message: 'License key not found',
    });
  }

  if (license.productId !== productId) {
    logValidation(license.id, productId, domain, false, req.ip, req.get('user-agent'), 'Product mismatch');
    return res.status(403).json({ success: false, ...productMismatch(productId) });
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

  // Повторные активации должны использовать тот же e-mail, что и первая.
  if (license.customerEmail && license.customerEmail.toLowerCase() !== customerEmail.toLowerCase()) {
    return res.status(403).json({
      success: false,
      error: 'EMAIL_MISMATCH',
      message: 'Email does not match the one used to activate this license',
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

  // Первая активация: привязываем e-mail, введённый клиентом.
  if (!license.customerEmail) {
    license.customerEmail = customerEmail;
    if (!license.customerId) license.customerId = crypto.randomBytes(8).toString('hex');
    license.activatedAt = now;
  }

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
  logValidation(license.id, productId, domain, true, req.ip, req.get('user-agent'));

  const updatedBindings = getDomainBindings(license.id);
  const token = generateToken(licenseKey, license.customerId, license.productId);

  res.json({
    success: true,
    license: {
      ...license,
      features: licenseFeatures(license),
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

  const product = resolveProduct(req.body.productId);
  if (!product.ok) {
    return res.status(product.code).json({ valid: false, error: product.error, message: product.message });
  }
  const { productId } = product;

  const license = getLicenseByKey(licenseKey);

  if (!license) {
    logValidation(0, productId, domain, false, req.ip, req.get('user-agent'), 'License not found');
    return res.status(404).json({
      valid: false,
      error: 'INVALID_KEY',
      message: 'License key not found',
    });
  }

  if (license.productId !== productId) {
    logValidation(license.id, productId, domain, false, req.ip, req.get('user-agent'), 'Product mismatch');
    return res.status(403).json({ valid: false, ...productMismatch(productId) });
  }

  if (license.status === 'suspended') {
    logValidation(license.id, productId, domain, false, req.ip, req.get('user-agent'), 'License suspended');
    return res.json({
      valid: false,
      licenseKey: license.licenseKey,
      productId: license.productId,
      licenseType: license.licenseType,
      status: 'suspended',
      error: 'SUSPENDED',
      message: 'License has been suspended',
    });
  }

  if (license.status === 'revoked') {
    logValidation(license.id, productId, domain, false, req.ip, req.get('user-agent'), 'License revoked');
    return res.json({
      valid: false,
      licenseKey: license.licenseKey,
      productId: license.productId,
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
    logValidation(license.id, productId, domain, false, req.ip, req.get('user-agent'), 'License expired');
    return res.json({
      valid: false,
      licenseKey: license.licenseKey,
      productId: license.productId,
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
    logValidation(license.id, productId, domain, false, req.ip, req.get('user-agent'), 'Domain mismatch');
    return res.json({
      valid: false,
      licenseKey: license.licenseKey,
      productId: license.productId,
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
  logValidation(license.id, productId, domain, true, req.ip, req.get('user-agent'));

  const daysRemaining = license.expiresAt
    ? Math.ceil((license.expiresAt - now) / (24 * 60 * 60 * 1000))
    : null;

  res.json({
    valid: true,
    licenseKey: license.licenseKey,
    productId: license.productId,
    licenseType: license.licenseType,
    status: 'active',
    expiresAt: license.expiresAt,
    daysRemaining,
    features: licenseFeatures(license),
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

  const tokenMismatch = tokenLicenseMismatch(req.user, licenseKey);
  if (tokenMismatch) {
    return res.status(403).json({ success: false, ...tokenMismatch });
  }

  const license = getLicenseByKey(licenseKey);

  if (!license) {
    return res.status(404).json({
      success: false,
      error: 'NOT_FOUND',
      message: 'License not found'
    });
  }

  if (!tokenMatchesProduct(req.user, license)) {
    return res.status(403).json({ success: false, ...productMismatch(req.user.productId) });
  }

  if (!license.canChangeDomain) {
    return res.status(403).json({
      success: false,
      error: 'DOMAIN_CHANGE_NOT_ALLOWED',
      message: 'This license does not allow domain changes',
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

  const tokenMismatch = tokenLicenseMismatch(req.user, licenseKey);
  if (tokenMismatch) {
    return res.status(403).json({ acknowledged: false, ...tokenMismatch });
  }

  const license = getLicenseByKey(licenseKey);

  if (!license) {
    return res.status(404).json({
      acknowledged: false,
      error: 'INVALID_KEY',
      message: 'License not found',
    });
  }

  if (!tokenMatchesProduct(req.user, license)) {
    return res.status(403).json({ acknowledged: false, ...productMismatch(req.user.productId) });
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

  const tokenMismatch = tokenLicenseMismatch(req.user, licenseKey);
  if (tokenMismatch) {
    return res.status(403).json(tokenMismatch);
  }

  const license = getLicenseByKey(licenseKey);

  if (!license) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'License not found' });
  }

  if (!tokenMatchesProduct(req.user, license)) {
    return res.status(403).json(productMismatch(req.user.productId));
  }

  const bindings = getDomainBindings(license.id);
  const now = Date.now();
  const daysRemaining = license.expiresAt
    ? Math.ceil((license.expiresAt - now) / (24 * 60 * 60 * 1000))
    : null;

  res.json({
    valid: license.status === 'active' && (!license.expiresAt || license.expiresAt > now),
    licenseKey: license.licenseKey,
    productId: license.productId,
    licenseType: license.licenseType,
    status: license.status,
    expiresAt: license.expiresAt,
    daysRemaining,
    features: licenseFeatures(license),
    boundDomains: bindings.map(b => b.domain),
    maxDomains: license.maxDomains,
    canChangeDomain: license.canChangeDomain,
    message: 'License status retrieved',
  });
});

// ---- GET /api/release/latest ---- метаданные последнего релиза для лицензии
// Параметры: licenseKey, domain, productId (обязателен),
// channel (по умолчанию stable).
app.get('/api/release/latest', async (req, res) => {
  const { licenseKey, domain, channel = 'stable' } = req.query;

  const product = resolveProduct(req.query.productId);
  if (!product.ok) {
    return res.status(product.code).json({ error: product.error, message: product.message });
  }
  const { productId } = product;

  const check = checkLicenseForRelease(licenseKey, domain, productId);
  if (!check.ok) {
    logValidation(0, productId, domain || '', false, req.ip, req.get('user-agent'), `release/latest: ${check.error}`);
    return res.status(check.code).json({ error: check.error, message: check.message });
  }

  const manifest = await readManifest(productReleasesDir(productId));
  const rel = manifest[channel];
  if (!rel) {
    return res.status(404).json({ error: 'NO_RELEASE', message: `No release published for channel "${channel}"` });
  }

  const query = new URLSearchParams({ licenseKey, domain, productId });
  res.json({
    version: rel.version,
    productId,
    channel,
    sha256: rel.sha256,
    signature: rel.signature,
    size: rel.size,
    publishedAt: rel.publishedAt,
    downloadUrl: `/api/release/download/${rel.version}?${query}`,
  });
});

// ---- GET /api/release/download/:version ---- отдать подписанный архив релиза
app.get('/api/release/download/:version', async (req, res) => {
  const { licenseKey, domain } = req.query;
  const { version } = req.params;

  const product = resolveProduct(req.query.productId);
  if (!product.ok) {
    return res.status(product.code).json({ error: product.error, message: product.message });
  }
  const { productId } = product;

  const check = checkLicenseForRelease(licenseKey, domain, productId);
  if (!check.ok) {
    logValidation(0, productId, domain || '', false, req.ip, req.get('user-agent'), `release/download: ${check.error}`);
    return res.status(check.code).json({ error: check.error, message: check.message });
  }

  const dir = productReleasesDir(productId);
  const manifest = await readManifest(dir);
  // Ищем релиз с такой версией в любом канале — только среди релизов этого продукта.
  const rel = Object.values(manifest).find(r => r && r.version === version);
  if (!rel || !rel.file) {
    return res.status(404).json({ error: 'NO_RELEASE', message: `Release ${version} not found` });
  }

  // Защита от path traversal: используем только basename из манифеста.
  const filePath = path.join(dir, path.basename(rel.file));

  database.downloadLogs.push({
    id: database.nextId.download++,
    licenseId: check.license.id,
    productId,
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
  console.log(`  🔐 License Server v${VERSION}`);
  console.log('════════════════════════════════════════════════════════');
  console.log('');
  console.log(`  ✅ Server running on port ${PORT}`);
  console.log(`  🌐 Health check: http://localhost:${PORT}/api/health`);
  console.log(`  💾 Database: ${DB_FILE}`);
  console.log(`  📦 Releases:  ${RELEASES_DIR}/<productId>/`);
  console.log(`  🗂  Products:  ${database.products.length} (управление — /admin)`);
  console.log('');
  console.log('  License model: пожизненная, 1 домен (привязка при активации)');
  console.log('');
  console.log('  Press Ctrl+C to stop');
  console.log('');
  console.log('════════════════════════════════════════════════════════');
});
