import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {initClients360} from './clients360.js';
process.env.ERFIS_DATA_DIR=mkdtempSync(join(tmpdir(),'erfis-clients-test-'));
delete process.env.ERFIS_DB;
const {db,seedUsers}=await import('./db.js');seedUsers();
db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('local-test','u_ishinov','2026-01-01','2026-01-01');
const add=db.prepare('INSERT INTO objects(id,type,holder,name,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
add.run('legacy-tm','trademark','ООО Тест','Знак','Сохранить','2026-01-01','2026-01-01');
add.run('legacy-pt','patent','ооо тест','Патент','','2026-01-01','2026-01-01');
add.run('legacy-other','software','Тест, ООО','Программа','','2026-01-01','2026-01-01');
db.prepare('INSERT INTO clients VALUES(?,?,?,?,?)').run('ооо тест','ООО Тест','https://example.com','2026-01-01',null);
test('additive, exact-name migration, idempotence and foreign key',()=>{
  const before=db.prepare('SELECT * FROM objects').all();
  initClients360(db);
  assert.equal(db.prepare('SELECT count(*) n FROM counterparties').get().n,2);
  const after=db.prepare('SELECT * FROM objects').all();
  for(let i=0;i<before.length;i++)for(const k of Object.keys(before[i]))assert.equal(after[i][k],before[i][k]);
  assert.equal(after[0].client_id,after[1].client_id);assert.notEqual(after[0].client_id,after[2].client_id);
  assert.equal(db.prepare('SELECT website FROM counterparties WHERE id=?').get(after[0].client_id).website,'https://example.com');
  initClients360(db);assert.equal(db.prepare('SELECT count(*) n FROM counterparties').get().n,2);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
});
test('uniform clients, registry links, no copies, contracts, contacts and concurrency',async()=>{
  const child=spawn(process.execPath,['server.js'],{cwd:import.meta.dirname,env:{...process.env,PORT:'18751'},stdio:'pipe'});
  let output='';child.stderr.on('data',d=>output+=d);
  const request=async(path,method='GET',body,token='local-test')=>{
    const r=await fetch('http://127.0.0.1:18751/api'+path,{signal:AbortSignal.timeout(3000),method,headers:{cookie:'sid='+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    return {status:r.status,data:await r.json()};
  };
  try{
    let ready=false;for(let i=0;i<50;i++){try{await request('/health');ready=true;break;}catch{await delay(100);}}
    assert.ok(ready,output);
    for(const [path,method] of [['/clients','GET'],['/clients','POST'],['/clients/none','PATCH']])assert.equal((await request(path,method,method==='GET'?undefined:{name:'x'},'bad')).status,401);
    const client=(await request('/clients','POST',{name:'Заказчик',inn:'7701234567',opf:'ООО',contacts:[{name:'Катя',email:'test@example.com',phone:'+7 000',telegram:'@katya'}]})).data.client;
    assert.ok(client.id);assert.equal(client.contacts.length,1);
    assert.equal((await request('/clients','POST',{name:'Другой',inn:client.inn})).status,409);
    assert.equal((await request('/clients','POST',{name:'заказчик'})).status,409);
    assert.equal((await request('/clients','POST',{name:'Bad',inn:'123'})).status,400);
    const holder=(await request('/clients','POST',{name:'Владелец',opf:'ИП',inn:'123456789012'})).data.client;
    assert.ok(holder.id);
    assert.equal(holder.kind,undefined);
    assert.deepEqual((await request('/clients/'+holder.id)).data.objects.contract,[]);
    const total=db.prepare('SELECT count(*) n FROM objects').get().n;
    for(const type of ['trademark','patent','software']){
      const result=await request('/objects','POST',{type,clientId:holder.id,name:'Название '+type,regNumber:'100'});
      assert.equal(result.status,200,JSON.stringify(result.data));const o=result.data.object;
      assert.equal(o.holder,holder.name);assert.equal(o.clientId,holder.id);
      assert.ok((await request('/objects?type='+type)).data.objects.some(x=>x.id===o.id));
      assert.ok((await request('/clients/'+holder.id)).data.objects[type].some(x=>x.id===o.id));
      assert.equal((await request('/clients/'+client.id)).data.objects[type].length,0);
      assert.equal((await request('/objects/'+o.id,'PATCH',{clientId:client.id})).status,409);
      assert.equal((await request('/objects/'+o.id,'PATCH',{clientId:client.id,confirmRelink:true})).status,200);
      assert.ok((await request('/clients/'+client.id)).data.objects[type].some(x=>x.id===o.id));
      assert.equal((await request('/clients/'+holder.id)).data.objects[type].length,0);
      await request('/objects/'+o.id+'/refused','POST',{refused:true});
      assert.ok((await request('/clients/'+client.id)).data.objects.refused.some(x=>x.id===o.id));
      await request('/objects/'+o.id+'/refused','POST',{refused:false});
    }
    assert.equal(db.prepare('SELECT count(*) n FROM objects').get().n,total+3);
    const contract=(await request('/objects','POST',{type:'contract',clientId:client.id,name:'Рамочный',contractKind:'legal'})).data.object;
    assert.ok(contract.regNumber);assert.ok(contract.priorityDate);assert.equal(contract.holder,client.name);
    assert.equal((await request('/clients/'+client.id)).data.objects.contract[0].id,contract.id);
    const renamed=(await request('/clients/'+client.id,'PATCH',{...client,name:'Заказчик новый'})).data.client;
    assert.equal((await request('/objects/'+contract.id)).data.object.holder,'Заказчик новый');
    assert.equal((await request('/clients/'+client.id,'PATCH',{...client,name:'Устаревшее'})).status,409);
    assert.equal(renamed.revision,2);
    assert.equal((await request('/objects','POST',{type:'contract',clientId:holder.id,name:'Рамочный'})).status,200);
    assert.equal((await request('/objects','POST',{type:'patent',name:'Без карточки',holder:'Новый'})).status,400);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{if(child.exitCode===null&&child.signalCode===null){const exit=new Promise(r=>child.once('exit',r));child.kill();await exit;}db.close();}
});
