#!/usr/bin/env node
/** Private JSON is deliberately external to the repository.
 * node server/crm-import.js --db /absolute/database --file /private/import.json
 * Add --apply --backup /independently-created/sqlite-backup to commit.
 * Create a consistent SQLite backup independently (SQLite .backup / backup API),
 * not a raw copy of an active WAL database. Stop the service briefly before
 * creating the backup and keep it stopped through apply: the full fingerprint
 * includes runtime sessions and rejects any intervening write. Restart afterward.
 * Never point tests at production.
 */
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, mkdtempSync, rmSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initCrm, importCrmDeals } from './crm.js';

const fail = message => { throw new Error(message); };
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k,v[k]])) : v);
const nameKey = value => String(value).normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g,'е')
  .replace(/общество с ограниченной ответственностью/g,'').replace(/(^|\s)(ооо|зао|оао|ао|ип|ано)(?=\s|$)/g,' ')
  .replace(/[^\p{L}\p{N}]/gu,'');
const stages = new Set(['new','offer','contract','work','act_ready','act_sent','won','lost']);
const tableExists = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

export function validatePayload(payload) {
  if (payload?.format !== 'erfis-amo-import/v1' || !Array.isArray(payload.clients) || !Array.isArray(payload.deals) || !payload.deals.length) fail('Invalid import format');
  const refs = new Set(), ids = new Set();
  for (const c of payload.clients) {
    if (!c || typeof c.ref !== 'string' || !c.ref || typeof c.name !== 'string' || !c.name.trim() || typeof c.create !== 'boolean' || refs.has(c.ref)) fail('Invalid or duplicate client reference');
    refs.add(c.ref);
    if (c.create ? !c.ref.startsWith('amo-company:') : typeof c.id !== 'string' || !c.id) fail('Invalid client provenance');
  }
  for (const d of payload.deals) {
    if (!/^amo:\d+$/.test(d.source_id) || ids.has(d.source_id)) fail('Invalid or duplicate source_id');
    ids.add(d.source_id);
    if (!refs.has(d.client_ref) || !stages.has(d.stage) || typeof d.title !== 'string' || !d.title.trim()) fail('Invalid deal reference/title/stage');
    if (d.paid !== null) fail('Imported payment must be explicitly unknown (null)');
    if (!Number.isFinite(d.budget) || d.budget < 0 || !Array.isArray(d.notes) || d.notes.some(n => typeof n !== 'string') || !Array.isArray(d.tags)) fail('Invalid amount/notes/tags');
    // A source contact-company name is metadata, not an instruction to create a card.
    // Only explicit, approved existing references receive a second contact append.
    if (d.contact_client_refs !== undefined && (!Array.isArray(d.contact_client_refs) || d.contact_client_refs.some(ref => !refs.has(ref) || payload.clients.find(c => c.ref === ref).create))) fail('Invalid shared contact client reference');
    if (!d.contact || typeof d.contact !== 'object' || Array.isArray(d.contact) || !d.source_record || String(d.source_record.ID) !== d.source_id.slice(4)) fail('Missing original source record');
  }
  if (payload.clients.some(c => !payload.deals.some(d => d.client_ref === c.ref || (d.contact_client_refs || []).includes(c.ref)))) fail('Unused client reference');
}

// Exact logical comparison includes all tables, all fields and SQLite schema.
// Binary file hashes would reject equivalent backups with different page layouts.
export function databaseFingerprint(db) {
  const digest = createHash('sha256');
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
  digest.update(canonical(schema));
  for (const {name,type} of schema) if (type === 'table') {
    const q = '"' + name.replaceAll('"','""') + '"';
    const stmt = db.prepare(`SELECT * FROM ${q}`); stmt.setReadBigInts(true);
    const rows = stmt.all().map(r => JSON.stringify(r, (_,v) => typeof v === 'bigint' ? {integer:String(v)} : v)).sort();
    digest.update(canonical([name,rows]));
  }
  return digest.digest('hex');
}

function assertClient(db, id, name) {
  const row = db.prepare('SELECT * FROM counterparties WHERE id=?').get(id);
  if (!row) fail('Required client is missing: ' + id);
  if (row.name !== name) fail('Client name drift: ' + id);
  return row;
}

function planClients(db, payload) {
  const all = db.prepare('SELECT id,name FROM counterparties').all();
  const result = new Map();
  const hasMap = tableExists(db,'crm_import_companies');
  const pendingNames = new Set();
  for (const c of payload.clients) {
    if (!c.create) { result.set(c.ref,{...c,row:assertClient(db,c.id,c.name)}); continue; }
    const saved = hasMap ? db.prepare('SELECT * FROM crm_import_companies WHERE source_key=?').get(c.ref) : null;
    if (saved) {
      if (saved.expected_name !== c.name) fail('Company provenance name drift');
      result.set(c.ref,{...c,id:saved.client_id,row:assertClient(db,saved.client_id,c.name)});
    } else {
      const key = nameKey(c.name);
      if (all.some(r => nameKey(r.name) === key) || pendingNames.has(key)) fail('New company already exists without matching provenance; review required');
      pendingNames.add(key);
      result.set(c.ref,{...c,id:'cl-amo-'+hash(c.ref).slice(0,24),row:null});
    }
  }
  return result;
}

function hasContact(c) { return ['name','email','phone','telegram'].some(k => c[k]); }
function contactKey(c) {
  // Ignore provenance when comparing contact content; preserve the existing entry.
  const fields = ['name','email','phone','telegram'];
  return canonical(Object.fromEntries(fields.map(k => [k,String(c[k] ?? '').trim()])));
}

