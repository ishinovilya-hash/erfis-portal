import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { db, seedUsers, importSeedIfEmpty, EMPLOYEES, hashPassword, verifyPassword } from './db.js';
import {
  json, text, readBody, parseCookies, setCookie, todayISO,
  rowToApi, EDITABLE, EXTRA_KEYS, FIELD_LABELS, initialsOf,
} from './lib.js';

const OBJECT_TYPES = ['trademark', 'patent', 'software', 'shipment'];

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8080);
const INSECURE = process.env.INSECURE_COOKIES === '1';
const DEPLOY_KEY = process.env.DEPLOY_KEY || '';
const VERSION = '0.2.0';

// ---------- startup ----------
const created = seedUsers();
if (created.length) {
  console.log('\n=== Созданы учётные записи (временные пароли) ===');
  for (const u of created) console.log(`  ${u.email}  →  ${u.tempPassword}`);
  console.log('=== Пароли также в файле data/initial-passwords.txt ===\n');
  try {
    const line = created.map((u) => `${u.email}\t${u.tempPassword}`).join('\n') + '\n';
    writeFileSync(join(__dirname, 'data', 'initial-passwords.txt'), line);
  } catch {}
}
const imp = importSeedIfEmpty();
console.log('Импорт данных:', JSON.stringify(imp));

// ---------- auth ----------
function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.id,u.name,u.email,u.must_change,u.is_manager FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
  ).get(token);
  if (!row) return null;
  db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?').run(new Date().toISOString(), token);
  return row;
}
const isManager = (u) => !!(u && u.is_manager);

function logActivity(kind, obj, txt, userId) {
  db.prepare(
    'INSERT INTO activity (at,kind,object_id,object_type,text,user_id) VALUES (?,?,?,?,?,?)'
  ).run(new Date().toISOString(), kind, obj?.id || null, obj?.type || null, txt, userId || null);
}

function usersPublic() {
  return EMPLOYEES.map((e) => ({ id: e.id, name: e.name, email: e.email, initials: initialsOf(e.name) }));
}

// ---------- object helpers ----------
const getObj = (id) => db.prepare('SELECT * FROM objects WHERE id = ?').get(id);

