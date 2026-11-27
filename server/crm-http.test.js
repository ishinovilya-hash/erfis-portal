import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

test('CRM routes require login and expose deals in the linked client card', async()=>{
  const dir=mkdtempSync(join(tmpdir(),'erfis-crm-http-'));
  process.env.ERFIS_DATA_DIR=dir;
  const {db,seedUsers}=await import('./db.js');
  seedUsers();
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('crm-test','u_ishinov',new Date().toISOString(),new Date().toISOString());
  const child=spawn(process.execPath,['server.js'],{cwd:import.meta.dirname,env:{...process.env,PORT:'18761'},stdio:'pipe'});
  let output='';child.stderr.on('data',chunk=>output+=chunk);
  const req=async(path,method='GET',body,authenticated=true)=>{
    const response=await fetch('http://127.0.0.1:18761/api'+path,{method,signal:AbortSignal.timeout(3000),headers:{'Content-Type':'application/json',...(authenticated?{cookie:'sid=crm-test'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  try{
    let ready=false;
    for(let n=0;n<50;n++){try{await req('/health');ready=true;break;}catch{await delay(100);}}
    assert.ok(ready,output);
    assert.equal((await req('/crm/deals','GET',undefined,false)).status,401);
    const client=(await req('/clients','POST',{name:'CRM HTTP test client'})).data.client;
    const created=await req('/crm/deals','POST',{title:'CRM test',client_id:client.id,responsible_id:'u_ishinov',stage:'new',budget:10000,next_action:'Позвонить клиенту',next_contact:'2026-12-01T10:00:00+03:00'});
    assert.ok([200,201].includes(created.status),JSON.stringify(created));
    const deal=created.data.deal;
    assert.ok(deal.id);
    const detail=await req('/clients/'+client.id);
    assert.equal(detail.data.deals.length,1);
    assert.equal(detail.data.deals[0].id,deal.id);
    assert.equal(detail.data.objects.trademark.length,0);
    const moved=await req('/crm/deals/'+deal.id,'PATCH',{revision:deal.revision,stage:'work'});
    assert.equal(moved.status,200);
    assert.equal(moved.data.deal.paid_on,'');
    assert.equal((await req('/clients/'+client.id)).data.deals[0].stage,'work');
    for(const file of ['/crm.js','/crm.css']){
      const r=await fetch('http://127.0.0.1:18761'+file);
      assert.equal(r.status,200,file);
      assert.match(r.headers.get('content-type'),file.endsWith('.js')?/javascript/:/text\/css/);
      assert.ok((await r.text()).length>100,file);
    }
  }finally{
    if(child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}
    db.close();rmSync(dir,{recursive:true,force:true});
  }
});
