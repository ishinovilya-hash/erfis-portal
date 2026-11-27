import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initCrm,registerCrmRoutes,importCrmDeals,CRM_STAGES} from './crm.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'erfis-crm-test-'));
  const db=new DatabaseSync(join(dir,'test.db'));
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('u1'),('u2');
    CREATE TABLE counterparties(id TEXT PRIMARY KEY,name TEXT); INSERT INTO counterparties VALUES('c1','Client');
    CREATE TABLE objects(id TEXT PRIMARY KEY,holder TEXT); INSERT INTO objects VALUES('o1','Unchanged');
    CREATE TABLE activity(kind TEXT, object_id TEXT, user_id TEXT);`);
  initCrm(db);
  const routes=new Map();let logFails=false;
  registerCrmRoutes({db,route:(method,path,fn)=>routes.set(method+' '+path,fn),
    currentUser:req=>req.auth?{id:'u1',is_manager:req.auth!=='employee'}:null,readBody:async req=>{if(req.body instanceof Error)throw req.body;return req.body;},
    json:(res,status,data)=>Object.assign(res,{status,data}),
    logActivity:(kind,obj,_text,user)=>{if(logFails)throw Error('log failure');db.prepare('INSERT INTO activity VALUES(?,?,?)').run(kind,obj?.id??null,user);}});
  const call=async(method,path,body={},id,query='',auth=true)=>{
    const res={};await routes.get(method+' '+path)({body,auth},res,{id},new URL('http://localhost/'+query));return res;
  };
  const create=async(body={})=>{const r=await call('POST','/api/crm/deals',{client_id:'c1',title:'Deal',responsible_id:'u1',...body});assert.equal(r.status,200,JSON.stringify(r));return r.data.deal;};
  const patch=(d,body)=>call('PATCH','/api/crm/deals/:id',{revision:d.revision,...body},d.id);
  return {db,routes,call,create,patch,failLog:()=>{logFails=true;}};
}

test('additive idempotent schema, authenticated routes, round trip persistence',async t=>{
  const {db,routes,call,create}=fixture(t);
  const before=db.prepare('SELECT * FROM objects').all();initCrm(db);
  for(const key of routes.keys()){const [method,path]=key.split(' ');assert.equal((await call(method,path,{},'missing','',false)).status,401);}
  assert.equal((await call('POST','/api/crm/deals',new Error('bad json'))).status,400);
  assert.equal((await call('POST','/api/crm/deals',new Error('payload too large'))).status,413);
  const d=await create({tags:['a','a'],contact:{name:'Name',source_record:{raw:['cell']}},notes:['note',{text:'second'}],paid:null});
  assert.equal(d.paid,null);assert.equal(d.revision,1);assert.deepEqual(d.tags,['a']);assert.equal(d.tasks.length,1);assert.equal(d.notes.length,2);
  assert.equal(d.tasks[0].assigned_to,'u1');
  assert.deepEqual((await call('GET','/api/crm/deals')).data.deals,[d]);
  assert.equal((await call('GET','/api/crm/deals',{},null,'?client_id=other')).data.deals.length,0);
  assert.deepEqual(db.prepare('SELECT * FROM objects').all(),before);
  assert.equal(db.prepare('SELECT count(*) n FROM counterparties').get().n,1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('stage transition gates and tasks commit together; failed notes/task roll back everything',async t=>{
  const {db,create,patch}=fixture(t);let d=await create({budget:100,duties:50});
  assert.equal((await patch(d,{stage:'offer'})).status,400);
  assert.equal(db.prepare('SELECT revision FROM crm_deals WHERE id=?').get(d.id).revision,1);
  d=(await patch(d,{stage:'offer',next_action:'Call',next_contact:'2026-12-01'})).data.deal;
  assert.equal(d.tasks.filter(x=>x.status==='open').length,2);assert.equal(d.tasks.find(x=>x.stage==='new').status,'open');
  for(const body of [{paid:null},{paid:0,allow_advance:true},{paid:99},{paid:100,executor_id:null},{paid:100,deadline:''}])
    assert.equal((await patch(d,{stage:'work',executor_id:'u2',deadline:'2026-12-02',...body})).status,400);
  const count=db.prepare('SELECT count(*) n FROM crm_tasks').get().n;
  assert.equal((await patch(d,{stage:'work',paid:100,executor_id:'u2',deadline:'2026-12-02',notes:['rollback'],task:{assigned_to:'missing'}})).status,400);
  assert.equal(db.prepare('SELECT count(*) n FROM crm_notes').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM crm_tasks').get().n,count);
  d=(await patch(d,{stage:'work',paid:10,allow_advance:true,executor_id:'u2',deadline:'2026-12-02'})).data.deal;
  assert.equal(d.tasks.find(x=>x.stage==='work').assigned_to,'u2');
  assert.equal((await patch(d,{stage:'lost'})).status,400);
  d=(await patch(d,{stage:'lost',lost_reason:'Client declined'})).data.deal;
  assert.equal(d.tasks.filter(x=>x.status==='open').length,3);
  const full=await create({stage:'work',paid:100,budget:100,duties:500,executor_id:'u2',deadline:'2026-12-01'});assert.equal(full.stage,'work');
  for(const stage of CRM_STAGES.filter(s=>!['offer','work','lost'].includes(s)))assert.equal((await create({stage})).stage,stage);
});

test('validation status, unknown paid distinction, revision conflicts and audit rollback',async t=>{
  const {db,call,create,patch,failLog}=fixture(t);const d=await create();
  for(const body of [{client_id:'no'},{budget:-1},{paid:''},{paid:false},{allow_advance:1},{deadline:'2026-02-30'},{contact:[]},{tags:'tag'},{stage:'no'},{notes:[{}]}])
    assert.equal((await patch(d,body)).status,400,JSON.stringify(body));
  assert.equal((await call('PATCH','/api/crm/deals/:id',{},d.id)).status,409);
  assert.equal((await patch(d,{revision:0})).status,409);
  assert.equal((await patch({...d,id:'missing'},{})).status,404);
  const next=(await patch(d,{paid:0})).data.deal;assert.equal(next.paid,0);
  assert.equal((await patch(d,{title:'stale'})).status,409);
  failLog();assert.equal((await patch(next,{title:'rollback'})).status,500);
  assert.equal(db.prepare('SELECT title FROM crm_deals WHERE id=?').get(d.id).title,'Deal');
});

test('task edits check both revisions; transition wins over stale task completion',async t=>{
  const {call,create,patch}=fixture(t);let d=await create();let task=d.tasks[0];
  assert.equal((await call('PATCH','/api/crm/tasks/:id',{revision:task.revision,status:'done'},task.id)).status,409);
  let r=await call('PATCH','/api/crm/tasks/:id',{revision:task.revision,deal_revision:d.revision,status:'done'},task.id);
  assert.equal(r.status,200);assert.equal(r.data.deal.revision,2);assert.equal(r.data.task.revision,2);
  assert.equal((await patch(d,{title:'stale deal'})).status,409);
  d=r.data.deal;d=(await patch(d,{stage:'contract'})).data.deal;task=d.tasks.find(x=>x.status==='open');
  const transitioned=(await patch(d,{stage:'act_ready'})).data.deal;
  r=await call('PATCH','/api/crm/tasks/:id',{revision:task.revision,deal_revision:d.revision,status:'done'},task.id);assert.equal(r.status,409);
  assert.equal((await call('DELETE','/api/crm/deals/:id',{revision:transitioned.revision},d.id)).status,200);
  assert.equal((await call('PATCH','/api/crm/tasks/:id',{revision:1,deal_revision:transitioned.revision+1},transitioned.tasks.find(x=>x.status==='open').id)).status,409);
});

test('soft trash, restore and snapshot purge protect concurrent deletions and cascade children',async t=>{
  const {db,call,create}=fixture(t);let a=await create({notes:['keep']});let b=await create();
  assert.equal((await call('DELETE','/api/crm/deals/:id',{revision:0},a.id)).status,409);
  a=(await call('DELETE','/api/crm/deals/:id',{revision:a.revision},a.id)).data.deal;
  assert.ok(a.deleted_at);assert.equal((await call('GET','/api/crm/deals')).data.deals.length,1);
  assert.equal((await call('GET','/api/crm/deals',{},null,'?trash=1')).data.deals[0].id,a.id);
  assert.equal((await call('POST','/api/crm/deals/:id/restore',{revision:1},a.id)).status,409);
  a=(await call('POST','/api/crm/deals/:id/restore',{revision:a.revision},a.id)).data.deal;
  assert.equal(a.deleted_at,null);assert.equal(a.notes.length,1);
  a=(await call('DELETE','/api/crm/deals/:id',{revision:a.revision},a.id)).data.deal;
  b=(await call('DELETE','/api/crm/deals/:id',{revision:b.revision},b.id)).data.deal;
  assert.equal((await call('DELETE','/api/crm/trash',{})).status,400);
  assert.equal((await call('DELETE','/api/crm/trash',{deals:[{id:a.id,revision:a.revision},{id:b.id,revision:0}]})).status,409);
  assert.equal(db.prepare('SELECT count(*) n FROM crm_deals').get().n,2);
  const child=await create({parent_deal_id:a.id});
  assert.deepEqual((await call('DELETE','/api/crm/trash',{deals:[{id:a.id,revision:a.revision}]})).data,{deleted:1});
  assert.ok(db.prepare('SELECT * FROM crm_deals WHERE id=?').get(b.id));
  assert.equal(db.prepare('SELECT count(*) n FROM crm_notes WHERE deal_id=?').get(a.id).n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM crm_tasks WHERE deal_id=?').get(a.id).n,0);
  const changed=db.prepare('SELECT * FROM crm_deals WHERE id=?').get(child.id);assert.equal(changed.parent_deal_id,null);assert.equal(changed.revision,2);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('historical import is idempotent, transactional and nests in a caller transaction',async t=>{
  const {db,patch}=fixture(t);
  const record={source_id:'amo:123',client_id:'c1',title:'Historical',stage:'work',notes:['original'],contact:{source_record:{all:'raw'}},created_at:'2020-01-01T00:00:00Z'};
  let r=importCrmDeals(db,[record]);assert.equal(r.imported,1);assert.equal(r.deals[0].paid,null);assert.equal(r.deals[0].tasks.length,0);assert.equal(r.deals[0].created_at,record.created_at);
  r=importCrmDeals(db,[{...record,title:'Must not overwrite'}]);assert.equal(r.skipped,1);assert.equal(r.deals[0].title,'Historical');assert.equal(r.deals[0].notes.length,1);
  assert.equal((await patch(r.deals[0],{title:'Edit imported'})).status,200);
  assert.throws(()=>importCrmDeals(db,[{...record,source_id:'amo:124'},{...record,source_id:'amo:125',client_id:'missing'}]));
  assert.equal(db.prepare('SELECT count(*) n FROM crm_deals').get().n,1);
  db.exec('BEGIN IMMEDIATE');db.exec("INSERT INTO counterparties VALUES('c2','New')");
  importCrmDeals(db,[{...record,source_id:'amo:126',client_id:'c2',stage:'won'}]);db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT count(*) n FROM crm_deals').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM counterparties').get().n,1);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});


test('stage changes preserve manual, generated and imported tasks until explicit completion',async t=>{
  const {db,call,create,patch}=fixture(t);
  let d=await create();
  d=(await patch(d,{task:{title:'Manual follow-up',assigned_to:'u2',due_at:'2026-12-15'}})).data.deal;
  const original=d.tasks;
  for(const stage of ['contract','won','new','lost']) {
    const r=await patch(d,{stage,lost_reason:'Deferred'});assert.equal(r.status,200);
    d=r.data.deal;
    for(const task of original)assert.deepEqual(d.tasks.find(x=>x.id===task.id),task);
  }
  const manual=d.tasks.find(x=>x.title==='Manual follow-up');
  const r=await call('PATCH','/api/crm/tasks/:id',{revision:manual.revision,deal_revision:d.revision,status:'done'},manual.id);
  assert.equal(r.status,200);assert.equal(r.data.task.status,'done');
  assert.equal(r.data.task.revision,manual.revision+1);
  const generated=original.find(x=>x.id!==manual.id);
  assert.deepEqual(r.data.deal.tasks.find(x=>x.id===generated.id),generated);
  const imported=importCrmDeals(db,[{source_id:'amo:manual',client_id:'c1',title:'Imported',stage:'contract',tasks:[{title:'Imported unfinished'}]}]).deals[0];
  const moved=(await patch(imported,{stage:'won'})).data.deal;
  assert.deepEqual(moved.tasks,imported.tasks);
});

test('monthly work register preserves first start, corrections and history after purge',async t=>{
  const {db,call,create,patch}=fixture(t);
  let d=await create({direction:'patents'});
  assert.equal(d.work_started_on,'');
  assert.equal((await call('GET','/api/crm/report')).data.rows.length,0);
  const work={stage:'work',executor_id:'u2',deadline:'2026-12-02',paid:0};
  assert.equal((await patch(d,{...work,task:{assigned_to:'missing'}})).status,400);
  assert.equal(db.prepare('SELECT count(*) n FROM crm_work_register').get().n,0);
  d=(await patch(d,work)).data.deal;
  const started=d.work_started_on;assert.match(started,/^\d{4}-\d{2}-\d{2}$/);
  d=(await patch(d,{stage:'contract'})).data.deal;
  d=(await patch(d,work)).data.deal;assert.equal(d.work_started_on,started);
  assert.equal((await patch(d,{direction:'invalid'})).status,400);
  assert.equal((await patch(d,{work_started_on:'2026-02-30'})).status,400);
  assert.equal((await patch(d,{work_started_on:'9999-12-01'})).status,400);
  assert.equal((await patch(d,{work_started_on:''})).status,400);
  d=(await patch(d,{direction:'software',work_started_on:'2025-02-01',stage:'won'})).data.deal;
  const expected=[{month:'2025-02',direction:'software',count:1}];
  assert.deepEqual(JSON.parse(JSON.stringify((await call('GET','/api/crm/report')).data.rows)),expected);
  const removed=(await call('DELETE','/api/crm/deals/:id',{revision:d.revision},d.id)).data.deal;
  assert.equal((await call('DELETE','/api/crm/trash',{deals:[{id:removed.id,revision:removed.revision}]})).status,200);
  assert.deepEqual(JSON.parse(JSON.stringify((await call('GET','/api/crm/report')).data.rows)),expected);
  initCrm(db);assert.equal(db.prepare('SELECT count(*) n FROM crm_work_register').get().n,1);
});

test('historical work dates stay unknown until supplied and directions can be filled later',async t=>{
  const {db,call,patch}=fixture(t);
  importCrmDeals(db,[{client_id:'c1',title:'Imported',stage:'work',source_id:'amo:987654'}]);
  let d=(await call('GET','/api/crm/deals')).data.deals[0];
  assert.equal(d.work_started_on,'');assert.equal((await call('GET','/api/crm/report')).data.missingDate,1);
  d=(await patch(d,{work_started_on:'2025-03-10'})).data.deal;
  assert.equal((await call('GET','/api/crm/report')).data.rows[0].direction,'');
  d=(await patch(d,{direction:'mincifry'})).data.deal;
  const report=(await call('GET','/api/crm/report')).data;
  assert.equal(report.missingDate,0);assert.equal(report.rows[0].direction,'mincifry');assert.equal(report.rows[0].count,1);
});

test('payment starts work atomically, computes working days and never resets first date',async t=>{
 const {db,create,call,patch}=fixture(t);let d=await create({budget:100,direction:'patents'});
 const body={revision:d.revision,paid_on:'2026-11-20',paid:100,work_days:5,executor_id:'u2',responsible_id:'u1'};
 assert.equal((await call('POST','/api/crm/deals/:id/payment',{...body,paid:10},d.id)).status,400);
 assert.equal((await call('POST','/api/crm/deals/:id/payment',{...body,work_days:1.5},d.id)).status,400);
 assert.equal(db.prepare('SELECT count(*) n FROM crm_work_register').get().n,0);
 let r=await call('POST','/api/crm/deals/:id/payment',body,d.id);assert.equal(r.status,200,JSON.stringify(r));d=r.data.deal;
 assert.equal(d.stage,'work');assert.equal(d.deadline,'2026-11-27');assert.equal(d.work_started_on,'2026-11-20');assert.equal(d.paid_on,'2026-11-20');
 assert.equal(d.tasks.find(t=>t.stage==='work').due_at,'2026-11-27');
 assert.equal((await call('POST','/api/crm/deals/:id/payment',{...body,revision:d.revision},d.id)).status,400);
 assert.equal((await patch(d,{paid_on:'2026-11-21'})).status,400);
 const advanced=await create({budget:100});r=await call('POST','/api/crm/deals/:id/payment',{...body,revision:advanced.revision,paid:10,allow_advance:true},advanced.id);assert.equal(r.status,200);
 assert.equal((await call('GET','/api/crm/mail',{},null,'','employee')).status,403);
 assert.equal((await call('POST','/api/crm/mail',{from:'client@erfis.ru',password:'test'},null,'','employee')).status,403);
});

test('planned work days save before payment and feed the paid deadline without starting work early',async t=>{
 const {db,call,create,patch}=fixture(t);let d=await create({work_days:10,budget:100});
 assert.equal(d.work_days,10);assert.equal(d.paid_on,'');assert.equal(d.work_started_on,'');assert.equal(d.deadline,'');
 assert.equal(db.prepare('SELECT count(*) n FROM crm_work_register').get().n,0);
 for(const work_days of [-1,1.5,501,'10'])assert.equal((await patch(d,{work_days})).status,400);
 d=(await patch(d,{work_days:5})).data.deal;assert.equal(d.deadline,'');
 let r=await call('POST','/api/crm/deals/:id/payment',{revision:d.revision,paid_on:'2026-11-20',paid:100,work_days:d.work_days,responsible_id:'u1',executor_id:'u1'},d.id);
 assert.equal(r.status,200);d=r.data.deal;assert.equal(d.deadline,'2026-11-27');
 assert.equal((await patch(d,{work_days:0})).status,400);
 d=(await patch(d,{work_days:6})).data.deal;assert.equal(d.deadline,'2026-11-30');assert.equal(d.work_started_on,'2026-11-20');
});

test('additional directions persist in deals and monthly reporting',async t=>{
 const {call,create,patch}=fixture(t);
 for(const direction of ['industrial_designs','litigation_patents','litigation_marks_designs']){
  let d=await create({direction,work_started_on:'2026-11-01'});
  assert.equal(d.direction,direction);
  d=(await patch(d,{title:'Updated '+direction})).data.deal;assert.equal(d.direction,direction);
 }
 const report=(await call('GET','/api/crm/report')).data;
 for(const direction of ['industrial_designs','litigation_patents','litigation_marks_designs'])assert.equal(report.rows.find(r=>r.month==='2026-11'&&r.direction===direction)?.count,1);
});

test('monthly report is restricted to manager while employees retain deal access',async t=>{
 const {call,create}=fixture(t);await create({direction:'patents',work_started_on:'2026-11-01'});
 const denied=await call('GET','/api/crm/report',{},null,'','employee');
 assert.equal(denied.status,403);assert.equal(denied.data.rows,undefined);
 assert.equal((await call('GET','/api/crm/report')).status,200);
 assert.equal((await call('GET','/api/crm/deals',{},null,'','employee')).status,200);
});