function touch(id) {
  db.prepare('UPDATE objects SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

// ---------- router ----------
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const rx = new RegExp(
    '^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$'
  );
  routes.push({ method, rx, keys, handler });
};

// ---- session ----
route('POST', '/api/login', async (req, res) => {
  const { email, password } = await readBody(req);
  const u = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(String(email || '').trim());
  if (!u || !verifyPassword(String(password || ''), u.pass_hash)) {
    return json(res, 401, { error: 'Неверный email или пароль' });
  }
  const token = randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  db.prepare('INSERT INTO sessions (token,user_id,created_at,last_seen) VALUES (?,?,?,?)').run(token, u.id, now, now);
  setCookie(res, 'sid', token, { maxAge: 60 * 60 * 24 * 30, secure: !INSECURE });
  logActivity('login', null, 'Вход в портал', u.id);
  json(res, 200, { user: { id: u.id, name: u.name, email: u.email, mustChange: !!u.must_change } });
});

route('POST', '/api/logout', async (req, res) => {
  const token = parseCookies(req).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  setCookie(res, 'sid', '', { maxAge: 0, secure: !INSECURE });
  json(res, 200, { ok: true });
});

route('GET', '/api/session', async (req, res) => {
  const u = currentUser(req);
  if (!u) return json(res, 401, { error: 'not authenticated' });
  json(res, 200, { user: { id: u.id, name: u.name, email: u.email, mustChange: !!u.must_change, isManager: isManager(u) }, users: usersPublic() });
});

route('POST', '/api/password', async (req, res) => {
  const u = currentUser(req);
  if (!u) return json(res, 401, { error: 'not authenticated' });
  const { current, next } = await readBody(req);
  const row = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(u.id);
  if (!verifyPassword(String(current || ''), row.pass_hash)) return json(res, 400, { error: 'Текущий пароль неверен' });
  if (String(next || '').length < 8) return json(res, 400, { error: 'Новый пароль — минимум 8 символов' });
  db.prepare('UPDATE users SET pass_hash = ?, must_change = 0 WHERE id = ?').run(hashPassword(String(next)), u.id);
  logActivity('password', null, 'Смена пароля', u.id);
  json(res, 200, { ok: true });
});

// ---- registry ----
const TYPE_PREFIX = { trademark: 'tm', patent: 'pt', software: 'sw', shipment: 'sh' };

route('GET', '/api/objects', async (req, res, _p, url) => {
  const u = currentUser(req);
  if (!u) return json(res, 401, { error: 'auth' });
  const type = url.searchParams.get('type');
  if (!OBJECT_TYPES.includes(type)) return json(res, 400, { error: 'type' });
  const order = type === 'shipment' ? 'priority_date DESC, id DESC' : 'holder, name';
  const rows = db.prepare(`SELECT * FROM objects WHERE type = ? AND deleted_at IS NULL ORDER BY ${order}`).all(type);
  json(res, 200, { objects: rows.map(rowToApi) });
});

function extraFrom(b, base = {}) {
  const e = { ...base };
  for (const k of EXTRA_KEYS) if (k in b) e[k] = String(b[k] ?? '').trim();
  return e;
}

route('POST', '/api/objects', async (req, res) => {
  const u = currentUser(req);
  if (!u) return json(res, 401, { error: 'auth' });
  const b = await readBody(req);
  if (!OBJECT_TYPES.includes(b.type)) return json(res, 400, { error: 'type' });
  if (!String(b.name || '').trim()) return json(res, 400, { error: 'Заполните название' });
  if ((b.type === 'trademark' || b.type === 'patent') && !String(b.holder || '').trim())
    return json(res, 400, { error: 'Заполните правообладателя' });
  const id = `${TYPE_PREFIX[b.type]}-n${randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString();
  const vals = { id, type: b.type, created_at: now, updated_at: now, extra: JSON.stringify(extraFrom(b)) };
  for (const [api, col] of Object.entries(EDITABLE)) vals[col] = api === 'responsible' ? (b[api] || null) : String(b[api] ?? '').trim();
  db.prepare(`INSERT INTO objects
    (id,type,holder,name,app_number,reg_number,object_type,mktu_classes,priority_date,expiry_date,document_ref,document_url,responsible,notes,extra,created_at,updated_at)
    VALUES (@id,@type,@holder,@name,@app_number,@reg_number,@object_type,@mktu_classes,@priority_date,@expiry_date,@document_ref,@document_url,@responsible,@notes,@extra,@created_at,@updated_at)`).run(vals);
  logActivity('create', { id, type: b.type }, `Создан объект «${b.name}»`, u.id);
  json(res, 200, { object: rowToApi(getObj(id)) });
});

route('GET', '/api/objects/:id', async (req, res, p) => {
  const u = currentUser(req);
  if (!u) return json(res, 401, { error: 'auth' });
  const row = getObj(p.id);
  if (!row) return json(res, 404, { error: 'not found' });
  json(res, 200, { object: rowToApi(row), activity: objectActivity(p.id) });
});

route('PATCH', '/api/objects/:id', async (req, res, p) => {
  const u = currentUser(req);
  if (!u) return json(res, 401, { error: 'auth' });
  const row = getObj(p.id);
  if (!row || row.deleted_at) return json(res, 404, { error: 'not found' });
  const b = await readBody(req);
  const changed = [];
  const sets = [];
  const args = {};
  for (const [api, col] of Object.entries(EDITABLE)) {
    if (!(api in b)) continue;
    const next = api === 'responsible' ? (b[api] || null) : String(b[api] ?? '').trim();
    if (String(row[col] ?? '') === String(next ?? '')) continue;
    sets.push(`${col} = @${col}`);
    args[col] = next;
    changed.push(FIELD_LABELS[api] || api);
  }
  // доп. поля (extra JSON)
  let curExtra = {};
  try { curExtra = row.extra ? JSON.parse(row.extra) : {}; } catch {}
  let extraChanged = false;
  for (const k of EXTRA_KEYS) {
    if (!(k in b)) continue;
    const next = String(b[k] ?? '').trim();
    if (String(curExtra[k] ?? '') === next) continue;
    curExtra[k] = next; extraChanged = true;
    changed.push(FIELD_LABELS[k] || k);
  }
  if (extraChanged) { sets.push('extra = @extra'); args.extra = JSON.stringify(curExtra); }
  if (!sets.length) return json(res, 200, { object: rowToApi(row), unchanged: true });
  args.id = p.id;
  args.updated_at = new Date().toISOString();
  db.prepare(`UPDATE objects SET ${sets.join(', ')}, updated_at = @updated_at WHERE id = @id`).run(args);
  logActivity('edit', row, `Изменён объект «${row.name}» (${changed.join(', ')})`, u.id);
  json(res, 200, { object: rowToApi(getObj(p.id)) });
});

route('DELETE', '/api/objects/:id', async (req, res, p) => {
  const u = currentUser(req);
  if (!u) return json(res, 401, { error: 'auth' });
  const row = getObj(p.id);
  if (!row || row.deleted_at) return json(res, 404, { error: 'not found' });
  db.prepare('UPDATE objects SET deleted_at = ?, deleted_by = ? WHERE id = ?')
    .run(new Date().toISOString(), u.id, p.id);
  logActivity('delete', row, `Удалён объект «${row.name}» → корзина`, u.id);
  json(res, 200, { ok: true });
});

// ---- reminders ----
route('POST', '/api/objects/:id/reminder', async (req, res, p) => {
  const u = currentUser(req);
  if (!u) return json(res, 401, { error: 'auth' });
  const row = getObj(p.id);
  if (!row || row.deleted_at) return json(res, 404, { error: 'not found' });
  const { date, time, note } = await readBody(req);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return json(res, 400, { error: 'Укажите дату' });
  const reminder = {
    date, time: time || '10:00', note: String(note || '').trim(),
    createdBy: u.id, createdAt: new Date().toISOString(), acknowledged: false,
  };
  db.prepare('UPDATE objects SET reminder = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(reminder), new Date().toISOString(), p.id);
  logActivity('reminder_set', row, `Напоминание о продлении «${row.name}» на ${fmtDate(date)} ${reminder.time}`, u.id);
  json(res, 200, { object: rowToApi(getObj(p.id)) });
});

route('POST', '/api/objects/:id/reminder/ack', async (req, res, p) => {
  const u = currentUser(req);
  if (!u) return json(res, 401, { error: 'auth' });
  const row = getObj(p.id);
  if (!row || !row.reminder) return json(res, 404, { error: 'not found' });
  const r = JSON.parse(row.reminder);
  r.acknowledged = true; r.ackBy = u.id; r.ackAt = new Date().toISOString();
  db.prepare('UPDATE objects SET reminder = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(r), new Date().toISOString(), p.id);
  logActivity('reminder_ok', row, `Напоминание по «${row.name}» закрыто — «всё в порядке»`, u.id);
  json(res, 200, { object: rowToApi(getObj(p.id)) });
});

route('DELETE', '/api/objects/:id/reminder', async (req, res, p) => {
  const u = currentUser(req);
  if (!u) return json(res, 401, { error: 'auth' });
  const row = getObj(p.id);
  if (!row) return json(res, 404, { error: 'not found' });
  db.prepare('UPDATE objects SET reminder = NULL, updated_at = ? WHERE id = ?').run(new Date().toISOString(), p.id);
  logActivity('reminder_del', row, `Снято напоминание по «${row.name}»`, u.id);
  json(res, 200, { object: rowToApi(getObj(p.id)) });
});

route('GET', '/api/reminders', async (req, res) => {
  const u = currentUser(req);
  if (!u) return json(res, 401, { error: 'auth' });
  const rows = db.prepare("SELECT * FROM objects WHERE reminder IS NOT NULL AND deleted_at IS NULL").all();
  const items = rows.map(rowToApi).filter((o) => o.reminder && !o.reminder.acknowledged);
  items.sort((a, b) => (a.reminder.date + a.reminder.time).localeCompare(b.reminder.date + b.reminder.time));
  json(res, 200, { reminders: items });
});

// ---- trash ----
route('GET', '/api/trash', async (req, res) => {
  const u = currentUser(req);
  if (!u) return json(res, 401, { error: 'auth' });
  const rows = db.prepare('SELECT * FROM objects WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all();
  json(res, 200, { trash: rows.map(rowToApi) });
});

route('POST', '/api/trash/:id/restore', async (req, res, p) => {
  const u = currentUser(req);
  if (!u) return json(res, 401, { error: 'auth' });
  const row = getObj(p.id);
  if (!row || !row.deleted_at) return json(res, 404, { error: 'not found' });
  db.prepare('UPDATE objects SET deleted_at = NULL, deleted_by = NULL, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString(), p.id);
  logActivity('restore', row, `Восстановлен объект «${row.name}» из корзины`, u.id);
  json(res, 200, { ok: true });
});

route('DELETE', '/api/trash/:id', async (req, res, p) => {
  const u = currentUser(req);
  if (!u) return json(res, 401, { error: 'auth' });
  const row = getObj(p.id);
  if (!row || !row.deleted_at) return json(res, 404, { error: 'not found' });
  db.prepare('DELETE FROM objects WHERE id = ?').run(p.id);
  logActivity('purge', { id: p.id, type: row.type }, `Объект «${row.name}» удалён навсегда`, u.id);
  json(res, 200, { ok: true });
});

// ---- activity ----
function objectActivity(id) {
  return db.prepare('SELECT * FROM activity WHERE object_id = ? ORDER BY id DESC LIMIT 30').all(id).map(actToApi);
}
const actToApi = (a) => ({ id: a.id, at: a.at, kind: a.kind, text: a.text, userId: a.user_id, objectId: a.object_id, objectType: a.object_type });

route('GET', '/api/activity', async (req, res, _p, url) => {
  const u = currentUser(req);
  if (!u) return json(res, 401, { error: 'auth' });
  const limit = Math.min(Number(url.searchParams.get('limit') || 300), 1000);
  const rows = db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(limit);
  json(res, 200, { activity: rows.map(actToApi) });
});

// ---- export ----
route('GET', '/api/export', async (req, res, _p, url) => {
  const u = currentUser(req);
  if (!u) return text(res, 401, 'auth');
  const type = url.searchParams.get('type');
  if (!OBJECT_TYPES.includes(type)) return text(res, 400, 'type');
  const order = type === 'shipment' ? 'priority_date DESC, id DESC' : 'holder, name';
  const rows = db.prepare(`SELECT * FROM objects WHERE type = ? AND deleted_at IS NULL ORDER BY ${order}`).all(type).map(rowToApi);
  const COLS = {
    trademark: [['holder', 'Правообладатель'], ['appNumber', '№ заявки'], ['name', 'Название'], ['regNumber', '№ регистрации'], ['mktuClasses', 'Классы МКТУ'], ['priorityDate', 'Приоритет'], ['expiryDate', 'Действует до'], ['status', 'Статус'], ['responsible', 'Ответственный']],
    patent: [['holder', 'Правообладатель'], ['objectType', 'Вид'], ['name', 'Название'], ['appNumber', '№ заявки'], ['regNumber', '№ патента'], ['priorityDate', 'Приоритет'], ['expiryDate', 'Действует до'], ['status', 'Статус'], ['responsible', 'Ответственный']],
    software: [['intNo', 'Вн. №'], ['name', 'Название'], ['regNumber', '№ регистрации'], ['holder', 'Правообладатель'], ['contactPerson', 'Контактное лицо'], ['email', 'E-mail'], ['registry', 'Реестр'], ['actWhen', 'Когда обратиться'], ['responsible', 'Ответственный']],
    shipment: [['priorityDate', 'Дата'], ['name', 'Вид документа'], ['regNumber', '№ объекта'], ['appNumber', '№ делопроизводства'], ['responsible', 'Ответственный']],
  };
  const cols = COLS[type];
  const nameOf = (id) => EMPLOYEES.find((e) => e.id === id)?.name || '';
  const cell = (o, k) => k === 'status' ? o.status.label : k === 'responsible' ? nameOf(o.responsible) : (o[k] ?? '');
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = '﻿' + [cols.map((c) => esc(c[1])).join(';'), ...rows.map((o) => cols.map((c) => esc(cell(o, c[0]))).join(';'))].join('\r\n');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="erfis-${type}-${todayISO()}.csv"`,
  });
  res.end(csv);
});

