import {addWorkdays,deadlineAlert} from './work-calendar.js';
import {initCrmMail,mailStatus,saveMailConfig} from './crm-mail.js';
import { randomUUID } from 'node:crypto';

export const CRM_DIRECTIONS = ['', 'patents', 'trademarks', 'mincifry', 'software', 'industrial_designs', 'litigation_patents', 'litigation_marks_designs'];
const moscowDay = () => new Date(Date.now()+10800000).toISOString().slice(0,10);
export const CRM_STAGES = Object.freeze(['new','offer','contract','work','act_ready','act_sent','won','lost']);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const now = () => new Date().toISOString();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (o,k) => Object.hasOwn(o,k);
const terminal = stage => stage === 'won' || stage === 'lost';

// Savepoints also allow an importer to atomically create counterparties and deals.
function atomic(db, fn) {
  const name = 'crm_' + randomUUID().replaceAll('-','');
  db.exec(`SAVEPOINT ${name}`);
  try { const result = fn(); db.exec(`RELEASE ${name}`); return result; }
  catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
}

export function initCrm(db) {
  atomic(db, () => db.exec(`
    CREATE TABLE IF NOT EXISTS crm_deals (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES counterparties(id),
      title TEXT NOT NULL, responsible_id TEXT REFERENCES users(id), executor_id TEXT REFERENCES users(id),
      service TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
      budget REAL NOT NULL DEFAULT 0 CHECK(budget>=0), duties REAL NOT NULL DEFAULT 0 CHECK(duties>=0),
      paid REAL CHECK(paid>=0), allow_advance INTEGER NOT NULL DEFAULT 0 CHECK(allow_advance IN (0,1)),
      deadline TEXT NOT NULL DEFAULT '', next_action TEXT NOT NULL DEFAULT '', next_contact TEXT NOT NULL DEFAULT '',
      contact TEXT NOT NULL DEFAULT '{}', stage TEXT NOT NULL DEFAULT 'new'
        CHECK(stage IN ('new','offer','contract','work','act_ready','act_sent','won','lost')),
      revision INTEGER NOT NULL DEFAULT 1, deleted_at TEXT, source_id TEXT UNIQUE,
      lost_reason TEXT NOT NULL DEFAULT '', parent_deal_id TEXT REFERENCES crm_deals(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crm_client ON crm_deals(client_id,deleted_at);
    CREATE INDEX IF NOT EXISTS idx_crm_stage ON crm_deals(deleted_at,stage);
    CREATE TABLE IF NOT EXISTS crm_tasks (
      id TEXT PRIMARY KEY, deal_id TEXT NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
      title TEXT NOT NULL, assigned_to TEXT REFERENCES users(id), due_at TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),
      stage TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crm_task_deal ON crm_tasks(deal_id);
    CREATE TABLE IF NOT EXISTS crm_notes (
      id TEXT PRIMARY KEY, deal_id TEXT NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
      text TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crm_note_deal ON crm_notes(deal_id);
  `));
  atomic(db, () => {
    const columns=new Set(db.prepare('PRAGMA table_info(crm_deals)').all().map(c=>c.name));
    if(!columns.has('direction'))db.exec("ALTER TABLE crm_deals ADD COLUMN direction TEXT NOT NULL DEFAULT ''");
    if(!columns.has('work_started_on'))db.exec("ALTER TABLE crm_deals ADD COLUMN work_started_on TEXT NOT NULL DEFAULT ''");
    if(!columns.has('paid_on'))db.exec("ALTER TABLE crm_deals ADD COLUMN paid_on TEXT NOT NULL DEFAULT ''");
    if(!columns.has('work_days'))db.exec("ALTER TABLE crm_deals ADD COLUMN work_days INTEGER NOT NULL DEFAULT 0");
    initCrmMail(db);
    // Independent from deal deletion: a recorded start remains in historical totals.
    db.exec(`CREATE TABLE IF NOT EXISTS crm_work_register (
      deal_id TEXT PRIMARY KEY, direction TEXT NOT NULL, started_on TEXT NOT NULL,
      recorded_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
  });
}

function text(value, field, limit = 2000) {
  if (typeof value !== 'string' || value.length > limit) fail('Неверное поле: '+field);
  return value.trim();
}
function date(value, field) {
  const v = text(value,field,40);
  if (v && (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v.slice(0,10)).toISOString().slice(0,10)!==v.slice(0,10))) fail('Неверная дата: '+field);
  return v;
}
function reference(db, table, value, field, required = false) {
  if (value === null || value === '') { if(required)fail('Укажите '+field); return null; }
  if (typeof value !== 'string' || !db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(value)) fail('Не найдено: '+field);
  return value;
}
function revision(expected, row) {
  if (!Number.isSafeInteger(expected) || expected !== row.revision) fail('Запись изменена. Обновите данные.',409);
}
function rawDeal(db,id) {
  const row = db.prepare('SELECT * FROM crm_deals WHERE id=?').get(id);
  if (!row) fail('Сделка не найдена',404);
  return row;
}
function dealApi(db,row) {
  return {...row, deadline_alert:deadlineAlert(row), allow_advance:!!row.allow_advance, tags:JSON.parse(row.tags), contact:JSON.parse(row.contact),
    tasks:db.prepare('SELECT * FROM crm_tasks WHERE deal_id=? ORDER BY created_at,id').all(row.id),
    notes:db.prepare('SELECT * FROM crm_notes WHERE deal_id=? ORDER BY rowid').all(row.id)};
}
const fields = ['paid_on','work_days','direction','work_started_on','client_id','title','responsible_id','executor_id','service','source','tags','budget','duties','paid','allow_advance','deadline','next_action','next_contact','contact','stage','source_id','lost_reason','parent_deal_id'];
function values(db,b,old) {
  if (!object(b)) fail('Ожидается объект');
  const d = {...{paid_on:'',work_days:0,direction:'',work_started_on:'',responsible_id:null,executor_id:null,service:'',source:'',tags:[],budget:0,duties:0,paid:null,allow_advance:false,deadline:'',next_action:'',next_contact:'',contact:{},stage:'new',source_id:null,lost_reason:'',parent_deal_id:null},
    ...(old ? {...old,tags:JSON.parse(old.tags),contact:JSON.parse(old.contact),allow_advance:!!old.allow_advance}:{} )};
  for (const key of fields) if(own(b,key)) d[key]=b[key];
  d.client_id=reference(db,'counterparties',d.client_id,'client_id',true);
  for(const key of ['responsible_id','executor_id']) d[key]=reference(db,'users',d[key],key);
  d.parent_deal_id=reference(db,'crm_deals',d.parent_deal_id,'parent_deal_id');
  if (old && d.parent_deal_id) {
    let parent=d.parent_deal_id;
    const seen=new Set([old.id]);
    while(parent) { if(seen.has(parent))fail('Циклическая связь сделок'); seen.add(parent); parent=rawDeal(db,parent).parent_deal_id; }
  }
  for(const key of ['title','service','source','next_action','lost_reason']) d[key]=text(d[key],key);
  if(!d.title)fail('Укажите название');
  d.paid_on=date(d.paid_on,'paid_on');
  if(d.paid_on&&(!/^\d{4}-\d{2}-\d{2}$/.test(d.paid_on)||d.paid_on>moscowDay()))fail('Неверная дата оплаты');
  if(!Number.isInteger(d.work_days)||d.work_days<0||d.work_days>500)fail('Срок: от 1 до 500 рабочих дней');
  if(old?.paid_on&&d.paid_on!==old.paid_on)fail('Дата запуска по оплате уже сохранена. Для изменения срока используйте дату окончания');
  if(old?.paid_on&&old.work_days&&!d.work_days)fail('Укажите срок выполнения: работа уже запущена по оплате');
  if(d.paid_on&&d.work_days&&(!old?.paid_on||old.work_days!==d.work_days))d.deadline=addWorkdays(d.paid_on,d.work_days);

  if(!CRM_DIRECTIONS.includes(d.direction))fail('Неверное направление услуги');
  d.work_started_on=date(d.work_started_on,'work_started_on');
  if(d.work_started_on && (!/^\d{4}-\d{2}-\d{2}$/.test(d.work_started_on)||d.work_started_on>moscowDay()))fail('Дата передачи в работу не может быть будущей');
  if(old?.work_started_on&&!d.work_started_on)fail('Укажите дату передачи в работу; её можно исправить, но нельзя удалить');
  for(const key of ['deadline','next_contact'])d[key]=date(d[key],key);
  for(const key of ['budget','duties','paid']) {
    if(key==='paid' && d[key]===null)continue;
    if(typeof d[key]!=='number'||!Number.isFinite(d[key])||d[key]<0||d[key]>Number.MAX_SAFE_INTEGER)fail('Неверная сумма: '+key);
  }
  if(typeof d.allow_advance!=='boolean')fail('allow_advance должен быть boolean');
  d.allow_advance=Number(d.allow_advance);
  if(!CRM_STAGES.includes(d.stage))fail('Неверный этап');
  if(!Array.isArray(d.tags)||d.tags.length>100)fail('Неверные теги');
  d.tags=JSON.stringify([...new Set(d.tags.map(t=>text(t,'tags',200)))]);
  if(!object(d.contact))fail('Неверный контакт');
  d.contact=JSON.stringify(d.contact);
  if(d.contact.length>200000)fail('Контакт слишком большой');
  if(d.source_id!==null) { d.source_id=text(d.source_id,'source_id',200); if(!d.source_id)fail('Пустой source_id'); }
  if(old && d.source_id!==old.source_id)fail('source_id нельзя изменить');
  if(d.source_id && db.prepare('SELECT id FROM crm_deals WHERE source_id=? AND id<>?').get(d.source_id,old?.id||''))fail('source_id уже существует',409);
  return d;
}
function gate(d, requirePayment=false, previousStage=null) {
  if(d.stage==='offer' && !['contract','work','act_ready','act_sent','won','lost'].includes(previousStage) && (!d.next_action || !d.next_contact))fail('Укажите следующее действие и дату контакта');
  if(d.stage==='work'&&requirePayment) {
    if(!d.executor_id||!d.deadline)fail('Укажите исполнителя и срок');
    if(!(d.paid!==null && (d.paid>=d.budget || (d.allow_advance && d.paid>0))))fail('Нужна полная оплата или согласованный оплаченный аванс');
  }
  if(d.stage==='lost'&&!d.lost_reason)fail('Укажите причину отказа');
}
function taskValues(db,b,defaults) {
  if(!object(b))fail('Неверная задача');
  const d={...defaults};
  for(const k of ['title','assigned_to','due_at','status'])if(own(b,k))d[k]=b[k];
  d.title=text(d.title,'task.title'); if(!d.title)fail('Укажите название задачи');
  d.assigned_to=reference(db,'users',d.assigned_to,'assigned_to');
  d.due_at=date(d.due_at,'due_at');
  if(!['open','done'].includes(d.status))fail('Неверный статус задачи');
  return d;
}
function addTask(db,deal,b={}) {
  const defaults={title:deal.next_action||deal.title,assigned_to:deal.stage==='work'?deal.executor_id:deal.responsible_id,due_at:deal.stage==='work'?deal.deadline:deal.next_contact,status:'open'};
  const d=taskValues(db,b,defaults),at=now();
  db.prepare('INSERT INTO crm_tasks(id,deal_id,title,assigned_to,due_at,status,stage,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('ct-'+randomUUID(),deal.id,d.title,d.assigned_to,d.due_at,d.status,deal.stage,at,at);
}
function saveNotes(db,id,notes) {
  if(typeof notes==='string')notes=notes?[notes]:[];
  if(!Array.isArray(notes)||notes.length>1000)fail('Неверные заметки');
  const rows=notes.map(n=>({text:text(typeof n==='string'?n:n?.text,'notes',50000),created_at:object(n)&&n.created_at?date(n.created_at,'notes.created_at'):now()}));
  db.prepare('DELETE FROM crm_notes WHERE deal_id=?').run(id);
  for(const n of rows)if(n.text)db.prepare('INSERT INTO crm_notes(id,deal_id,text,created_at) VALUES(?,?,?,?)').run('cn-'+randomUUID(),id,n.text,n.created_at);
}
function save(db,b,id=null,historical=false) {
  const old=id?rawDeal(db,id):null;
  if(old) { revision(b.revision,old); if(old.deleted_at)fail('Сделка в корзине',409); }
  const d=values(db,b,old),at=now(),cid=id||'cd-'+randomUUID();
  // Existing historical rows can be edited without retroactively imposing entry gates.
  if(!historical && (!old||old.stage!==d.stage))gate(d,false,old?.stage);
  if(!historical && d.stage==='work' && d.paid_on && !d.work_started_on)d.work_started_on=d.paid_on;
  if(old) db.prepare(`UPDATE crm_deals SET ${fields.map(k=>k+'=?').join(',')},revision=revision+1,updated_at=? WHERE id=?`).run(...fields.map(k=>d[k]),at,cid);
  else {
    const created=historical&&b.created_at?date(b.created_at,'created_at'):at;
    const updated=historical&&b.updated_at?date(b.updated_at,'updated_at'):at;
    db.prepare(`INSERT INTO crm_deals(id,${fields.join(',')},created_at,updated_at) VALUES(${Array(fields.length+3).fill('?').join(',')})`).run(cid,...fields.map(k=>d[k]),created,updated);
  }
  if(d.work_started_on)db.prepare(`INSERT INTO crm_work_register(deal_id,direction,started_on,recorded_at,updated_at)
    VALUES(?,?,?,?,?) ON CONFLICT(deal_id) DO UPDATE SET direction=excluded.direction,started_on=excluded.started_on,updated_at=excluded.updated_at`)
    .run(cid,d.direction,d.work_started_on,at,at);
  if(own(b,'notes'))saveNotes(db,cid,b.notes);
  const row=rawDeal(db,cid);
  if(historical) {
    if(own(b,'tasks')) { if(!Array.isArray(b.tasks))fail('Неверные задачи'); for(const task of b.tasks)addTask(db,row,task); }
  } else if(!old || old.stage!==row.stage) {
    // Moving a deal is not evidence that its outstanding work was completed.
    // Preserve all existing tasks; only an explicit task PATCH changes their status.
    if(!terminal(row.stage))addTask(db,row,b.task??{});
    else if(own(b,'task'))fail('На закрытом этапе новая задача недопустима');
  } else if(own(b,'task'))addTask(db,row,b.task);
  return dealApi(db,row);
}

// Trusted, already-mapped amo records only. Existing source IDs are never overwritten.
// No historical stage gates or synthetic tasks; paid defaults to unknown (null).
export function importCrmDeals(db,deals) {
  if(!Array.isArray(deals))fail('Ожидается массив сделок');
  return atomic(db,()=>{
    const result={imported:0,skipped:0,deals:[]};
    for(const b of deals) {
      if(!object(b)||typeof b.source_id!=='string'||!/^amo:\S+$/.test(b.source_id))fail('Укажите source_id amo:<id>');
      const old=db.prepare('SELECT * FROM crm_deals WHERE source_id=?').get(b.source_id);
      if(old) { result.skipped++; result.deals.push(dealApi(db,old)); }
      else { result.deals.push(save(db,b,null,true)); result.imported++; }
    }
    return result;
  });
}

export function registerCrmRoutes({route,db,json,readBody,currentUser,logActivity}) {
  const register=(method,path,fn)=>route(method,path,async(req,res,p={},url)=>{
    const user=currentUser(req); if(!user)return json(res,401,{error:'auth'});
    try {
      const b=method==='GET'?null:await readBody(req);
      if(method!=='GET'&&!object(b))fail('Ожидается объект');
      const result=method==='GET'?fn(b,p,url,user):atomic(db,()=>fn(b,p,url,user));
      return json(res,200,result);
    }catch(e){
      const status=e.status || (e instanceof SyntaxError || e.message==='bad json' ? 400 : e.message==='payload too large' ? 413 : 500);
      return json(res,status,{error:status<500?e.message:'Ошибка CRM'});
    }
  });
  const log=(kind,deal,user)=>logActivity(kind,deal?{id:deal.id,type:'crm_deal'}:null,deal?deal.title:'Очищена корзина CRM',user.id);
  register('GET','/api/crm/deadline',(_b,_p,url)=>{
    const days=Number(url.searchParams.get('days'));if(!Number.isInteger(days)||days<1||days>500)fail('Укажите от 1 до 500 рабочих дней');
    return {deadline:addWorkdays(url.searchParams.get('date')||'',days)};
  });
  register('GET','/api/crm/mail',(_b,_p,_url,user)=>{if(!user.is_manager)fail('Только руководителю',403);return {...mailStatus(),failed:db.prepare("SELECT count(*) n FROM crm_mail_deliveries WHERE status='failed'").get().n};});
  register('POST','/api/crm/mail',(b,_p,_url,user)=>{if(!user.is_manager)fail('Только руководителю',403);return saveMailConfig(b);});
  register('POST','/api/crm/deals/:id/payment',(b,p,_url,user)=>{
    const old=rawDeal(db,p.id);revision(b.revision,old);
    if(old.deleted_at||terminal(old.stage)||['act_ready','act_sent'].includes(old.stage))fail('Работа уже завершена или сделка в отстойнике');
    if(old.paid_on)fail('Оплата для запуска уже отмечена. Измените сумму или срок в карточке');
    if(!Number.isInteger(b.work_days)||b.work_days<1||b.work_days>500)fail('Укажите срок в рабочих днях');
    const paymentDate=b.paid_on||moscowDay();
    const deadline=addWorkdays(paymentDate,b.work_days);
    const patch={revision:b.revision,stage:'work',paid_on:paymentDate,work_days:b.work_days,paid:b.paid,allow_advance:b.allow_advance===true,
      executor_id:b.executor_id,responsible_id:b.responsible_id||old.responsible_id,deadline,
      work_started_on:old.work_started_on||paymentDate};
    if(!patch.responsible_id)fail('Укажите ответственного для напоминаний');
    gate({...old,...patch},true);
    const deal=save(db,patch,old.id);log('crm_payment',deal,user);return {deal};
  });
  register('GET','/api/crm/report',(_b,_p,_url,user)=>{
    if(!user.is_manager)fail('Только руководителю',403);
    return {
    month:moscowDay().slice(0,7),mailConfigured:mailStatus().configured,
    rows:db.prepare("SELECT substr(started_on,1,7) month,direction,count(*) count FROM crm_work_register GROUP BY month,direction ORDER BY month DESC").all(),
    missingDate:db.prepare("SELECT count(*) n FROM crm_deals WHERE deleted_at IS NULL AND stage IN ('work','act_ready','act_sent','won') AND work_started_on='' ").get().n
  };});
  register('GET','/api/crm/deals',(_b,_p,url)=>{
    const query=url?.searchParams||new URLSearchParams();
    let sql='SELECT * FROM crm_deals WHERE deleted_at IS '+(query.get('trash')==='1'?'NOT NULL':'NULL');
    const args=[];
    for(const key of ['client_id','stage','responsible_id','executor_id'])if(query.has(key)){sql+=' AND '+key+'=?';args.push(query.get(key));}
    return {deals:db.prepare(sql+' ORDER BY updated_at DESC,id').all(...args).map(row=>dealApi(db,row))};
  });
  register('POST','/api/crm/deals',(b,_p,_url,user)=>{const deal=save(db,b);log('crm_create',deal,user);return {deal};});
  register('POST','/api/crm/deals/:id/archive',(b,p,_url,user)=>{
    const old=rawDeal(db,p.id);revision(b.revision,old);if(old.deleted_at)fail('Сделка уже в отстойнике',409);
    const reason=old.stage==='new'?'':text(b.reason??'','reason');
    if(old.stage!=='new'&&!reason)fail('Укажите причину отказа');
    db.prepare('UPDATE crm_deals SET lost_reason=?,deleted_at=?,revision=revision+1,updated_at=? WHERE id=?').run(reason,now(),now(),p.id);
    const deal=dealApi(db,rawDeal(db,p.id));log('crm_refused',deal,user);return {deal};
  });
  register('POST','/api/crm/deals/:id/purge-new',(b,p,_url,user)=>{
    const old=rawDeal(db,p.id);revision(b.revision,old);
    if(old.stage!=='new'||old.deleted_at)fail('Безвозвратно удалить здесь можно только новый лид',409);
    if(db.prepare('SELECT deal_id FROM crm_work_register WHERE deal_id=?').get(p.id))fail('У сделки есть история начала работ; переместите её в отстойник',409);
    db.prepare('UPDATE crm_deals SET parent_deal_id=NULL,revision=revision+1,updated_at=? WHERE parent_deal_id=?').run(now(),p.id);
    db.prepare('DELETE FROM crm_tasks WHERE deal_id=?').run(p.id);
    db.prepare('DELETE FROM crm_notes WHERE deal_id=?').run(p.id);
    db.prepare('DELETE FROM crm_deals WHERE id=?').run(p.id);
    log('crm_purge',null,user);return {deleted:1};
  });
  register('POST','/api/crm/deals/:id/notes',(b,p,_url,user)=>{
    const old=rawDeal(db,p.id);revision(b.revision,old);if(old.deleted_at)fail('Сделка в отстойнике',409);
    const note=text(b.text,'text',50000);if(!note)fail('Введите примечание');
    const at=now();
    db.prepare('INSERT INTO crm_notes(id,deal_id,text,created_at) VALUES(?,?,?,?)').run('cn-'+randomUUID(),p.id,note,at);
    db.prepare('UPDATE crm_deals SET revision=revision+1,updated_at=? WHERE id=?').run(at,p.id);
    const deal=dealApi(db,rawDeal(db,p.id));log('crm_note',deal,user);return {deal};
  });
  register('PATCH','/api/crm/deals/:id',(b,p,_url,user)=>{const deal=save(db,b,p.id);log('crm_edit',deal,user);return {deal};});
  for(const [method,path,restore] of [['DELETE','/api/crm/deals/:id',false],['POST','/api/crm/deals/:id/restore',true]])
    register(method,path,(b,p,_url,user)=>{
      const old=rawDeal(db,p.id);revision(b.revision,old);
      if(restore?!old.deleted_at:!!old.deleted_at)fail('Состояние корзины изменено',409);
      db.prepare('UPDATE crm_deals SET deleted_at=?,revision=revision+1,updated_at=? WHERE id=?').run(restore?null:now(),now(),p.id);
      const deal=dealApi(db,rawDeal(db,p.id));log(restore?'crm_restore':'crm_delete',deal,user);return {deal};
    });
  register('DELETE','/api/crm/trash',(b,_p,_url,user)=>{
    if(!Array.isArray(b.deals)||b.deals.length>10000)fail('Передайте снимок корзины deals:[{id,revision}]');
    const ids=new Set();
    for(const item of b.deals) {
      if(!object(item)||typeof item.id!=='string'||ids.has(item.id))fail('Неверный снимок корзины');
      ids.add(item.id);
      const row=db.prepare('SELECT * FROM crm_deals WHERE id=?').get(item.id);
      if(!row||!row.deleted_at)fail('Корзина изменена',409);
      revision(item.revision,row);
    }
    // Bump surviving children whose relationship changes through ON DELETE SET NULL.
    for(const id of ids)db.prepare('UPDATE crm_deals SET parent_deal_id=NULL,revision=revision+1,updated_at=? WHERE parent_deal_id=?').run(now(),id);
    for(const id of ids) {
      db.prepare('DELETE FROM crm_tasks WHERE deal_id=?').run(id);
      db.prepare('DELETE FROM crm_notes WHERE deal_id=?').run(id);
      db.prepare('DELETE FROM crm_deals WHERE id=?').run(id);
    }
    log('crm_purge',null,user);return {deleted:ids.size};
  });
  register('PATCH','/api/crm/tasks/:id',(b,p,_url,user)=>{
    const old=db.prepare('SELECT * FROM crm_tasks WHERE id=?').get(p.id);if(!old)fail('Задача не найдена',404);
    const deal=rawDeal(db,old.deal_id);revision(b.revision,old);revision(b.deal_revision,deal);
    if(deal.deleted_at)fail('Сделка в корзине',409);
    const t=taskValues(db,b,old),at=now();
    db.prepare('UPDATE crm_tasks SET title=?,assigned_to=?,due_at=?,status=?,revision=revision+1,updated_at=? WHERE id=?').run(t.title,t.assigned_to,t.due_at,t.status,at,p.id);
    db.prepare('UPDATE crm_deals SET revision=revision+1,updated_at=? WHERE id=?').run(at,deal.id);
    log('crm_task',deal,user);
    return {task:db.prepare('SELECT * FROM crm_tasks WHERE id=?').get(p.id),deal:dealApi(db,rawDeal(db,deal.id))};
  });
}
