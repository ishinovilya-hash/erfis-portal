import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {contractDefaults,moveRefused,importRegistryUpdate} from './registry-update.js';
process.env.ERFIS_DATA_DIR=mkdtempSync(join(tmpdir(),'erfis-registry-test-'));
const {db}=await import('./db.js');
const {rowToApi}=await import('./lib.js');
function add(id,type='trademark',reg='123',extra='{}'){
 db.prepare('INSERT INTO objects(id,type,holder,name,reg_number,extra,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,type,'Владелец','Объект',reg,extra,'2026-01-01','2026-01-01');
}
test('Moscow date, kinds, max number and reserved trash numbers',()=>{
 add('c1','contract','49/2026');add('c2','contract','Ф6/2026');add('c3','contract','А1/2026');
 db.prepare("UPDATE objects SET deleted_at='2026-01-01' WHERE id='c1'").run();
 const now=new Date('2026-10-20T22:30:00Z');
 assert.deepEqual(contractDefaults(db,'legal',now),{regNumber:'50/2026',priorityDate:'2026-10-21'});
 assert.equal(contractDefaults(db,'individual',now).regNumber,'Ф7/2026');
 assert.equal(contractDefaults(db,'subscription',now).regNumber,'А2/2026');
 assert.equal(contractDefaults(db,'legal',new Date('2026-12-31T22:30:00Z')).regNumber,'1/2027');
});
test('refuse and return each IP type without losing data or reminders',()=>{
 for(const type of ['trademark','patent','software']){
  const id='t-'+type;add(id,type);
  const rem=JSON.stringify({date:'2020-01-01',time:'10:00'});
  db.prepare('UPDATE objects SET reminder=?,notes=? WHERE id=?').run(rem,'Сохранить',id);
  moveRefused(db,id,true,'test');
  let row=db.prepare('SELECT * FROM objects WHERE id=?').get(id);
  assert.equal(rowToApi(row).flagged,false);assert.equal(row.reminder,rem);
  moveRefused(db,id,false,'test');row=db.prepare('SELECT * FROM objects WHERE id=?').get(id);
  assert.equal(row.type,type);assert.equal(row.notes,'Сохранить');assert.equal(row.refused_at,null);assert.equal(rowToApi(row).flagged,true);
 }
 assert.throws(()=>moveRefused(db,'c2',true,'test'));
});
test('preview, identity match, backup and idempotence',()=>{
 const p={format:'erfis-registry-update-v1',id:'test-import',refused:[{sourceKey:'a',type:'trademark',name:'Объект',holder:'Владелец',regNumber:'123',sourceRow:{note:'original'}}],price:[{category:'A',name:'Услуга',fee:'10',duty:'20',total:'30',note:''}]};
 assert.equal(importRegistryUpdate(db,p,'test',true).moved,1);
 assert.equal(db.prepare("SELECT refused_at FROM objects WHERE id='t-trademark'").get().refused_at,null);
 assert.equal(importRegistryUpdate(db,p,'test').moved,1);
 assert.equal(importRegistryUpdate(db,p,'test').alreadyApplied,true);
 assert.ok(db.prepare("SELECT v FROM meta WHERE k='registry-update:test-import:backup'").get());
 const conflicting={...p,id:'conflict'};add('duplicate');
 assert.equal(importRegistryUpdate(db,conflicting,'test').conflicts.length,1);
 assert.equal(db.prepare("SELECT v FROM meta WHERE k='registry-update:conflict'").get(),undefined);
});
test('prepared real file passes preview or reports explicit source conflicts',()=>{
 if(!process.env.UPDATE_FILE)return;
 db.prepare('DELETE FROM objects').run();
 const p=JSON.parse(readFileSync(process.env.UPDATE_FILE));
 const result=importRegistryUpdate(db,p,'test',true);
 console.log('SOURCE PREVIEW',JSON.stringify(result));
 assert.equal(p.refused.length,427);assert.equal(p.price.length,61);
 assert.equal(result.conflicts.length,0);
 assert.equal(db.prepare('SELECT count(*) n FROM objects').get().n,0);
});