// ---- трекер настроения команды ----
const MOOD_FACTORS = ['переработки','сжатые сроки','неясные задачи','много контекста/переключений','конфликт или сложное общение','нет перерывов/отдыха','монотонность','внешние обстоятельства','личное'];
const localDate = () => {
  // дата в МСК (UTC+3), чтобы «сегодня» совпадало с рабочим днём в РФ
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
};
const daysAgoDate = (n) => new Date(Date.now() + 3 * 3600 * 1000 - n * 86400000).toISOString().slice(0, 10);

function moodEntryApi(r) {
  return r ? { date: r.date, mood: r.mood, workload: r.workload, worked: !!r.worked, note: r.note, factors: safeArr(r.factors) } : null;
}
const safeArr = (s) => { try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; } };

function userSignal(userId) {
  const rows = db.prepare(
    "SELECT date, mood, workload, worked FROM mood_entries WHERE user_id = ? AND date >= ? ORDER BY date DESC"
  ).all(userId, daysAgoDate(28));
  const worked = rows.filter((r) => r.worked && r.mood != null);
  const reasons = [];
  let lowStreak = 0;
  for (const r of worked) { if (r.mood <= 2) lowStreak++; else break; }
  if (lowStreak >= 3) reasons.push(`${lowStreak} тяжёлых дня подряд`);
  let overload = 0;
  for (const r of worked.filter((x) => x.worked)) { if (r.workload === 'high') overload++; else break; }
  if (overload >= 4) reasons.push(`${overload} дня подряд «завал»`);
  const avg = (arr) => arr.length ? arr.reduce((s, x) => s + x.mood, 0) / arr.length : null;
  const a7 = avg(worked.slice(0, 7)), p7 = avg(worked.slice(7, 14));
  if (a7 != null && p7 != null && worked.length >= 10 && a7 - p7 <= -1.3) reasons.push('заметный спад за неделю');
  return { flag: reasons.length > 0, reasons };
}

