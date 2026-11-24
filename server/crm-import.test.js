import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeImport, databaseFingerprint, runCli } from './crm-import.js';

function fixture(path=':memory:') {
  const db=new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT);
    INSERT INTO users VALUES('user-test','Test User');
    CREATE TABLE counterparties(id TEXT PRIMARY KEY,name TEXT NOT NULL,inn TEXT DEFAULT '',opf TEXT DEFAULT '',
      contacts TEXT DEFAULT '[]',website TEXT DEFAULT '',revision INTEGER DEFAULT 1,created_at TEXT,updated_at TEXT,updated_by TEXT,private_extra TEXT);
    INSERT INTO counterparties VALUES('client-test','Existing Test','','','[{"name":"Original","phone":"123","custom":"keep"}]','https://example.test',7,'before','before','owner','untouched');
    CREATE TABLE objects(id TEXT PRIMARY KEY,holder TEXT,extra TEXT);
    INSERT INTO objects VALUES('object-test','Original owner','{"sentinel":true}');
    CREATE TABLE activity(id INTEGER PRIMARY KEY,at TEXT,kind TEXT,object_id TEXT,object_type TEXT,text TEXT,user_id TEXT);
    CREATE TABLE meta(k TEXT PRIMARY KEY,v TEXT);`);
  return db;
}
function payload() {
  return {format:'erfis-amo-import/v1',clients:[
    {ref:'client-test',id:'client-test',name:'Existing Test',create:false},
    {ref:'amo-company:test',name:'New Test',create:true}
  ],deals:[
    {source_id:'amo:101',client_ref:'client-test',title:'Historical test',stage:'work',budget:100,paid:null,
      responsible_id:'user-test',tags:['test'],notes:['Original note\nsecond line'],
      created_at:'2025-01-01T10:00:00+03:00',updated_at:'2025-02-01T10:00:00+03:00',
      contact:{name:'Imported',email:'test@example.test',company:'Other relationship',original_fields:{job:'Test role'}},
      source_record:{ID:101,company:'Existing Test',date:'01.01.2025 10:00:00'}},
    {source_id:'amo:102',client_ref:'amo-company:test',title:'Won test',stage:'won',budget:200,paid:null,
      tags:[],notes:[],contact:{name:''},source_record:{ID:102}}
  ]};
}

test('transactional repeat preserves source data, payment unknown, other client columns and objects',()=>{
  const db=fixture();
  try {
    const object=JSON.stringify(db.prepare('SELECT * FROM objects').all());
    const before=db.prepare('SELECT * FROM counterparties WHERE id=?').get('client-test');
    const first=executeImport(db,payload());
    assert.equal(first.imported,2);assert.equal(first.createdClients,1);assert.equal(first.appendedContacts,1);
    const after=db.prepare('SELECT * FROM counterparties WHERE id=?').get('client-test');
    for (const key of Object.keys(before).filter(k=>!['contacts','revision','updated_at'].includes(k))) assert.deepEqual(after[key],before[key]);
    assert.deepEqual(JSON.parse(after.contacts)[0],JSON.parse(before.contacts)[0]);
    const deal=db.prepare('SELECT * FROM crm_deals WHERE source_id=?').get('amo:101');
    assert.equal(deal.paid,null);assert.equal(deal.stage,'work');
    assert.deepEqual(JSON.parse(deal.contact).source_record,payload().deals[0].source_record);
    assert.equal(JSON.parse(deal.contact).company,'Other relationship');
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM objects').all()),object);
    const fingerprint=databaseFingerprint(db);
    const repeat=executeImport(db,payload());
    assert.equal(repeat.imported,0);assert.equal(repeat.skipped,2);assert.equal(repeat.createdClients,0);assert.equal(repeat.appendedContacts,0);
    assert.equal(databaseFingerprint(db),fingerprint);
  } finally {db.close();}
});

test('late helper failure rolls back newly created companies, contacts, provenance, and schema',()=>{
  const db=fixture();
  try {
    const before=databaseFingerprint(db);const p=payload();p.deals[1].responsible_id='missing-user';
    assert.throws(()=>executeImport(db,p));
    assert.equal(databaseFingerprint(db),before);
  } finally {db.close();}
});

test('reject missing clients, exact name drift, duplicate source and non-null paid without changes',()=>{
  for (const mutate of [p=>p.clients[0].id='missing',p=>p.clients[0].name='Changed',
    p=>p.deals[1].source_id='amo:101',p=>p.deals[0].paid=0]) {
    const db=fixture();try {const before=databaseFingerprint(db),p=payload();mutate(p);assert.throws(()=>executeImport(db,p));assert.equal(databaseFingerprint(db),before);}finally{db.close();}
  }
});

test('new-company provenance rejects missing/name-drift rows and unprovenanced duplicates',()=>{
  for (const mode of ['rename','duplicate']) {
    const db=fixture();try {
      if(mode==='rename') {executeImport(db,payload());db.prepare("UPDATE counterparties SET name='changed' WHERE name='New Test'").run();}
      else db.prepare('INSERT INTO counterparties(id,name) VALUES(?,?)').run('other','New Test');
      const before=databaseFingerprint(db);assert.throws(()=>executeImport(db,payload()));assert.equal(databaseFingerprint(db),before);
    }finally{db.close();}
  }
});

test('CLI dry-run never changes target; apply requires independent matching backup; stale backup rejected',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'crm-import-test-'));
  const target=join(dir,'target.db'),file=join(dir,'input.json'),copy=join(dir,'backup.db');
  let db=fixture(target);
  try {
    writeFileSync(file,JSON.stringify(payload()),{mode:0o600});
    const before=databaseFingerprint(db);db.close();db=null;
    const bytes=readFileSync(target);
    assert.equal((await runCli(['--db',target,'--file',file])).mode,'dry-run');
    assert.deepEqual(readFileSync(target),bytes);
    await assert.rejects(runCli(['--db',target,'--file',file,'--apply']),/backup/);
    await assert.rejects(runCli(['--db',target,'--file',file,'--apply','--backup',target]),/separate/);
    db=new DatabaseSync(target);assert.equal(databaseFingerprint(db),before);await backup(db,copy);db.close();db=null;
    const applied=await runCli(['--db',target,'--file',file,'--apply','--backup',copy]);assert.equal(applied.imported,2);
    await assert.rejects(runCli(['--db',target,'--file',file,'--apply','--backup',copy]),/match/);
  }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});


test('shared contact appends to both separate cards; repeated import stays identical',()=>{
  const db=fixture();
  try {
    db.prepare('INSERT INTO counterparties(id,name,contacts) VALUES(?,?,?)').run('contact-company','Contact Company','[]');
    const p=payload();p.clients.push({ref:'contact-company',id:'contact-company',name:'Contact Company',create:false});
    p.deals[0].contact_client_refs=['contact-company'];
    const result=executeImport(db,p);assert.equal(result.appendedContacts,2);
    const one=JSON.parse(db.prepare('SELECT contacts FROM counterparties WHERE id=?').get('client-test').contacts).at(-1);
    const two=JSON.parse(db.prepare('SELECT contacts FROM counterparties WHERE id=?').get('contact-company').contacts)[0];
    assert.deepEqual(one,two);
    assert.equal(db.prepare('SELECT client_id FROM crm_deals WHERE source_id=?').get('amo:101').client_id,'client-test');
    const fingerprint=databaseFingerprint(db);executeImport(db,p);assert.equal(databaseFingerprint(db),fingerprint);
  }finally{db.close();}
});

test('absent contact company stays metadata; creates no extra card and preserves source',()=>{
  const db=fixture();try {
    const p=payload();p.deals[0].contact.company='Absent Company';p.deals[0].source_record.contact_company='Absent Company';
    p.deals[0].deadline='2025-03-01';
    const result=executeImport(db,p);assert.equal(result.imported,2);assert.equal(result.createdClients,1);
    assert.equal(db.prepare('SELECT count(*) n FROM counterparties').get().n,2);
    const deal=db.prepare('SELECT * FROM crm_deals WHERE source_id=?').get('amo:101');
    assert.equal(deal.created_at,p.deals[0].created_at);assert.equal(deal.updated_at,p.deals[0].updated_at);assert.equal(deal.deadline,'2025-03-01');
    assert.equal(JSON.parse(deal.contact).company,'Absent Company');
    assert.deepEqual(JSON.parse(deal.contact).source_record,p.deals[0].source_record);
    assert.deepEqual(JSON.parse(deal.contact).related_client_ids,['client-test']);
    const contacts=JSON.parse(db.prepare('SELECT contacts FROM counterparties WHERE id=?').get('client-test').contacts);
    assert.equal(contacts.at(-1).company,'Absent Company');assert.equal(deal.paid,null);
    assert.equal(db.prepare('SELECT count(*) n FROM crm_tasks').get().n,0);
    const fingerprint=databaseFingerprint(db);executeImport(db,p);assert.equal(databaseFingerprint(db),fingerprint);
  }finally{db.close();}
});
