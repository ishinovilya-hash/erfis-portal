import {randomUUID} from 'node:crypto';

export const CLIENT_OBJECT_TYPES = ['trademark','patent','software','contract'];
export const OPFS = ['', 'ООО','АО','ЗАО','ИП','физ. лицо'];
const norm = s => String(s || '').trim().toLowerCase();
const now = () => new Date().toISOString();
const fail = (message,status=400) => { throw Object.assign(new Error(message),{status}); };

// Additive migration: original clients and all object fields remain intact.
export function initClients360(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS counterparties (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, inn TEXT NOT NULL DEFAULT '',
    opf TEXT NOT NULL DEFAULT '',
    contacts TEXT NOT NULL DEFAULT '[]', website TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_counterparty_inn ON counterparties(inn) WHERE inn<>'';`);
  if(!db.prepare('PRAGMA table_info(objects)').all().some(c=>c.name==='client_id'))
    db.exec('ALTER TABLE objects ADD COLUMN client_id TEXT REFERENCES counterparties(id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_object_client ON objects(client_id)');
  if(db.prepare("SELECT 1 FROM meta WHERE k='clients360-v1'").get()) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const groups=new Map();
    for(const r of db.prepare("SELECT id,holder,type,deleted_at FROM objects WHERE trim(holder)<>''").all()) {
      if(!CLIENT_OBJECT_TYPES.includes(r.type))continue;
      const key=norm(r.holder);
      if(!groups.has(key))groups.set(key,{name:r.holder,website:'',rows:[]});
      groups.get(key).rows.push(r.id);
    }
    for(const c of db.prepare('SELECT * FROM clients').all()) {
      const key=norm(c.key);
      if(!groups.has(key))groups.set(key,{name:c.name,website:'',rows:[]});
      groups.get(key).website=c.website;
    }
    for(const g of groups.values()) {
      const id='cl-'+randomUUID(), at=now();
      db.prepare('INSERT INTO counterparties(id,name,website,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,g.name,g.website,at,at);
      for(const oid of g.rows)db.prepare('UPDATE objects SET client_id=? WHERE id=?').run(id,oid);
    }
    db.prepare('INSERT INTO meta(k,v) VALUES(?,?)').run('clients360-v1',JSON.stringify({at:now(),clients:groups.size}));
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
}

export function clientApi(r) { const {kind,...c}=r; return {...c,contacts:JSON.parse(r.contacts),updatedAt:r.updated_at}; }

export function saveClient(db,b,user,id=null) {
  const old=id?db.prepare('SELECT * FROM counterparties WHERE id=?').get(id):null;
  if(id&&!old)fail('Карточка не найдена',404);
  if(old && b.revision!==old.revision)fail('Карточка изменена другим сотрудником. Откройте её заново.',409);
  const val=(k,limit)=>{const v=String(b[k]??old?.[k]??'').trim();if(v.length>limit)fail('Слишком длинное поле: '+k);return v;};
  const name=val('name',500),inn=val('inn',12),opf=val('opf',30),website=val('website',2000);
  if(!name)fail('Укажите наименование');
  if(!OPFS.includes(opf))fail('Проверьте ОПФ');
  if(inn&&!/^(\d{10}|\d{12})$/.test(inn))fail('ИНН должен содержать 10 или 12 цифр');
  if(inn&&((['ООО','АО','ЗАО'].includes(opf)&&inn.length!==10)||(['ИП','физ. лицо'].includes(opf)&&inn.length!==12)))fail('Длина ИНН не соответствует ОПФ');
  if(website&&!/^https?:\/\//i.test(website))fail('Сайт должен начинаться с https:// или http://');
  const raw=b.contacts??(old?JSON.parse(old.contacts):[]);
  if(!Array.isArray(raw)||raw.length>20)fail('Можно добавить до 20 контактов');
  const contacts=raw.map(c=>{
    if(!c||typeof c!=='object')fail('Неверный контакт');
    const out={};for(const k of ['name','email','phone','telegram']){out[k]=String(c[k]??'').trim();if(out[k].length>255)fail('Слишком длинный контакт');}
    if(out.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email))fail('Проверьте email контакта');
    return out;
  }).filter(c=>Object.values(c).some(Boolean));
  db.exec('BEGIN IMMEDIATE');
  try {
    if(old && db.prepare('SELECT revision FROM counterparties WHERE id=?').get(id).revision!==b.revision)fail('Карточка уже изменена',409);
    const duplicate=db.prepare('SELECT id,name,inn FROM counterparties WHERE id<>?').all(id||'').find(c=>(inn&&c.inn===inn)||norm(c.name)===norm(name));
    if(duplicate)fail('Такая карточка уже существует: '+duplicate.name,409);
    const cid=id||'cl-'+randomUUID(),at=now();
    if(old){
      db.prepare('UPDATE counterparties SET name=?,inn=?,opf=?,contacts=?,website=?,revision=revision+1,updated_at=?,updated_by=? WHERE id=?').run(name,inn,opf,JSON.stringify(contacts),website,at,user,cid);
      if(name!==old.name)db.prepare('UPDATE objects SET holder=?,updated_at=? WHERE client_id=?').run(name,at,cid);
    }else db.prepare('INSERT INTO counterparties(id,name,inn,opf,contacts,website,created_at,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?)').run(cid,name,inn,opf,JSON.stringify(contacts),website,at,at,user);
    db.prepare('INSERT INTO activity(at,kind,text,user_id) VALUES(?,?,?,?)').run(at,'client',(old?'Изменена':'Создана')+' карточка «'+name+'»',user);
    db.exec('COMMIT');
    return clientApi(db.prepare('SELECT * FROM counterparties WHERE id=?').get(cid));
  }catch(e){db.exec('ROLLBACK');throw e;}
}

// A registry row has exactly one owner/customer. Never create an implicit second card.
export function resolveObjectClient(db,b,row=null) {
  const type=row?.type||b.type;
  if(!CLIENT_OBJECT_TYPES.includes(type)){delete b.clientId;return;}
  let id=('clientId' in b)?b.clientId:row?.client_id;
  if(!('clientId' in b) && 'holder' in b && b.holder!==row?.holder) {
    const matches=db.prepare('SELECT id,name FROM counterparties').all().filter(c=>norm(c.name)===norm(b.holder));
    id=matches.length===1?matches[0].id:null;
  }
  if(!id){
    if(row && !row.client_id && !('holder' in b) && !('clientId' in b))return;
    fail('Выберите карточку в «Клиенты 360». Если её ещё нет, сначала создайте её.');
  }
  const c=db.prepare('SELECT * FROM counterparties WHERE id=?').get(String(id));
  if(!c)fail('Выбранная карточка не найдена');
  if(row?.client_id && row.client_id!==c.id && b.confirmRelink!==true)fail('Подтвердите перенос объекта к другой карточке',409);
  b.clientId=c.id;b.holder=c.name;
}