route('GET', '/api/mood/today', async (req, res) => {
  const u = currentUser(req); if (!u) return json(res, 401, { error: 'auth' });
  const today = localDate();
  const mine = db.prepare('SELECT * FROM mood_entries WHERE user_id = ? AND date = ?').get(u.id, today);
  json(res, 200, { date: today, entry: moodEntryApi(mine), factors: MOOD_FACTORS });
});

route('POST', '/api/mood', async (req, res) => {
  const u = currentUser(req); if (!u) return json(res, 401, { error: 'auth' });
  const b = await readBody(req);
  const today = localDate();
  const worked = b.worked === false ? 0 : 1;
  let mood = worked ? Number(b.mood) : null;
  if (worked && !(mood >= 1 && mood <= 5)) return json(res, 400, { error: 'Оцените день от 1 до 5' });
  const workload = ['low', 'ok', 'high'].includes(b.workload) ? b.workload : 'ok';
  const factors = JSON.stringify((Array.isArray(b.factors) ? b.factors : []).filter((x) => MOOD_FACTORS.includes(x)).slice(0, 9));
  const note = String(b.note || '').trim().slice(0, 400);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO mood_entries (user_id,date,mood,workload,worked,note,factors,created_at,updated_at)
    VALUES (@u,@d,@m,@w,@k,@n,@f,@now,@now)
    ON CONFLICT(user_id,date) DO UPDATE SET mood=@m, workload=@w, worked=@k, note=@n, factors=@f, updated_at=@now`)
    .run({ u: u.id, d: today, m: mood, w: workload, k: worked, n: note, f: factors, now });
  json(res, 200, { ok: true, entry: moodEntryApi(db.prepare('SELECT * FROM mood_entries WHERE user_id=? AND date=?').get(u.id, today)) });
});

route('GET', '/api/mood/mine', async (req, res, _p, url) => {
  const u = currentUser(req); if (!u) return json(res, 401, { error: 'auth' });
  if (!isManager(u)) return json(res, 403, { error: 'forbidden' });
  const days = Math.min(Number(url.searchParams.get('days') || 60), 365);
  const rows = db.prepare('SELECT * FROM mood_entries WHERE user_id = ? AND date >= ? ORDER BY date').all(u.id, daysAgoDate(days));
  json(res, 200, { entries: rows.map(moodEntryApi) });
});

route('GET', '/api/mood/team', async (req, res, _p, url) => {
  const u = currentUser(req); if (!u) return json(res, 401, { error: 'auth' });
  if (!isManager(u)) return json(res, 403, { error: 'Раздел доступен только руководителю' });
  const days = Math.min(Number(url.searchParams.get('days') || 30), 180);
  const since = daysAgoDate(days - 1);
  const today = localDate();
  const all = db.prepare('SELECT * FROM mood_entries WHERE date >= ? ORDER BY date').all(since);

  // ряд: средняя по команде за день (только рабочие дни с оценкой)
  const byDate = {};
  for (const r of all) {
    if (!r.worked || r.mood == null) continue;
    (byDate[r.date] ||= []).push(r.mood);
  }
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = daysAgoDate(i);
    const arr = byDate[d] || [];
    series.push({ date: d, avg: arr.length ? +(arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(2) : null, count: arr.length });
  }

  const members = EMPLOYEES.map((e) => {
    const rows = all.filter((r) => r.user_id === e.id);
    const todayRow = rows.find((r) => r.date === today);
    const recent = [];
    for (let i = 13; i >= 0; i--) {
      const d = daysAgoDate(i);
      const row = rows.find((r) => r.date === d);
      recent.push(row ? { date: d, mood: row.mood, worked: !!row.worked } : { date: d, mood: null, worked: null });
    }
    const worked7 = rows.filter((r) => r.worked && r.mood != null && r.date >= daysAgoDate(6));
    const avg7 = worked7.length ? +(worked7.reduce((s, x) => s + x.mood, 0) / worked7.length).toFixed(1) : null;
    return {
      userId: e.id, name: e.name, initials: initialsOf(e.name),
      todayDone: !!todayRow,
      today: todayRow ? { mood: todayRow.mood, workload: todayRow.workload, worked: !!todayRow.worked } : null,
      avg7, recent, signal: userSignal(e.id),
    };
  });

  const done = members.filter((m) => m.todayDone).length;
  json(res, 200, {
    days, series, members,
    participationToday: { done, total: EMPLOYEES.length },
    teamAvg7: (() => {
      const w = all.filter((r) => r.worked && r.mood != null && r.date >= daysAgoDate(6));
      return w.length ? +(w.reduce((s, x) => s + x.mood, 0) / w.length).toFixed(2) : null;
    })(),
  });
});

route('GET', '/api/mood/export', async (req, res) => {
  const u = currentUser(req); if (!u) return text(res, 401, 'auth');
  if (!isManager(u)) return text(res, 403, 'forbidden');
  const rows = db.prepare('SELECT * FROM mood_entries ORDER BY date, user_id').all();
  const WL = { low: 'недогруз', ok: 'в норме', high: 'завал' };
  const nameOf = (id) => EMPLOYEES.find((e) => e.id === id)?.name || id;
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Дата', 'Сотрудник', 'Работал', 'Оценка дня (1-5)', 'Загрузка', 'Факторы', 'Комментарий'];
  const lines = rows.map((r) => [r.date, nameOf(r.user_id), r.worked ? 'да' : 'нет', r.mood ?? '', WL[r.workload] || r.workload, safeArr(r.factors).join('; '), r.note].map(esc).join(';'));
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="erfis-mood-${todayISO()}.csv"` });
  res.end('﻿' + [head.map(esc).join(';'), ...lines].join('\r\n'));
});