/** Caller supplies a disposable DB for dry-run, or a backed-up target for apply. */
export function executeImport(db, payload, { expectedFingerprint } = {}) {
  validatePayload(payload);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
  try {
    if (expectedFingerprint && databaseFingerprint(db) !== expectedFingerprint) fail('Backup does not match the current database; create a fresh independent backup');
    const clients = planClients(db,payload);
    initCrm(db);
    db.exec(`CREATE TABLE IF NOT EXISTS crm_import_companies (
      source_key TEXT PRIMARY KEY, client_id TEXT NOT NULL UNIQUE REFERENCES counterparties(id),
      expected_name TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
    const at = new Date().toISOString();
    let createdClients = 0, appendedContacts = 0;
    for (const c of clients.values()) if (!c.row) {
      db.prepare('INSERT INTO counterparties(id,name,inn,opf,contacts,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(c.id,c.name,c.inn || '',c.opf || '', '[]',at,at);
      db.prepare('INSERT INTO crm_import_companies(source_key,client_id,expected_name,created_at) VALUES(?,?,?,?)').run(c.ref,c.id,c.name,at);
      c.row=assertClient(db,c.id,c.name); createdClients++;
    }
    const prepared = payload.deals.map(d => {
      const c = clients.get(d.client_ref);
      const old = db.prepare('SELECT client_id FROM crm_deals WHERE source_id=?').get(d.source_id);
      if (old && old.client_id !== c.id) fail('Existing source deal has a different client');
      // A repeated import never changes a previously imported deal or re-adds its contact.
      if (!old && hasContact(d.contact)) for (const ref of new Set([d.client_ref,...(d.contact_client_refs || [])])) {
        const target = clients.get(ref);
        const contacts = JSON.parse(target.row.contacts);
        if (!Array.isArray(contacts)) fail('Invalid current client contacts');
        if (!contacts.some(x => contactKey(x) === contactKey(d.contact))) {
          contacts.push({...d.contact,source_id:d.source_id});
          db.prepare('UPDATE counterparties SET contacts=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify(contacts),at,target.id);
          target.row.contacts=JSON.stringify(contacts); appendedContacts++;
        }
      }
      const {client_ref,contact_client_refs,source_record,...deal} = d;
      return {...deal, client_id:c.id, contact:{...d.contact,related_client_ids:[...new Set([c.id,...(contact_client_refs || []).map(ref => clients.get(ref).id)])],source_record}};
    });
    const imported = importCrmDeals(db,prepared);
    const result = {deals:payload.deals.length,imported:imported.imported,skipped:imported.skipped,
      createdClients,appendedContacts,notes:payload.deals.reduce((n,d)=>n+d.notes.length,0),
      stages:payload.deals.reduce((o,d)=>(o[d.stage]=(o[d.stage]||0)+1,o),{})};
    db.exec('COMMIT');
    return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export async function runCli(args) {
  const options={};
  for (let i=0;i<args.length;i++) {
    const key=args[i];
    if (key==='--help') return {usage:'crm-import.js --db DB --file PRIVATE_JSON [--apply --backup INDEPENDENT_SQLITE_BACKUP] (default: dry-run on private temporary copy)'};
    if (!['--db','--file','--backup','--apply','--dry-run'].includes(key) || options[key] !== undefined) fail('Unknown or repeated argument');
    options[key]=['--apply','--dry-run'].includes(key) ? true : args[++i];
    if (!options[key] || String(options[key]).startsWith('--')) fail('Missing argument value');
  }
  if (!options['--db'] || !options['--file'] || (options['--apply'] && options['--dry-run'])) fail('Specify --db and --file, with either default dry-run or explicit --apply');
  const dbPath=realpathSync(options['--db']);
  const payload=JSON.parse(readFileSync(options['--file'],'utf8')); validatePayload(payload);
  if (options['--apply']) {
    if (!options['--backup']) fail('--apply requires --backup from an independent SQLite backup');
    const backupPath=realpathSync(options['--backup']);
    if (backupPath===dbPath || (statSync(backupPath).dev===statSync(dbPath).dev && statSync(backupPath).ino===statSync(dbPath).ino)) fail('Backup must be a separate file');
    const backupDb=new DatabaseSync(backupPath,{readOnly:true});
    let fingerprint;
    try {
      backupDb.exec('BEGIN');
      if (backupDb.prepare('PRAGMA integrity_check').get().integrity_check!=='ok') fail('Backup integrity check failed');
      fingerprint=databaseFingerprint(backupDb);
    } finally {backupDb.close();}
    const db=new DatabaseSync(dbPath);
    try {return {mode:'applied',...executeImport(db,payload,{expectedFingerprint:fingerprint})};} finally {db.close();}
  }
  const dir=mkdtempSync(join(tmpdir(),'erfis-crm-dry-run-')); chmodSync(dir,0o700);
  let source,clone;
  try {
    source=new DatabaseSync(dbPath,{readOnly:true});
    const temp=join(dir,'preview.sqlite');
    await backup(source,temp); source.close(); source=null; chmodSync(temp,0o600);
    clone=new DatabaseSync(temp);
    return {mode:'dry-run',...executeImport(clone,payload)};
  } finally {clone?.close();source?.close();rmSync(dir,{recursive:true,force:true});}
}

if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result,null,2)))
    .catch(error=>{ console.error('Import rejected: '+error.message);process.exitCode=1; });
}
