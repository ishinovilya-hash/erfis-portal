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
`);

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
  { id: 'u_ishinov', name: 'Илья Ишинов', email: 'ishinov@erfis.ru' },
  { id: 'u_konovalova', name: 'Екатерина Коновалова', email: 'konovalova@erfis.ru' },
  { id: 'u_milyukov', name: 'Сергей Милюков', email: 'milykov@erfis.ru' },
  { id: 'u_petrov', name: 'Дмитрий Петров', email: 'petrov@erfis.ru' },
];

export function seedUsers() {
  const now = new Date().toISOString();
  const ins = db.prepare(
    'INSERT OR IGNORE INTO users (id,name,email,pass_hash,must_change,created_at) VALUES (?,?,?,?,1,?)'
  );
  const created = [];
  for (const e of EMPLOYEES) {
    const exists = db.prepare('SELECT 1 FROM users WHERE id = ?').get(e.id);
    if (exists) continue;
    const pw = randomBytes(6).toString('base64url'); // 8-char temp password
    ins.run(e.id, e.name, e.email, hashPassword(pw), now);
    created.push({ ...e, tempPassword: pw });
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
    (id,type,holder,name,app_number,reg_number,object_type,mktu_classes,priority_date,expiry_date,document_ref,document_url,responsible,notes,reminder,created_at,updated_at)
    VALUES (@id,@type,@holder,@name,@app_number,@reg_number,@object_type,@mktu_classes,@priority_date,@expiry_date,@document_ref,@document_url,NULL,'',NULL,@now,@now)`);

  const s = (v) => (v == null ? '' : String(v).trim());
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const t of raw.trademarks || []) {
      ins.run({
        id: t.id, type: 'trademark', holder: s(t.holder), name: s(t.name),
        app_number: s(t.appNumber), reg_number: s(t.regNumber), object_type: '',
        mktu_classes: s(t.mktuClasses), priority_date: s(t.priorityDate), expiry_date: s(t.expiryDate),
        document_ref: s(t.certificate), document_url: '', now,
      });
      n++;
    }
    for (const p of raw.patents || []) {
      ins.run({
        id: p.id, type: 'patent', holder: s(p.holder), name: s(p.name),
        app_number: s(p.appNumber), reg_number: s(p.patentNumber), object_type: s(p.objectType),
        mktu_classes: '', priority_date: s(p.priorityDate), expiry_date: s(p.expiryDate),
        document_ref: s(p.patentFile), document_url: '', now,
      });
      n++;
    }
    db.prepare('INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)').run('imported_at', now);
    db.prepare('INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)').run('import_source', raw.meta?.source || 'seed.json');
    db.prepare(
      'INSERT INTO activity (at,kind,object_id,object_type,text,user_id) VALUES (?,?,?,?,?,?)'
    ).run(now, 'import', null, null, `Импорт из «${raw.meta?.source || 'seed.json'}» — ${n} объектов`, null);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { imported: n };
}

export { EMPLOYEES };