// ---- QR для оплаты пошлин ----
const getRequisites = () => {
  try { return JSON.parse(db.prepare("SELECT v FROM meta WHERE k='pay_requisites'").get().v); }
  catch { return {}; }
};

route('GET', '/api/payments/requisites', async (req, res) => {
  const u = currentUser(req); if (!u) return json(res, 401, { error: 'auth' });
  json(res, 200, { requisites: getRequisites() });
});

route('PUT', '/api/payments/requisites', async (req, res) => {
  const u = currentUser(req); if (!u) return json(res, 401, { error: 'auth' });
  const b = await readBody(req);
  const keys = ['name', 'personalAcc', 'bankName', 'bic', 'correspAcc', 'inn', 'kpp', 'cbc', 'oktmo', 'payerStatus'];
  const cur = getRequisites();
  for (const k of keys) if (k in b) cur[k] = String(b[k] ?? '').trim();
  db.prepare('INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)').run('pay_requisites', JSON.stringify(cur));
  logActivity('requisites', null, 'Изменены реквизиты для оплаты пошлин', u.id);
  json(res, 200, { requisites: cur });
});

route('GET', '/api/payments', async (req, res) => {
  const u = currentUser(req); if (!u) return json(res, 401, { error: 'auth' });
  const rows = db.prepare('SELECT * FROM payments ORDER BY id DESC LIMIT 200').all();
  json(res, 200, { payments: rows.map((r) => ({
    id: r.id, amount: r.amount_kopecks / 100, purpose: r.purpose, payer: r.payer, uin: r.uin,
    qrString: r.qr_string, createdBy: r.created_by, createdAt: r.created_at,
  })) });
});

