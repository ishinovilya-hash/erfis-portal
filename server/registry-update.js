import { randomUUID } from 'node:crypto';

export const IP_TYPES = ['trademark', 'patent', 'software'];
export function contractDefaults(db, kind = 'legal', date = new Date()) {
  const day = date.toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  const year = day.slice(0, 4);
  const prefix = {legal:'', individual:'Ф', subscription:'А'}[kind];
  if (prefix === undefined) throw new Error('Неизвестный тип договора');
  const rx = new RegExp(`^${prefix}(\\d+)/${year}$`, 'i');
  let max = 0;
  // Include trash: previously issued numbers must not be reused.
  for (const r of db.prepare("SELECT reg_number FROM objects WHERE type='contract'").all()) {
    const m = r.reg_number.replace(/\s/g, '').match(rx);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return {regNumber: `${prefix}${max+1}/${year}`, priorityDate: day};
}

export function moveRefused(db, id, refused, userId) {
  const row = db.prepare('SELECT * FROM objects WHERE id=?').get(id);
  if (!row || row.deleted_at || !IP_TYPES.includes(row.type)) throw new Error('Объект недоступен для переноса');
  if (!!row.refused_at === refused) return;
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE objects SET refused_at=?, updated_at=? WHERE id=?').run(refused ? now : null, now, id);
    db.prepare('INSERT INTO activity(at,kind,object_id,object_type,text,user_id) VALUES(?,?,?,?,?,?)')
      .run(now, refused ? 'refused' : 'reactivated', id, row.type,
        `${refused ? 'Перенесён в отказные' : 'Возвращён в основной реестр'}: ${row.name}`, userId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

const norm = s => String(s || '').normalize('NFKC').replace(/\s/g,'').toLowerCase();
const number = s => String(s || '').trim().match(/^\d[\d/ -]*/)?.[0].replace(/[ -]/g,'') || '';

// Idempotent import. Never replace current card fields or resurrect trash.
export function importRegistryUpdate(db, payload, userId, preview = false) {
  if (payload?.format !== 'erfis-registry-update-v1' || !/^[a-z0-9-]{1,100}$/.test(payload.id || '') ||
      !Array.isArray(payload.refused) || !Array.isArray(payload.price) || (!payload.price.length && !payload.refused.length) ||
      payload.refused.some(x => !IP_TYPES.includes(x.type) || !x.sourceKey || !x.name) ||
      payload.price.some(x => !x.name || ['category','name','fee','duty','total','note'].some(k => typeof x[k] !== 'string')))
    throw new Error('Неверный файл обновления');
  const key = 'registry-update:' + payload.id;
  if (db.prepare('SELECT v FROM meta WHERE k=?').get(key)) return {alreadyApplied:true};
  db.exec('BEGIN IMMEDIATE');
  try {
    const all = db.prepare('SELECT * FROM objects').all();
    const result = {added:0, moved:0, existing:0, conflicts:[], prices:payload.price.length};
    const plans = [], seen = new Set();
    for (const item of payload.refused) {
      if (seen.has(item.sourceKey)) continue;
      seen.add(item.sourceKey);
      const reg = number(item.regNumber), app = norm(item.appNumber);
      const matches = all.filter(r => r.type === item.type &&
        ((reg && number(r.reg_number) === reg) || (app && norm(r.app_number) === app) ||
         (!reg && !app && norm(r.holder) === norm(item.holder) && norm(r.name) === norm(item.name))));
      if(payload.confirmAll === true) {
        const active=matches.filter(r=>!r.deleted_at);
        if(active.length){
          for(const row of active){
            const planned=plans.find(p=>p.row?.id===row.id);
            if(planned){planned.sources.push(item.sourceRow);continue;}
            if(row.refused_at) result.existing++; else result.moved++;
            plans.push({row,item,sources:[item.sourceRow]});
          }
        } else {
          // Preserve separate source rows when no existing card identifies them.
          result.added++;plans.push({item,sources:[item.sourceRow]});
        }
        continue;
      }
      if (matches.length > 1 || matches[0]?.deleted_at) {
        result.conflicts.push({sourceKey:item.sourceKey, name:item.name, reason:matches.length>1?'Несколько совпадений':'Есть в корзине'});
        continue;
      }
      const row = matches[0];
      if (row?.refused_at) result.existing++;
      else if (row) { result.moved++; plans.push({row,item}); }
      else {
        // Catch repeated identities inside the source file, not only in the DB.
        const duplicate=plans.find(p=>!p.row && p.item.type===item.type &&
          ((reg && number(p.item.regNumber)===reg) || (app && norm(p.item.appNumber)===app)));
        if(duplicate){
          if(norm(duplicate.item.name)!==norm(item.name) || norm(duplicate.item.holder)!==norm(item.holder))
            result.conflicts.push({sourceKey:item.sourceKey,name:item.name,reason:'Разные данные с одинаковым номером в файле'});
          else {duplicate.item={...duplicate.item,notes:[duplicate.item.notes,item.notes].filter(Boolean).join('\n')};result.existing++;}
        } else {result.added++;plans.push({item});}
      }
    }
    // Require a clean preview; partial silent import is not acceptable.
    if (preview || result.conflicts.length) { db.exec('ROLLBACK'); return result; }
    const now = new Date().toISOString();
    // Persist a full logical before-image for recovery, inside the same transaction.
    db.prepare('INSERT INTO meta(k,v) VALUES(?,?)').run(key+':backup', JSON.stringify({objects:all,price:db.prepare('SELECT * FROM price_items').all()}));
    for (const {row,item,sources} of plans) {
      const id = row?.id || 'rf-' + randomUUID();
      if (row) {
        const extra=JSON.parse(row.extra || '{}');
        extra.refusedImportSources=[...(extra.refusedImportSources||[]),...(sources||[item.sourceRow])];
        db.prepare('UPDATE objects SET refused_at=?, updated_at=?, extra=? WHERE id=?').run(now,now,JSON.stringify(extra),id);
      }
      else db.prepare(`INSERT INTO objects(id,type,holder,name,app_number,reg_number,object_type,mktu_classes,priority_date,expiry_date,document_ref,document_url,notes,extra,refused_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,item.type,item.holder||'',item.name,item.appNumber||'',item.regNumber||'',item.objectType||'',item.mktuClasses||'',item.priorityDate||'',item.expiryDate||'',item.documentRef||'',item.documentUrl||'',item.notes||'',JSON.stringify({sourceKey:item.sourceKey,sourceRow:item.sourceRow}),now,now,now);
      db.prepare('INSERT INTO activity(at,kind,object_id,object_type,text,user_id) VALUES(?,?,?,?,?,?)')
        .run(now,'refused',id,item.type,`Импорт отказного объекта: ${item.name}`,userId);
    }
    if(payload.price.length) db.prepare('DELETE FROM price_items').run();
    const ins = db.prepare('INSERT INTO price_items(category,name,fee,duty,total,note,sort,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?)');
    payload.price.forEach((p,i)=>ins.run(p.category,p.name,p.fee,p.duty,p.total,p.note,i,now,userId));
    db.prepare('INSERT INTO meta(k,v) VALUES(?,?)').run(key,JSON.stringify({at:now,...result}));
    db.prepare('INSERT INTO activity(at,kind,text,user_id) VALUES(?,?,?,?)').run(now,'import',`Импорт отказных объектов и прайса: ${JSON.stringify(result)}`,userId);
    db.exec('COMMIT');
    return result;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
