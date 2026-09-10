/* Демо-режим портала ЭРФИС: подменяет /api/* на локальное хранилище браузера.
   Данные не уходят на сервер. Всё живёт в этом браузере (localStorage). */
(function () {
  const KEY = 'erfis_demo_v3';
  const DAY = 86400000;
  const SOON = 183;
  const nowISO = () => new Date().toISOString();
  const todayMSK = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  const dAgo = (n) => new Date(Date.now() + 3 * 3600e3 - n * DAY).toISOString().slice(0, 10);

  const USERS = [
    { id: 'u_ishinov', name: 'Илья Ишинов', email: 'ishinov@erfis.ru', initials: 'ИИ', isManager: true },
    { id: 'u_konovalova', name: 'Екатерина Коновалова', email: 'konovalova@erfis.ru', initials: 'ЕК', isManager: false },
    { id: 'u_milyukov', name: 'Сергей Милюков', email: 'milykov@erfis.ru', initials: 'СМ', isManager: false },
    { id: 'u_petrov', name: 'Дмитрий Петров', email: 'petrov@erfis.ru', initials: 'ДП', isManager: false },
  ];
  const REQUISITES = {
    name: 'Межрегиональное операционное УФК (Федеральная служба по интеллектуальной собственности)',
    personalAcc: '03100643000000019500',
    bankName: 'Операционный департамент Банка России//Межрегиональное операционное УФК г. Москва',
    bic: '024501901', correspAcc: '40102810045370000002',
    inn: '7730176088', kpp: '773001001', cbc: '16811505020016000140', oktmo: '45318000', payerStatus: '',
  };
  const MOOD_FACTORS = ['переработки', 'сжатые сроки', 'неясные задачи', 'много контекста/переключений', 'конфликт или сложное общение', 'нет перерывов/отдыха', 'монотонность', 'внешние обстоятельства', 'личное'];

  function seed() {
    const raw = window.__SEED || { trademarks: [], patents: [] };
    const s = (v) => (v == null ? '' : String(v).trim());
    const objects = [];
    raw.trademarks.forEach((t, i) => objects.push({
      id: t.id, type: 'trademark', holder: s(t.holder), name: s(t.name), appNumber: s(t.appNumber),
      regNumber: s(t.regNumber), objectType: '', mktuClasses: s(t.mktuClasses), priorityDate: s(t.priorityDate),
      expiryDate: s(t.expiryDate), documentRef: s(t.certificate), documentUrl: '',
      responsible: i % 7 === 0 ? 'u_konovalova' : i % 11 === 0 ? 'u_petrov' : null,
      notes: '', reminder: null, createdAt: nowISO(), updatedAt: nowISO(), deletedAt: null, deletedBy: null,
    }));
    raw.patents.forEach((p, i) => objects.push({
      id: p.id, type: 'patent', holder: s(p.holder), name: s(p.name), appNumber: s(p.appNumber),
      regNumber: s(p.patentNumber), objectType: s(p.objectType), mktuClasses: '', priorityDate: s(p.priorityDate),
      expiryDate: s(p.expiryDate), documentRef: s(p.patentFile), documentUrl: '',
      responsible: i % 9 === 0 ? 'u_milyukov' : null,
      notes: '', reminder: null, createdAt: nowISO(), updatedAt: nowISO(), deletedAt: null, deletedBy: null,
    }));
    // пара демо-напоминаний
    const setRem = (id, days, note, by) => {
      const o = objects.find((x) => x.id === id); if (!o) return;
      o.reminder = { date: dAgo(-days), time: '10:00', note, createdBy: by, createdAt: nowISO(), acknowledged: false };
    };
    setRem(objects[6].id, -3, 'оплатить пошлину за продление', 'u_konovalova');
    setRem(objects[13].id, 12, 'подготовить документы к продлению', 'u_ishinov');

    // демо-настроение за 3 недели
    const mood = [];
    for (let d = 20; d >= 1; d--) {
      const dt = dAgo(d); const dow = new Date(dt).getDay();
      if (dow === 0 || dow === 6) continue;
      USERS.forEach((u, ui) => {
        let m, wl, fac = [];
        if (u.id === 'u_milyukov') {
          m = d > 9 ? (d % 2 ? 4 : 3) : d > 4 ? 2 : 2;
          wl = d <= 10 ? 'high' : 'ok';
          if (m <= 2) fac = ['переработки', 'сжатые сроки'];
        } else {
          m = [3, 3, 4, 4, 4, 5, 3, 4][(d + ui) % 8];
          wl = ['ok', 'ok', 'high', 'low', 'ok'][(d + ui) % 5];
        }
        if (d === 1 && u.id === 'u_ishinov') return;
        mood.push({ userId: u.id, date: dt, mood: m, workload: wl, worked: 1, note: '', factors: fac });
      });
    }

    return {
      session: null, objects, mood, payments: [], requisites: { ...REQUISITES },
      activity: [{ id: 1, at: nowISO(), kind: 'import', text: `Импорт из «РЕЕСТР ОБЪЕКТОВ ЭРФИС.xlsx» — ${objects.length} объектов`, userId: null }],
      seq: { activity: 2, payment: 1 },
    };
  }

  let db;
  try { db = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
  if (!db || !db.objects) { db = seed(); save(); }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} }

  const uById = (id) => USERS.find((u) => u.id === id);
  const me = () => (db.session ? uById(db.session) : null);
  const daysLeft = (e) => (!e ? null : Math.round((new Date(e + 'T00:00:00Z') - new Date(todayMSK() + 'T00:00:00Z')) / DAY));
  function statusOf(e) {
    const dl = daysLeft(e);
    if (dl === null) return { key: 'none', label: 'Без срока', daysLeft: null };
    if (dl < 0) return { key: 'expired', label: 'Истёк', daysLeft: dl };
    if (dl <= SOON) return { key: 'expiring', label: `Истекает · ${dl} дн.`, daysLeft: dl };
    return { key: 'active', label: 'Действует', daysLeft: dl };
  }
  const remDue = (r) => !!r && !r.acknowledged && new Date(`${r.date}T${r.time || '00:00'}:00`) <= new Date();
  const toApi = (o) => ({ ...o, status: statusOf(o.expiryDate), flagged: remDue(o.reminder) });
  const logAct = (kind, o, text) => { db.activity.push({ id: db.seq.activity++, at: nowISO(), kind, objectId: o && o.id, objectType: o && o.type, text, userId: db.session }); };
  const J = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const T = (body, status = 200, type = 'text/plain;charset=utf-8') => new Response(body, { status, headers: { 'Content-Type': type } });

  function moodSignal(userId) {
    const rows = db.mood.filter((r) => r.userId === userId && r.date >= dAgo(28) && r.mood != null).sort((a, b) => b.date.localeCompare(a.date));
    const reasons = [];
    let low = 0; for (const r of rows) { if (r.mood <= 2) low++; else break; }
    if (low >= 3) reasons.push(`${low} тяжёлых дня подряд`);
    let ov = 0; for (const r of rows) { if (r.workload === 'high') ov++; else break; }
    if (ov >= 4) reasons.push(`${ov} дня подряд «завал»`);
    const avg = (a) => (a.length ? a.reduce((s, x) => s + x.mood, 0) / a.length : null);
    const a7 = avg(rows.slice(0, 7)), p7 = avg(rows.slice(7, 14));
    if (a7 != null && p7 != null && rows.length >= 10 && a7 - p7 <= -1.3) reasons.push('заметный спад за неделю');
    return { flag: reasons.length > 0, reasons };
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts = {}) {
    const u = typeof url === 'string' ? url : url.url;
    if (!u || u.indexOf('/api/') !== 0) return realFetch(url, opts);
    await new Promise((r) => setTimeout(r, 60));
    const method = (opts.method || 'GET').toUpperCase();
    const [path, qs] = u.slice(4).split('?');
    const q = new URLSearchParams(qs || '');
    const body = opts.body ? JSON.parse(opts.body) : {};
    const seg = path.split('/').filter(Boolean);
    const cu = me();

    try {
      if (path === '/login' && method === 'POST') {
        const user = USERS.find((x) => x.email.toLowerCase() === String(body.email || '').toLowerCase());
        if (!user || !body.password) return J({ error: 'Неверный email или пароль' }, 401);
        db.session = user.id; save();
        return J({ user: { ...user, mustChange: false } });
      }
      if (path === '/logout') { db.session = null; save(); return J({ ok: true }); }
      if (path === '/session') {
        if (!cu) return J({ error: 'no' }, 401);
        return J({ user: { ...cu, mustChange: false }, users: USERS.map((x) => ({ id: x.id, name: x.name, email: x.email, initials: x.initials })) });
      }
      if (path === '/password' && method === 'POST') return J({ ok: true });
      if (!cu) return J({ error: 'auth' }, 401);

      // ---- objects ----
      if (path === '/objects' && method === 'GET') {
        const type = q.get('type');
        return J({ objects: db.objects.filter((o) => o.type === type && !o.deletedAt).sort((a, b) => (a.holder + a.name).localeCompare(b.holder + b.name)).map(toApi) });
      }
      if (path === '/objects' && method === 'POST') {
        if (!body.name || !body.holder) return J({ error: 'Заполните название и правообладателя' }, 400);
        const o = {
          id: (body.type === 'patent' ? 'pt' : 'tm') + '-n' + Math.random().toString(36).slice(2, 7),
          type: body.type, holder: '', name: '', appNumber: '', regNumber: '', objectType: '', mktuClasses: '',
          priorityDate: '', expiryDate: '', documentRef: '', documentUrl: '', responsible: null, notes: '',
          reminder: null, createdAt: nowISO(), updatedAt: nowISO(), deletedAt: null, deletedBy: null,
        };
        ['holder', 'name', 'appNumber', 'regNumber', 'objectType', 'mktuClasses', 'priorityDate', 'expiryDate', 'documentRef', 'documentUrl', 'notes', 'responsible'].forEach((k) => { if (k in body) o[k] = body[k] || (k === 'responsible' ? null : ''); });
        db.objects.unshift(o); logAct('create', o, `Создан объект «${o.name}»`); save();
        return J({ object: toApi(o) });
      }
      if (seg[0] === 'objects' && seg[1] && !seg[2]) {
        const o = db.objects.find((x) => x.id === seg[1]);
        if (!o) return J({ error: 'not found' }, 404);
        if (method === 'GET') return J({ object: toApi(o), activity: db.activity.filter((a) => a.objectId === o.id).slice(-30).reverse() });
        if (method === 'PATCH') {
          const changed = [];
          const L = { holder: 'правообладатель', name: 'название', appNumber: '№ заявки', regNumber: '№ регистрации/патента', objectType: 'вид', mktuClasses: 'классы МКТУ', priorityDate: 'приоритет', expiryDate: 'срок', responsible: 'ответственный', notes: 'примечание', documentRef: 'документ', documentUrl: 'ссылка' };
          Object.keys(L).forEach((k) => {
            if (!(k in body)) return;
            const nv = k === 'responsible' ? (body[k] || null) : String(body[k] ?? '').trim();
            if (String(o[k] ?? '') === String(nv ?? '')) return;
            o[k] = nv; changed.push(L[k]);
          });
          if (!changed.length) return J({ object: toApi(o), unchanged: true });
          o.updatedAt = nowISO(); logAct('edit', o, `Изменён объект «${o.name}» (${changed.join(', ')})`); save();
          return J({ object: toApi(o) });
        }
        if (method === 'DELETE') { o.deletedAt = nowISO(); o.deletedBy = db.session; logAct('delete', o, `Удалён объект «${o.name}» → корзина`); save(); return J({ ok: true }); }
      }
      if (seg[0] === 'objects' && seg[2] === 'reminder') {
        const o = db.objects.find((x) => x.id === seg[1]); if (!o) return J({ error: 'not found' }, 404);
        if (seg[3] === 'ack') { o.reminder.acknowledged = true; o.reminder.ackBy = db.session; logAct('reminder_ok', o, `Напоминание по «${o.name}» закрыто — «всё в порядке»`); save(); return J({ object: toApi(o) }); }
        if (method === 'DELETE') { logAct('reminder_del', o, `Снято напоминание по «${o.name}»`); o.reminder = null; save(); return J({ object: toApi(o) }); }
        if (method === 'POST') {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || ''))) return J({ error: 'Укажите дату' }, 400);
          o.reminder = { date: body.date, time: body.time || '10:00', note: (body.note || '').trim(), createdBy: db.session, createdAt: nowISO(), acknowledged: false };
          o.updatedAt = nowISO(); logAct('reminder_set', o, `Напоминание о продлении «${o.name}» на ${body.date}`); save();
          return J({ object: toApi(o) });
        }
      }
      if (path === '/reminders') {
        const items = db.objects.filter((o) => o.reminder && !o.reminder.acknowledged && !o.deletedAt).map(toApi)
          .sort((a, b) => (a.reminder.date + a.reminder.time).localeCompare(b.reminder.date + b.reminder.time));
        return J({ reminders: items });
      }
      if (path === '/trash') return J({ trash: db.objects.filter((o) => o.deletedAt).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt)).map(toApi) });
      if (seg[0] === 'trash' && seg[1]) {
        const o = db.objects.find((x) => x.id === seg[1]); if (!o) return J({ error: 'not found' }, 404);
        if (seg[2] === 'restore') { o.deletedAt = null; o.deletedBy = null; logAct('restore', o, `Восстановлен объект «${o.name}» из корзины`); save(); return J({ ok: true }); }
        if (method === 'DELETE') { db.objects = db.objects.filter((x) => x.id !== o.id); logAct('purge', o, `Объект «${o.name}» удалён навсегда`); save(); return J({ ok: true }); }
      }
      if (path === '/activity') return J({ activity: db.activity.slice(-Number(q.get('limit') || 300)).reverse() });

      if (path === '/export') {
        const type = q.get('type');
        const rows = db.objects.filter((o) => o.type === type && !o.deletedAt).map(toApi);
        const cols = type === 'patent'
          ? [['holder', 'Правообладатель'], ['objectType', 'Вид'], ['name', 'Название'], ['appNumber', '№ заявки'], ['regNumber', '№ патента'], ['priorityDate', 'Приоритет'], ['expiryDate', 'Действует до'], ['status', 'Статус'], ['responsible', 'Ответственный']]
          : [['holder', 'Правообладатель'], ['appNumber', '№ заявки'], ['name', 'Название'], ['regNumber', '№ регистрации'], ['mktuClasses', 'Классы МКТУ'], ['priorityDate', 'Приоритет'], ['expiryDate', 'Действует до'], ['status', 'Статус'], ['responsible', 'Ответственный']];
        const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const cell = (o, k) => k === 'status' ? o.status.label : k === 'responsible' ? (uById(o.responsible)?.name || '') : o[k] || '';
        const csv = '﻿' + [cols.map((c) => esc(c[1])).join(';'), ...rows.map((o) => cols.map((c) => esc(cell(o, c[0]))).join(';'))].join('\r\n');
        return T(csv, 200, 'text/csv;charset=utf-8');
      }

      // ---- health ----
      if (path === '/health') {
        const act = db.objects.filter((o) => !o.deletedAt);
        return J({
          ok: true, version: 'demo', tunnelUrl: null,
          trademarks: act.filter((o) => o.type === 'trademark').length,
          patents: act.filter((o) => o.type === 'patent').length,
          trash: db.objects.filter((o) => o.deletedAt).length,
          activity: db.activity.length,
          remindersDue: act.filter((o) => remDue(o.reminder)).length,
          importedAt: nowISO(),
        });
      }

      // ---- mood ----
      if (path === '/mood/today') {
        const e = db.mood.find((m) => m.userId === db.session && m.date === todayMSK());
        return J({ date: todayMSK(), entry: e ? { date: e.date, mood: e.mood, workload: e.workload, worked: true, note: e.note, factors: e.factors } : null, factors: MOOD_FACTORS });
      }
      if (path === '/mood' && method === 'POST') {
        const d = todayMSK();
        let e = db.mood.find((m) => m.userId === db.session && m.date === d);
        if (!e) { e = { userId: db.session, date: d }; db.mood.push(e); }
        e.mood = body.mood; e.workload = body.workload || 'ok'; e.worked = 1; e.note = (body.note || '').trim();
        e.factors = (body.factors || []).filter((x) => MOOD_FACTORS.includes(x));
        save(); return J({ ok: true });
      }
      if (path === '/mood/team') {
        if (!cu.isManager) return J({ error: 'Раздел доступен только руководителю' }, 403);
        const days = 30;
        const series = [];
        for (let i = days - 1; i >= 0; i--) {
          const dt = dAgo(i); const arr = db.mood.filter((m) => m.date === dt && m.mood != null).map((m) => m.mood);
          series.push({ date: dt, avg: arr.length ? +(arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(2) : null, count: arr.length });
        }
        const members = USERS.map((e) => {
          const rows = db.mood.filter((m) => m.userId === e.id);
          const t = rows.find((m) => m.date === todayMSK());
          const recent = [];
          for (let i = 13; i >= 0; i--) { const dt = dAgo(i); const r = rows.find((m) => m.date === dt); recent.push(r ? { date: dt, mood: r.mood, worked: true } : { date: dt, mood: null, worked: null }); }
          const w7 = rows.filter((m) => m.mood != null && m.date >= dAgo(6));
          return {
            userId: e.id, name: e.name, initials: e.initials, todayDone: !!t,
            today: t ? { mood: t.mood, workload: t.workload, worked: true } : null,
            avg7: w7.length ? +(w7.reduce((s, x) => s + x.mood, 0) / w7.length).toFixed(1) : null,
            recent, signal: moodSignal(e.id),
          };
        });
        const w = db.mood.filter((m) => m.mood != null && m.date >= dAgo(6));
        return J({
          days, series, members,
          participationToday: { done: members.filter((m) => m.todayDone).length, total: USERS.length },
          teamAvg7: w.length ? +(w.reduce((s, x) => s + x.mood, 0) / w.length).toFixed(2) : null,
        });
      }
      if (path === '/mood/mine') {
        if (!cu.isManager) return J({ error: 'forbidden' }, 403);
        return J({ entries: db.mood.filter((m) => m.userId === db.session && m.date >= dAgo(60)).sort((a, b) => a.date.localeCompare(b.date)).map((m) => ({ date: m.date, mood: m.mood, workload: m.workload, worked: true, note: m.note, factors: m.factors })) });
      }
      if (path === '/mood/export') {
        if (!cu.isManager) return T('forbidden', 403);
        const WL = { low: 'недогруз', ok: 'в норме', high: 'завал' };
        const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const head = ['Дата', 'Сотрудник', 'Оценка дня', 'Загрузка', 'Факторы', 'Комментарий'];
        const lines = db.mood.slice().sort((a, b) => a.date.localeCompare(b.date)).map((r) => [r.date, uById(r.userId).name, r.mood, WL[r.workload], (r.factors || []).join('; '), r.note].map(esc).join(';'));
        return T('﻿' + [head.map(esc).join(';'), ...lines].join('\r\n'), 200, 'text/csv;charset=utf-8');
      }

      // ---- payments ----
      if (path === '/payments/requisites') {
        if (method === 'PUT') { Object.assign(db.requisites, body); save(); logAct('requisites', null, 'Изменены реквизиты для оплаты пошлин'); return J({ requisites: db.requisites }); }
        return J({ requisites: db.requisites });
      }
      if (path === '/payments' && method === 'GET') return J({ payments: db.payments.slice().reverse() });
      if (path === '/payments' && method === 'POST') {
        if (!(Number(body.amount) > 0)) return J({ error: 'Укажите сумму больше нуля' }, 400);
        if (!String(body.purpose || '').trim()) return J({ error: 'Укажите назначение платежа' }, 400);
        const p = { id: db.seq.payment++, amount: Number(body.amount), purpose: body.purpose.trim(), payer: (body.payer || '').trim(), uin: (body.uin || '').trim(), qrString: body.qrString || '', createdBy: db.session, createdAt: nowISO() };
        db.payments.push(p); logAct('payment_qr', null, `Сформирован QR на оплату пошлины: ${p.amount.toLocaleString('ru-RU')} ₽`); save();
        return J({ id: p.id });
      }
      if (seg[0] === 'payments' && seg[1] && method === 'DELETE') { db.payments = db.payments.filter((x) => x.id != seg[1]); save(); return J({ ok: true }); }

      return J({ error: 'not found: ' + path }, 404);
    } catch (e) {
      console.error('mock error', path, e);
      return J({ error: e.message || 'demo error' }, 500);
    }
  };

  // мини-баннер «демо»
  addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('div');
    b.textContent = 'Демо-версия · данные хранятся только в этом браузере · вход: любой из 4 e-mail + любой пароль';
    b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:200;background:#050038;color:#fff;font:12px/1.4 system-ui;padding:6px 12px;text-align:center;opacity:.92';
    document.body.appendChild(b);
  });
})();