route('POST', '/api/payments', async (req, res) => {
  const u = currentUser(req); if (!u) return json(res, 401, { error: 'auth' });
  const b = await readBody(req);
  const kop = Math.round(Number(b.amount) * 100);
  if (!(kop > 0)) return json(res, 400, { error: 'Укажите сумму больше нуля' });
  const purpose = String(b.purpose || '').trim();
  if (!purpose) return json(res, 400, { error: 'Укажите назначение платежа' });
  const now = new Date().toISOString();
  const r = db.prepare(`INSERT INTO payments (amount_kopecks,purpose,payer,uin,qr_string,created_by,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(kop, purpose, String(b.payer || '').trim(), String(b.uin || '').trim(), String(b.qrString || ''), u.id, now);
  logActivity('payment_qr', null, `Сформирован QR на оплату пошлины: ${(kop / 100).toLocaleString('ru-RU')} ₽`, u.id);
  json(res, 200, { id: r.lastInsertRowid });
});

route('DELETE', '/api/payments/:id', async (req, res, p) => {
  const u = currentUser(req); if (!u) return json(res, 401, { error: 'auth' });
  db.prepare('DELETE FROM payments WHERE id = ?').run(Number(p.id));
  json(res, 200, { ok: true });
});

// ---- прайс ЭРФИС ----
const priceApi = (r) => ({ id: r.id, category: r.category, name: r.name, fee: r.fee, duty: r.duty, total: r.total, note: r.note, updatedAt: r.updated_at, updatedBy: r.updated_by });

route('GET', '/api/price', async (req, res) => {
  const u = currentUser(req); if (!u) return json(res, 401, { error: 'auth' });
  const rows = db.prepare('SELECT * FROM price_items ORDER BY sort, id').all();
  json(res, 200, { items: rows.map(priceApi) });
});

route('PATCH', '/api/price/:id', async (req, res, p) => {
  const u = currentUser(req); if (!u) return json(res, 401, { error: 'auth' });
  const row = db.prepare('SELECT * FROM price_items WHERE id = ?').get(Number(p.id));
  if (!row) return json(res, 404, { error: 'not found' });
  const b = await readBody(req);
  const F = ['category', 'name', 'fee', 'duty', 'total', 'note'];
  const sets = [], args = { id: row.id, now: new Date().toISOString(), by: u.id };
  for (const k of F) if (k in b && String(b[k] ?? '') !== String(row[k] ?? '')) { sets.push(`${k} = @${k}`); args[k] = String(b[k] ?? ''); }
  if (!sets.length) return json(res, 200, { item: priceApi(row), unchanged: true });
  db.prepare(`UPDATE price_items SET ${sets.join(', ')}, updated_at = @now, updated_by = @by WHERE id = @id`).run(args);
  logActivity('price', null, `Изменена цена: «${row.name.slice(0, 60)}»`, u.id);
  json(res, 200, { item: priceApi(db.prepare('SELECT * FROM price_items WHERE id = ?').get(row.id)) });
});

route('POST', '/api/price', async (req, res) => {
  const u = currentUser(req); if (!u) return json(res, 401, { error: 'auth' });
  const b = await readBody(req);
  if (!String(b.name || '').trim()) return json(res, 400, { error: 'Укажите наименование работы' });
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort),0) s FROM price_items').get().s;
  const r = db.prepare('INSERT INTO price_items (category,name,fee,duty,total,note,sort,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(String(b.category || '').trim(), String(b.name).trim(), String(b.fee || '').trim(), String(b.duty || '').trim(), String(b.total || '').trim(), String(b.note || '').trim(), maxSort + 1, new Date().toISOString(), u.id);
  logActivity('price', null, `Добавлена услуга в прайс: «${String(b.name).slice(0, 60)}»`, u.id);
  json(res, 200, { id: r.lastInsertRowid });
});

route('DELETE', '/api/price/:id', async (req, res, p) => {
  const u = currentUser(req); if (!u) return json(res, 401, { error: 'auth' });
  const row = db.prepare('SELECT name FROM price_items WHERE id = ?').get(Number(p.id));
  db.prepare('DELETE FROM price_items WHERE id = ?').run(Number(p.id));
  if (row) logActivity('price', null, `Удалена услуга из прайса: «${row.name.slice(0, 60)}»`, u.id);
  json(res, 200, { ok: true });
});

route('GET', '/api/price/export', async (req, res) => {
  const u = currentUser(req); if (!u) return text(res, 401, 'auth');
  const rows = db.prepare('SELECT * FROM price_items ORDER BY sort, id').all();
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Категория', 'Наименование работы', 'Гонорар (руб.)', 'Пошлина (руб.)', 'Всего (руб.)', 'Примечание'];
  const csv = '﻿' + [head.map(esc).join(';'), ...rows.map((r) => [r.category, r.name, r.fee, r.duty, r.total, r.note].map(esc).join(';'))].join('\r\n');
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="erfis-price-${todayISO()}.csv"` });
  res.end(csv);
});

