/* Демо-режим портала ЭРФИС: подменяет /api/* на локальное хранилище браузера.
   Данные не уходят на сервер. Всё живёт в этом браузере (localStorage). */
(function () {
  const KEY = 'erfis_demo_v7';
  const nowISO = () => new Date().toISOString();
  const todayMSK = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  const DAY = 86400000, SOON = 183;

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

  function seed() {
    const raw = window.__SEED || { trademarks: [], patents: [], software: [], shipments: [], contracts: [] };
    const s = (v) => (v == null ? '' : String(v).trim());
    const O = (o) => Object.assign({
      id: '', type: '', holder: '', name: '', appNumber: '', regNumber: '', objectType: '', mktuClasses: '',
      priorityDate: '', expiryDate: '', documentRef: '', documentUrl: '', responsible: null, notes: '', reminder: null,
      intNo: '', contactPerson: '', email: '', registry: '', actWhen: '',
      contractKind: '', workDate: '', stage: '', act: '', executor: '',
      createdAt: nowISO(), updatedAt: nowISO(), deletedAt: null, deletedBy: null,
    }, o);
    const objects = [];
    (raw.trademarks || []).forEach((t, i) => objects.push(O({
      id: t.id, type: 'trademark', holder: s(t.holder), name: s(t.name), appNumber: s(t.appNumber),
      regNumber: s(t.regNumber), mktuClasses: s(t.mktuClasses), priorityDate: s(t.priorityDate),
      expiryDate: s(t.expiryDate), documentRef: s(t.certificate),
      responsible: i % 7 === 0 ? 'u_konovalova' : i % 11 === 0 ? 'u_petrov' : null,
    })));
    (raw.patents || []).forEach((p, i) => objects.push(O({
      id: p.id, type: 'patent', holder: s(p.holder), name: s(p.name), appNumber: s(p.appNumber),
      regNumber: s(p.patentNumber), objectType: s(p.objectType), priorityDate: s(p.priorityDate),
      expiryDate: s(p.expiryDate), documentRef: s(p.patentFile),
      responsible: i % 9 === 0 ? 'u_milyukov' : null,
    })));
    (raw.software || []).forEach((w) => objects.push(O({
      id: w.id, type: 'software', holder: s(w.holder), name: s(w.name), regNumber: s(w.regNumber),
      intNo: s(w.intNo), contactPerson: s(w.contactPerson), email: s(w.email), registry: s(w.registry), actWhen: s(w.actWhen),
    })));
    (raw.shipments || []).forEach((sh) => objects.push(O({
      id: sh.id, type: 'shipment', name: s(sh.docType), regNumber: s(sh.objectNumber),
      appNumber: s(sh.caseNumber), priorityDate: s(sh.date),
    })));
    (raw.contracts || []).forEach((ct) => objects.push(O({
      id: ct.id, type: 'contract', holder: s(ct.contragent),
      name: s(ct.workDesc) || ('Договор ' + s(ct.contractNo || '')).trim(),
      regNumber: s(ct.contractNo), priorityDate: s(ct.contractDate), expiryDate: s(ct.deadline),
      contractKind: s(ct.kind), workDate: s(ct.workDate), stage: s(ct.stage), act: s(ct.act),
      executor: s(ct.executor), contactPerson: s(ct.contactName), email: s(ct.contactEmail), notes: s(ct.note),
    })));
    const setRem = (id, days, note, by) => {
      const o = objects.find((x) => x.id === id); if (!o) return;
      o.reminder = { date: new Date(Date.now() + days * DAY).toISOString().slice(0, 10), time: '10:00', note, createdBy: by, createdAt: nowISO(), acknowledged: false };
    };
    setRem(objects[6].id, 3, 'оплатить пошлину за продление', 'u_konovalova');
    setRem(objects[13].id, -12, 'подготовить документы к продлению', 'u_ishinov');

    const price = (window.__PRICE || []).map((p, i) => ({ id: i + 1, category: p.category || '', name: p.name || '', fee: p.fee || '', duty: p.duty || '', total: p.total || '', note: p.note || '', updatedAt: null, updatedBy: null }));

    return {
      session: null, objects, payments: [], requisites: { ...REQUISITES }, price,
      activity: [{ id: 1, at: nowISO(), kind: 'import', text: `Импорт данных — ${objects.length} объектов`, userId: null }],
      seq: { activity: 2, payment: 1, price: price.length + 1 },
    };
  }

  let db;
  try { db = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
  if (!db || !db.objects) { db = seed(); save(); }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} }

  const uById = (id) => USERS.find((u) => u.id === id);
  const me = () => (db.session ? uById(db.session) : null);
  const daysLeft = (e) => {
    if (!e || !/^\d{4}-\d{2}-\d{2}/.test(e)) return null;
    const t = new Date(e.slice(0, 10) + 'T00:00:00Z') - new Date(todayMSK() + 'T00:00:00Z');
    return Number.isNaN(t) ? null : Math.round(t / DAY);
  };
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
  const T = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/csv;charset=utf-8' } });
  const EDIT_KEYS = ['holder', 'name', 'appNumber', 'regNumber', 'objectType', 'mktuClasses', 'priorityDate', 'expiryDate', 'documentRef', 'notes', 'intNo', 'contactPerson', 'email', 'registry', 'actWhen', 'contractKind', 'workDate', 'stage', 'act', 'executor'];
  const LBL = { holder: 'правообладатель', name: 'название', appNumber: '№ заявки', regNumber: '№ регистрации/патента', objectType: 'вид', mktuClasses: 'классы МКТУ', priorityDate: 'дата', expiryDate: 'срок', documentRef: 'документ', notes: 'примечание', intNo: 'внутренний №', contactPerson: 'контактное лицо', email: 'e-mail', registry: 'реестр', actWhen: 'когда обратиться', responsible: 'ответственный' };

  const realFetch = window.fetch.bind(window);
  window.fetch = async function (url, opts = {}) {
    const u = typeof url === 'string' ? url : url.url;
    if (!u || u.indexOf('/api/') !== 0) return realFetch(url, opts);
    await new Promise((r) => setTimeout(r, 50));
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
        let rows = db.objects.filter((o) => o.type === type && !o.deletedAt);
        rows = type === 'shipment' ? rows.sort((a, b) => (b.priorityDate || '').localeCompare(a.priorityDate || ''))
          : rows.sort((a, b) => (a.holder + a.name).localeCompare(b.holder + b.name));
        return J({ objects: rows.map(toApi) });
      }
      if (path === '/objects' && method === 'POST') {
        if (!String(body.name || '').trim()) return J({ error: 'Заполните название' }, 400);
        if ((body.type === 'trademark' || body.type === 'patent' || body.type === 'contract') && !String(body.holder || '').trim()) return J({ error: 'Заполните ' + (body.type === 'contract' ? 'контрагента' : 'правообладателя') }, 400);
        const pfx = { trademark: 'tm', patent: 'pt', software: 'sw', shipment: 'sh', contract: 'ct' }[body.type];
        const o = { id: pfx + '-n' + Math.random().toString(36).slice(2, 7), type: body.type, responsible: null, reminder: null, createdAt: nowISO(), updatedAt: nowISO(), deletedAt: null, deletedBy: null };
        EDIT_KEYS.forEach((k) => o[k] = String(body[k] ?? '').trim());
        o.responsible = body.responsible || null;
        db.objects.unshift(o); logAct('create', o, `Создан объект «${o.name}»`); save();
        return J({ object: toApi(o) });
      }
      if (seg[0] === 'objects' && seg[1] && !seg[2]) {
        const o = db.objects.find((x) => x.id === seg[1]);
        if (!o) return J({ error: 'not found' }, 404);
        if (method === 'GET') return J({ object: toApi(o), activity: db.activity.filter((a) => a.objectId === o.id).slice(-30).reverse() });
        if (method === 'PATCH') {
          const changed = [];
          [...EDIT_KEYS, 'responsible'].forEach((k) => {
            if (!(k in body)) return;
            const nv = k === 'responsible' ? (body[k] || null) : String(body[k] ?? '').trim();
            if (String(o[k] ?? '') === String(nv ?? '')) return;
            o[k] = nv; changed.push(LBL[k] || k);
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
        let rows = db.objects.filter((o) => o.type === type && !o.deletedAt).map(toApi);
        const C = {
          trademark: [['holder', 'Правообладатель'], ['appNumber', '№ заявки'], ['name', 'Название'], ['regNumber', '№ регистрации'], ['mktuClasses', 'Классы МКТУ'], ['priorityDate', 'Приоритет'], ['expiryDate', 'Действует до'], ['status', 'Статус'], ['responsible', 'Ответственный']],
          patent: [['holder', 'Правообладатель'], ['objectType', 'Вид'], ['name', 'Название'], ['appNumber', '№ заявки'], ['regNumber', '№ патента'], ['priorityDate', 'Приоритет'], ['expiryDate', 'Действует до'], ['status', 'Статус'], ['responsible', 'Ответственный']],
          software: [['intNo', 'Вн. №'], ['name', 'Название'], ['regNumber', '№ регистрации'], ['holder', 'Правообладатель'], ['contactPerson', 'Контактное лицо'], ['email', 'E-mail'], ['registry', 'Реестр'], ['actWhen', 'Когда обратиться'], ['responsible', 'Ответственный']],
          shipment: [['priorityDate', 'Дата'], ['name', 'Вид документа'], ['regNumber', '№ объекта'], ['appNumber', '№ делопроизводства'], ['responsible', 'Ответственный']],
          contract: [['holder', 'Контрагент'], ['regNumber', '№ договора'], ['name', 'Вид работ / № ТЗ'], ['workDate', 'Дата ТЗ'], ['expiryDate', 'Срок'], ['stage', 'Стадия'], ['act', 'Акт'], ['executor', 'Исполнитель'], ['responsible', 'Ответственный']],
        }[type];
        if (type === 'contract' && q.get('kind')) rows = rows.filter((r) => r.contractKind === q.get('kind'));
        const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const cell = (o, k) => k === 'status' ? o.status.label : k === 'responsible' ? (uById(o.responsible)?.name || '') : o[k] || '';
        return T('﻿' + [C.map((c) => esc(c[1])).join(';'), ...rows.map((o) => C.map((c) => esc(cell(o, c[0]))).join(';'))].join('\r\n'));
      }

      if (path === '/health') {
        const act = db.objects.filter((o) => !o.deletedAt);
        return J({
          ok: true, version: 'demo', tunnelUrl: null,
          trademarks: act.filter((o) => o.type === 'trademark').length,
          patents: act.filter((o) => o.type === 'patent').length,
          software: act.filter((o) => o.type === 'software').length,
          shipments: act.filter((o) => o.type === 'shipment').length,
          contracts: act.filter((o) => o.type === 'contract').length,
          price: db.price.length,
          trash: db.objects.filter((o) => o.deletedAt).length,
          activity: db.activity.length,
          remindersDue: act.filter((o) => remDue(o.reminder)).length,
          importedAt: nowISO(),
        });
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

      // ---- price ----
      if (path === '/price' && method === 'GET') return J({ items: db.price.slice() });
      if (path === '/price' && method === 'POST') {
        if (!String(body.name || '').trim()) return J({ error: 'Укажите наименование работы' }, 400);
        const it = { id: db.seq.price++, category: (body.category || '').trim(), name: body.name.trim(), fee: (body.fee || '').trim(), duty: (body.duty || '').trim(), total: (body.total || '').trim(), note: '', updatedAt: nowISO(), updatedBy: db.session };
        db.price.push(it); logAct('price', null, `Добавлена услуга в прайс: «${it.name.slice(0, 60)}»`); save();
        return J({ id: it.id });
      }
      if (path === '/price/export') {
        const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const head = ['Категория', 'Наименование работы', 'Гонорар (руб.)', 'Пошлина (руб.)', 'Всего (руб.)', 'Примечание'];
        return T('﻿' + [head.map(esc).join(';'), ...db.price.map((r) => [r.category, r.name, r.fee, r.duty, r.total, r.note].map(esc).join(';'))].join('\r\n'));
      }
      if (seg[0] === 'price' && seg[1]) {
        const it = db.price.find((x) => x.id == seg[1]); if (!it) return J({ error: 'not found' }, 404);
        if (method === 'PATCH') {
          ['category', 'name', 'fee', 'duty', 'total', 'note'].forEach((k) => { if (k in body) it[k] = String(body[k] ?? ''); });
          it.updatedAt = nowISO(); it.updatedBy = db.session;
          logAct('price', null, `Изменена цена: «${it.name.slice(0, 60)}»`); save();
          return J({ item: it });
        }
        if (method === 'DELETE') { db.price = db.price.filter((x) => x.id != seg[1]); logAct('price', null, `Удалена услуга из прайса: «${it.name.slice(0, 60)}»`); save(); return J({ ok: true }); }
      }

      return J({ error: 'not found: ' + path }, 404);
    } catch (e) {
      console.error('mock error', path, e);
      return J({ error: e.message || 'demo error' }, 500);
    }
  };

  addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('div');
    b.textContent = 'Демо-версия · данные хранятся только в этом браузере · вход: любой из 4 e-mail + любой пароль';
    b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:200;background:#050038;color:#fff;font:12px/1.4 system-ui;padding:6px 12px;text-align:center;opacity:.92';
    document.body.appendChild(b);
  });
})();
