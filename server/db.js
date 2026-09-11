import { DatabaseSync } from 'node:sqlite';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.ERFIS_DATA_DIR || join(__dirname, 'data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.ERFIS_DB || join(DATA_DIR, 'erfis.db');

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT,
  must_change INTEGER NOT NULL DEFAULT 1,
  is_manager INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS objects (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  holder TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  app_number TEXT NOT NULL DEFAULT '',
  reg_number TEXT NOT NULL DEFAULT '',
  object_type TEXT NOT NULL DEFAULT '',
  mktu_classes TEXT NOT NULL DEFAULT '',
  priority_date TEXT NOT NULL DEFAULT '',
  expiry_date TEXT NOT NULL DEFAULT '',
  document_ref TEXT NOT NULL DEFAULT '',
  document_url TEXT NOT NULL DEFAULT '',
  responsible TEXT,
  notes TEXT NOT NULL DEFAULT '',
  reminder TEXT,
  extra TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_objects_type ON objects(type, deleted_at);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  object_id TEXT,
  object_type TEXT,
  text TEXT NOT NULL,
  user_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_object ON activity(object_id);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mood_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  mood INTEGER,
  workload TEXT NOT NULL DEFAULT 'ok',
  worked INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  factors TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, date)
);
CREATE INDEX IF NOT EXISTS idx_mood_date ON mood_entries(date);
CREATE TABLE IF NOT EXISTS price_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  fee TEXT NOT NULL DEFAULT '',
  duty TEXT NOT NULL DEFAULT '',
  total TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  amount_kopecks INTEGER NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  payer TEXT NOT NULL DEFAULT '',
  uin TEXT NOT NULL DEFAULT '',
  qr_string TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL
);
`);

// --- миграции для существующих баз ---
const tableCols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
if (!tableCols('users').includes('is_manager')) {
  db.exec('ALTER TABLE users ADD COLUMN is_manager INTEGER NOT NULL DEFAULT 0');
}
if (!tableCols('objects').includes('extra')) {
  db.exec("ALTER TABLE objects ADD COLUMN extra TEXT NOT NULL DEFAULT '{}'");
}
if (!tableCols('users').includes('failed_attempts')) {
  db.exec('ALTER TABLE users ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0');
}
if (!tableCols('users').includes('locked_at')) {
  db.exec('ALTER TABLE users ADD COLUMN locked_at TEXT');
}

// ---------- password helpers (scrypt, no native deps) ----------
export function hashPassword(pw) {
  const salt = randomBytes(16);
  const dk = scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const dk = scryptSync(pw, Buffer.from(saltHex, 'hex'), 32);
  const a = Buffer.from(hashHex, 'hex');
  return a.length === dk.length && timingSafeEqual(a, dk);
}

// ---------- seed ----------
const EMPLOYEES = [
  { id: 'u_ishinov', name: 'Илья Ишинов', email: 'ishinov@erfis.ru', manager: true },
  { id: 'u_konovalova', name: 'Екатерина Коновалова', email: 'konovalova@erfis.ru' },
  { id: 'u_milyukov', name: 'Сергей Милюков', email: 'milykov@erfis.ru' },
  { id: 'u_petrov', name: 'Дмитрий Петров', email: 'petrov@erfis.ru' },
];

export function seedUsers() {
  const now = new Date().toISOString();
  const ins = db.prepare(
    'INSERT OR IGNORE INTO users (id,name,email,pass_hash,must_change,is_manager,created_at) VALUES (?,?,?,?,1,?,?)'
  );
  const created = [];
  for (const e of EMPLOYEES) {
    const exists = db.prepare('SELECT 1 FROM users WHERE id = ?').get(e.id);
    if (exists) continue;
    const pw = randomBytes(6).toString('base64url'); // 8-char temp password
    ins.run(e.id, e.name, e.email, hashPassword(pw), e.manager ? 1 : 0, now);
    created.push({ ...e, tempPassword: pw });
  }
  // роль руководителя выставляем всегда (идемпотентно) — на случай уже созданной базы
  for (const e of EMPLOYEES) {
    db.prepare('UPDATE users SET is_manager = ? WHERE id = ?').run(e.manager ? 1 : 0, e.id);
  }
  // реквизиты для QR оплаты пошлин (Роспатент, приказ 14.12.2020 №167) — если ещё не заданы
  const hasReq = db.prepare("SELECT 1 FROM meta WHERE k = 'pay_requisites'").get();
  if (!hasReq) {
    db.prepare('INSERT INTO meta (k,v) VALUES (?,?)').run('pay_requisites', JSON.stringify({
      name: 'Межрегиональное операционное УФК (Федеральная служба по интеллектуальной собственности)',
      personalAcc: '03100643000000019500',
      bankName: 'Операционный департамент Банка России//Межрегиональное операционное УФК г. Москва',
      bic: '024501901',
      correspAcc: '40102810045370000002',
      inn: '7730176088',
      kpp: '773001001',
      cbc: '16811505020016000140',
      oktmo: '45318000',
      payerStatus: '',
    }));
  }
  return created;
}

// ---------- import from Excel-derived seed.json (one-time) ----------
export function importSeedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) c FROM objects').get().c;
  if (count > 0) return { imported: 0, skipped: true };

  const seedPath = join(DATA_DIR, 'seed.json');
  if (!existsSync(seedPath)) return { imported: 0, missing: true };
  const raw = JSON.parse(readFileSync(seedPath, 'utf8'));
  const now = new Date().toISOString();

  const ins = db.prepare(`INSERT INTO objects
    (id,type,holder,name,app_number,reg_number,object_type,mktu_classes,priority_date,expiry_date,document_ref,document_url,responsible,notes,reminder,extra,created_at,updated_at)
    VALUES (@id,@type,@holder,@name,@app_number,@reg_number,@object_type,@mktu_classes,@priority_date,@expiry_date,@document_ref,@document_url,NULL,'',NULL,@extra,@now,@now)`);

  const s = (v) => (v == null ? '' : String(v).trim());
  const blank = { holder: '', name: '', app_number: '', reg_number: '', object_type: '', mktu_classes: '', priority_date: '', expiry_date: '', document_ref: '', document_url: '', extra: '{}' };
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const t of raw.trademarks || []) {
      ins.run({ ...blank, id: t.id, type: 'trademark', holder: s(t.holder), name: s(t.name),
        app_number: s(t.appNumber), reg_number: s(t.regNumber),
        mktu_classes: s(t.mktuClasses), priority_date: s(t.priorityDate), expiry_date: s(t.expiryDate),
        document_ref: s(t.certificate), now });
      n++;
    }
    for (const p of raw.patents || []) {
      ins.run({ ...blank, id: p.id, type: 'patent', holder: s(p.holder), name: s(p.name),
        app_number: s(p.appNumber), reg_number: s(p.patentNumber), object_type: s(p.objectType),
        priority_date: s(p.priorityDate), expiry_date: s(p.expiryDate), document_ref: s(p.patentFile), now });
      n++;
    }
    for (const w of raw.software || []) {
      ins.run({ ...blank, id: w.id, type: 'software', holder: s(w.holder), name: s(w.name),
        reg_number: s(w.regNumber),
        extra: JSON.stringify({ intNo: s(w.intNo), contactPerson: s(w.contactPerson), email: s(w.email), registry: s(w.registry), actWhen: s(w.actWhen) }),
        now });
      n++;
    }
    for (const sh of raw.shipments || []) {
      ins.run({ ...blank, id: sh.id, type: 'shipment', name: s(sh.docType),
        reg_number: s(sh.objectNumber), app_number: s(sh.caseNumber), priority_date: s(sh.date), now });
      n++;
    }
    for (const ct of raw.contracts || []) {
      ins.run({ ...blank, id: ct.id, type: 'contract', holder: s(ct.contragent),
        name: s(ct.workDesc) || 'оказание услуг',
        reg_number: s(ct.contractNo), priority_date: s(ct.contractDate),
        extra: JSON.stringify({ contractKind: s(ct.kind) }), now });
      n++;
    }
    for (const ct of (raw.contracts || []).filter((x) => x.note)) {
      db.prepare('UPDATE objects SET notes = ? WHERE id = ?').run(s(ct.note), ct.id);
    }
    // прайс-лист
    const priceFile = join(DATA_DIR, 'price-seed.json');
    if (existsSync(priceFile)) {
      const items = JSON.parse(readFileSync(priceFile, 'utf8'));
      const pins = db.prepare('INSERT INTO price_items (category,name,fee,duty,total,note,sort) VALUES (?,?,?,?,?,?,?)');
      items.forEach((it, i) => pins.run(it.category || '', it.name || '', it.fee || '', it.duty || '', it.total || '', it.note || '', i));
    }
    db.prepare('INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)').run('imported_at', now);
    db.prepare('INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)').run('import_source', raw.meta?.source || 'seed.json');
    db.prepare(
      'INSERT INTO activity (at,kind,object_id,object_type,text,user_id) VALUES (?,?,?,?,?,?)'
    ).run(now, 'import', null, null, `Импорт данных — ${n} объектов`, null);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { imported: n };
}

export { EMPLOYEES };