// ---- health / admin ----
route('GET', '/api/health', async (_req, res) => {
  const c = (q) => db.prepare(q).get().c;
  let tunnelUrl = null;
  try { tunnelUrl = (await readFile(join(process.env.ERFIS_DATA_DIR || __dirname, 'tunnel-url'), 'utf8')).trim() || null; } catch {}
  json(res, 200, {
    ok: true, version: VERSION, tunnelUrl,
    trademarks: c("SELECT COUNT(*) c FROM objects WHERE type='trademark' AND deleted_at IS NULL"),
    patents: c("SELECT COUNT(*) c FROM objects WHERE type='patent' AND deleted_at IS NULL"),
    software: c("SELECT COUNT(*) c FROM objects WHERE type='software' AND deleted_at IS NULL"),
    shipments: c("SELECT COUNT(*) c FROM objects WHERE type='shipment' AND deleted_at IS NULL"),
    price: c('SELECT COUNT(*) c FROM price_items'),
    trash: c('SELECT COUNT(*) c FROM objects WHERE deleted_at IS NOT NULL'),
    activity: c('SELECT COUNT(*) c FROM activity'),
    remindersDue: db.prepare("SELECT * FROM objects WHERE reminder IS NOT NULL AND deleted_at IS NULL").all()
      .map((r) => { try { return JSON.parse(r.reminder); } catch { return null; } })
      .filter((x) => x && !x.acknowledged && new Date(`${x.date}T${x.time || '00:00'}:00`).getTime() <= Date.now()).length,
    importedAt: db.prepare("SELECT v FROM meta WHERE k='imported_at'").get()?.v || null,
  });
});

route('POST', '/api/admin/pull', async (req, res) => {
  if (!DEPLOY_KEY || req.headers['x-deploy-key'] !== DEPLOY_KEY) return json(res, 403, { error: 'forbidden' });
  execFile('bash', ['-lc', 'cd "$(git rev-parse --show-toplevel)" && git fetch --all && git reset --hard origin/main'],
    { cwd: __dirname, timeout: 60000 }, (err, stdout, stderr) => {
      json(res, err ? 500 : 200, { stdout, stderr, error: err?.message || null, restarting: !err });
      if (!err) setTimeout(() => process.exit(0), 300); // systemd restarts us
    });
});

