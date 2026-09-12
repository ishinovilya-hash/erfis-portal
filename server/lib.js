// Small helpers — no external deps.

export const DAY = 86400000;
export const SOON_DAYS = 183; // «истекает», если до конца срока <= полугода

export function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Cache-Control': 'no-store',
  });
  res.end(s);
}

export function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

export function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

export function readRawBody(req, limit = 10_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setCookie(res, name, value, { maxAge, secure = true } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) bits.push('Secure');
  if (maxAge != null) bits.push(`Max-Age=${maxAge}`);
  appendHeader(res, 'Set-Cookie', bits.join('; '));
}

function appendHeader(res, key, value) {
  const prev = res.getHeader(key);
  if (!prev) res.setHeader(key, value);
  else res.setHeader(key, Array.isArray(prev) ? [...prev, value] : [prev, value]);
}

// ---------- domain logic ----------
export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function daysLeft(expiry) {
  if (!expiry || !/^\d{4}-\d{2}-\d{2}/.test(expiry)) return null;
  const e = new Date(expiry.slice(0, 10) + 'T00:00:00Z').getTime();
  if (Number.isNaN(e)) return null;
  const t = new Date(todayISO() + 'T00:00:00Z').getTime();
  return Math.round((e - t) / DAY);
}

export function statusOf(expiry) {
  const dl = daysLeft(expiry);
  if (dl === null) return { key: 'none', label: 'Без срока', daysLeft: null };
  if (dl < 0) return { key: 'expired', label: 'Истёк', daysLeft: dl };
  if (dl <= SOON_DAYS) return { key: 'expiring', label: `Истекает · ${dl} дн.`, daysLeft: dl };
  return { key: 'active', label: 'Действует', daysLeft: dl };
}

export function reminderDue(r) {
  if (!r || r.acknowledged) return false;
  return new Date(`${r.date}T${r.time || '00:00'}:00`).getTime() <= Date.now();
}

// доп. поля, хранящиеся в objects.extra (JSON)
export const EXTRA_KEYS = ['intNo', 'contactPerson', 'email', 'registry', 'actWhen',
  'contractKind', 'workDate', 'stage', 'act', 'executor'];

// DB row (snake_case) -> API object (camelCase) + computed fields
export function rowToApi(row) {
  const reminder = row.reminder ? JSON.parse(row.reminder) : null;
  let extra = {};
  try { extra = row.extra ? JSON.parse(row.extra) : {}; } catch {}
  return {
    id: row.id,
    type: row.type,
    holder: row.holder,
    name: row.name,
    appNumber: row.app_number,
    regNumber: row.reg_number,
    objectType: row.object_type || null,
    mktuClasses: row.mktu_classes,
    priorityDate: row.priority_date || null,
    expiryDate: row.expiry_date || null,
    documentRef: row.document_ref || null,
    documentUrl: row.document_url || null,
    responsible: row.responsible || null,
    notes: row.notes || '',
    reminder,
    intNo: extra.intNo || '',
    contactPerson: extra.contactPerson || '',
    email: extra.email || '',
    registry: extra.registry || '',
    actWhen: extra.actWhen || '',
    contractKind: extra.contractKind || '',
    workDate: extra.workDate || null,
    stage: extra.stage || '',
    act: extra.act || '',
    executor: extra.executor || '',
    status: statusOf(row.expiry_date),
    flagged: reminderDue(reminder),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
    deletedBy: row.deleted_by || null,
  };
}

// Editable columns: API name -> DB column
export const EDITABLE = {
  holder: 'holder',
  name: 'name',
  appNumber: 'app_number',
  regNumber: 'reg_number',
  objectType: 'object_type',
  mktuClasses: 'mktu_classes',
  priorityDate: 'priority_date',
  expiryDate: 'expiry_date',
  documentRef: 'document_ref',
  documentUrl: 'document_url',
  responsible: 'responsible',
  notes: 'notes',
};

export const FIELD_LABELS = {
  holder: 'правообладатель',
  name: 'название',
  appNumber: '№ заявки',
  regNumber: '№ регистрации/патента',
  objectType: 'вид объекта',
  mktuClasses: 'классы МКТУ',
  priorityDate: 'дата приоритета / отправки',
  expiryDate: 'срок действия',
  documentRef: 'документ',
  documentUrl: 'ссылка на документ',
  responsible: 'ответственный',
  notes: 'примечание',
  intNo: 'внутренний №',
  contactPerson: 'контактное лицо',
  email: 'e-mail',
  registry: 'реестр',
  actWhen: 'когда обратиться',
  workDate: 'дата ТЗ',
  stage: 'стадия',
  act: 'акт',
  executor: 'исполнитель',
  contractKind: 'тип договора',
};

export function initialsOf(name) {
  return (name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}
