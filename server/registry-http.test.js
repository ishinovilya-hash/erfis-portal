import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
process.env.ERFIS_DATA_DIR=mkdtempSync(join(tmpdir(),'erfis-http-test-'));
const {db,seedUsers}=await import('./db.js');seedUsers();
for (const [token,user] of [['testmanager','u_ishinov'],['teststaff','u_petrov']])
 db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(token,user,'2026-01-01','2026-01-01');
test('HTTP lifecycle, auth, duplicates and independent price import',async()=>{
 const port=18749;
 const child=spawn(process.execPath,['server.js'],{cwd:import.meta.dirname,env:{...process.env,PORT:String(port)},stdio:'pipe'});
 let output='';child.stderr.on('data',d=>output+=d);
 const request=async(path,method='GET',body,token='testmanager')=>{
  const r=await fetch(`http://127.0.0.1:${port}/api${path}`,{signal:AbortSignal.timeout(3000),method,headers:{cookie:`sid=${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  return {status:r.status,data:await r.json()};
 };
 try {
  let ready=false;
  for(let n=0;n<40;n++){try{await request('/health');ready=true;break;}catch{await delay(100);}}
  assert.ok(ready,output);
  const client=(await request('/clients','POST',{name:'Test',kind:'client'})).data.client;
  assert.equal((await request('/objects?type=refused','GET',undefined,'bad')).status,401);
  const p={format:'erfis-registry-update-v1',id:'http-price',refused:[],price:[{category:'A',name:'Test',fee:'10',duty:'20',total:'30',note:''}]};
  assert.equal((await request('/admin/registry-update','POST',p,'teststaff')).status,403);
  assert.equal((await request('/admin/registry-update?preview=1','POST',p)).data.prices,1);
  assert.equal((await request('/price')).data.items.length,0);
  assert.equal((await request('/admin/registry-update','POST',p)).status,200);
  assert.equal((await request('/price')).data.items.length,1);
  for(const type of ['trademark','patent','software']){
   const created=await request('/objects','POST',{type,clientId:client.id,holder:'Test',name:'Test '+type,regNumber:'100'});
   assert.equal(created.status,200);const id=created.data.object.id;
   await request(`/objects/${id}/reminder`,'POST',{date:'2020-01-01',time:'10:00'});
   assert.equal((await request(`/objects/${id}/refused`,'POST',{refused:true})).status,200);
   assert.equal((await request('/objects?type='+type)).data.objects.length,0);
   assert.equal((await request('/reminders')).data.reminders.length,0);
   assert.equal((await request('/objects?type=refused')).data.objects.length,1);
   assert.equal((await request('/health')).data.refused,1);
   await request(`/objects/${id}/refused`,'POST',{refused:false});
   assert.equal((await request('/objects?type='+type)).data.objects.length,1);
   await request(`/objects/${id}/reminder`,'DELETE');
  }
  const d=(await request('/contracts/defaults?kind=individual')).data;
  const b={type:'contract',clientId:client.id,contractKind:'individual',holder:'Test',name:'Услуги',...d};
  assert.equal((await request('/objects','POST',b)).status,200);
  assert.equal((await request('/objects','POST',b)).status,409);
  assert.match((await request('/contracts/defaults?kind=individual')).data.regNumber,/^Ф2\//);
 }finally{if(child.exitCode===null && child.signalCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill();await exited;}db.close();}
});