// Первичный импорт данных из Excel-выгрузки (seed.json) — с ноутбука, по HTTPS через туннель.
route('POST', '/api/admin/import', async (req, res) => {
  if (!DEPLOY_KEY || req.headers['x-deploy-key'] !== DEPLOY_KEY) return json(res, 403, { error: 'forbidden' });
  const existing = db.prepare('SELECT COUNT(*) c FROM objects').get().c;
  if (existing > 0 && req.headers['x-force'] !== '1') {
    return json(res, 409, { error: 'В базе уже есть объекты. Повторный импорт: заголовок X-Force: 1' });
  }
  const raw = await readBody(req, 8_000_000);
  const s = (v) => (v == null ? '' : String(v).trim());
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT OR REPLACE INTO objects
    (id,type,holder,name,app_number,reg_number,object_type,mktu_classes,priority_date,expiry_date,document_ref,document_url,responsible,notes,reminder,extra,created_at,updated_at)
    VALUES (@id,@type,@holder,@name,@app_number,@reg_number,@object_type,@mktu_classes,@priority_date,@expiry_date,@document_ref,@document_url,
      COALESCE((SELECT responsible FROM objects WHERE id=@id),NULL),
      COALESCE((SELECT notes FROM objects WHERE id=@id),''),
      (SELECT reminder FROM objects WHERE id=@id), @extra, COALESCE((SELECT created_at FROM objects WHERE id=@id),@now), @now)`);
  const D = { holder: '', name: '', app_number: '', reg_number: '', object_type: '', mktu_classes: '', priority_date: '', expiry_date: '', document_ref: '', document_url: '', extra: '{}' };
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const t of raw.trademarks || []) {
      ins.run({ ...D, id: t.id, type: 'trademark', holder: s(t.holder), name: s(t.name), app_number: s(t.appNumber),
        reg_number: s(t.regNumber), mktu_classes: s(t.mktuClasses), priority_date: s(t.priorityDate),
        expiry_date: s(t.expiryDate), document_ref: s(t.certificate), now }); n++;
    }
    for (const p of raw.patents || []) {
      ins.run({ ...D, id: p.id, type: 'patent', holder: s(p.holder), name: s(p.name), app_number: s(p.appNumber),
        reg_number: s(p.patentNumber), object_type: s(p.objectType), priority_date: s(p.priorityDate),
        expiry_date: s(p.expiryDate), document_ref: s(p.patentFile), now }); n++;
    }
    for (const w of raw.software || []) {
      ins.run({ ...D, id: w.id, type: 'software', holder: s(w.holder), name: s(w.name), reg_number: s(w.regNumber),
        extra: JSON.stringify({ intNo: s(w.intNo), contactPerson: s(w.contactPerson), email: s(w.email), registry: s(w.registry), actWhen: s(w.actWhen) }), now }); n++;
    }
    for (const sh of raw.shipments || []) {
      ins.run({ ...D, id: sh.id, type: 'shipment', name: s(sh.docType), reg_number: s(sh.objectNumber),
        app_number: s(sh.caseNumber), priority_date: s(sh.date), now }); n++;
    }
    if (Array.isArray(raw.price) && raw.price.length) {
      db.prepare('DELETE FROM price_items').run();
      const pins = db.prepare('INSERT INTO price_items (category,name,fee,duty,total,note,sort) VALUES (?,?,?,?,?,?,?)');
      raw.price.forEach((it, i) => pins.run(it.category || '', it.name || '', it.fee || '', it.duty || '', it.total || '', it.note || '', i));
    }
    db.prepare('INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)').run('imported_at', now);
    db.prepare('INSERT INTO activity (at,kind,object_id,object_type,text,user_id) VALUES (?,?,?,?,?,?)')
      .run(now, 'import', null, null, `Импорт данных — ${n} объектов`, null);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return json(res, 500, { error: e.message }); }
  json(res, 200, { imported: n });
});

route('GET', '/api/admin/logs', async (req, res) => {
  if (!DEPLOY_KEY || req.headers['x-deploy-key'] !== DEPLOY_KEY) return text(res, 403, 'forbidden');
  execFile('bash', ['-lc', 'journalctl -u erfis-portal -n 200 --no-pager 2>/dev/null || true'],
    { timeout: 15000 }, (_e, out) => text(res, 200, out || '(нет журнала)'));
});

// ---------- static ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png', '.woff2': 'font/woff2' };

async function serveStatic(req, res, pathname) {
  let rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !existsSync(file)) {
    // SPA fallback
    const html = await readFile(join(PUBLIC, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  const body = await readFile(file);
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(body);
}

// ---------- request handler ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.rx.exec(pathname);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        return await r.handler(req, res, params, url);
      }
      return json(res, 404, { error: 'not found' });
    }
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, pathname);
    json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    console.error('ERR', req.method, req.url, e);
    if (!res.headersSent) json(res, e.message === 'bad json' ? 400 : 500, { error: e.message || 'server error' });
  }
});

function fmtDate(d) {
  const p = String(d).slice(0, 10).split('-');
  return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : d;
}

// prune old sessions daily
setInterval(() => {
  db.prepare("DELETE FROM sessions WHERE last_seen < datetime('now','-45 days')").run();
}, 6 * 3600 * 1000).unref();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ЭРФИС Портал v${VERSION} — http://127.0.0.1:${PORT}`);
});
