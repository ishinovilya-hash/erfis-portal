import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {deadlineAlert,moscowDate} from './work-calendar.js';
const configPath=()=>join(process.env.ERFIS_DATA_DIR||join(dirname(fileURLToPath(import.meta.url)),'data'),'crm-mail.json');
const address=s=>typeof s==='string'&&/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s);
function config(){try{return JSON.parse(readFileSync(configPath(),'utf8'));}catch{return {};}}
export function mailStatus(){const c=config();return {configured:!!(address(c.from)&&c.password),from:c.from||'client@erfis.ru'};}
export function saveMailConfig(b){
 if(!address(b.from)||typeof b.password!=='string'||!b.password||b.password.length>1024||/[\r\n\0]/.test(b.password))throw Object.assign(Error('Укажите адрес и пароль приложения Mail.ru'),{status:400});
 mkdirSync(dirname(configPath()),{recursive:true});writeFileSync(configPath(),JSON.stringify({from:b.from,password:b.password}),{mode:0o600});
 return mailStatus();
}
export function initCrmMail(db){db.exec(`CREATE TABLE IF NOT EXISTS crm_mail_deliveries (
 key TEXT PRIMARY KEY, deal_id TEXT NOT NULL, deadline TEXT NOT NULL, recipient TEXT NOT NULL,
 status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, attempted_at TEXT NOT NULL, sent_at TEXT, error TEXT
)`);}
const quote=s=>'"'+s.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"';
export async function sendDeadlineMail({to,subject,body,key}){
 const c=config();if(!address(c.from)||!c.password||!address(to))throw Error('Почта не настроена или неверен адрес');
 const dir=await mkdtemp(join(tmpdir(),'erfis-mail-'));
 try{
  const path=join(dir,'message.eml');
  const encoded=Buffer.from(body).toString('base64').match(/.{1,76}/g).join('\r\n');
  await writeFile(path,`From: ${c.from}\r\nTo: ${to}\r\nSubject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <${key}@erfis.ru>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encoded}\r\n`,{mode:0o600});
  await new Promise((resolve,reject)=>{
   const child=execFile('curl',['--disable','--silent','--show-error','--fail','--max-time','40','--ssl-reqd','--url','smtps://smtp.mail.ru:465','--config','-','--upload-file',path],{timeout:45000},err=>err?reject(Error('Не удалось отправить письмо через Mail.ru. Проверьте пароль приложения и доступ к SMTP.')):resolve());
   // Credentials go through stdin, never process arguments or logs.
   child.stdin.on('error',()=>{});child.stdin.end(`user = ${quote(c.from+':'+c.password)}\nmail-from = ${quote(c.from)}\nmail-rcpt = ${quote(to)}\n`);
  });
 }finally{await rm(dir,{recursive:true,force:true});}
}
export async function processCrmMail(db,{at=new Date(),send=sendDeadlineMail,configured=mailStatus().configured}={}){
 if(!configured)return;
 const today=moscowDate(at),hour=new Date(at.getTime()+10800000).getUTCHours();if(hour<9||hour>=19)return;
 const deals=db.prepare(`SELECT d.*,u.email recipient,c.name client FROM crm_deals d LEFT JOIN users u ON u.id=d.responsible_id LEFT JOIN counterparties c ON c.id=d.client_id WHERE d.deleted_at IS NULL AND d.stage='work' AND d.deadline<>''`).all();
 for(const snapshot of deals){
  const d=db.prepare(`SELECT d.*,u.email recipient,c.name client FROM crm_deals d LEFT JOIN users u ON u.id=d.responsible_id LEFT JOIN counterparties c ON c.id=d.client_id WHERE d.id=?`).get(snapshot.id);
  if(!d)continue;
  const alert=deadlineAlert(d,today);if(!alert||!address(d.recipient))continue;
  const key=createHash('sha256').update([d.id,d.deadline,d.responsible_id,d.recipient].join('|')).digest('hex');
  const old=db.prepare('SELECT * FROM crm_mail_deliveries WHERE key=?').get(key);
  if(old?.status==='sent'||(old&&at.getTime()-Date.parse(old.attempted_at)<3600000))continue;
  db.prepare(`INSERT INTO crm_mail_deliveries(key,deal_id,deadline,recipient,status,attempted_at,attempts) VALUES(?,?,?,?,'sending',?,1) ON CONFLICT(key) DO UPDATE SET status='sending',attempted_at=excluded.attempted_at,attempts=attempts+1`).run(key,d.id,d.deadline,d.recipient,at.toISOString());
  try{
   await send({to:d.recipient,key,subject:'ЭРФИС: срок сдачи работы',body:`${alert.label}.\n\nКлиент: ${d.client}\nСделка: ${d.title}\nСрок сдачи: ${alert.due.split('-').reverse().join('.')}\n\nОткрыть карточку: https://portal.erfis.ru/#/crm?deal=${encodeURIComponent(d.id)}`});
   db.prepare("UPDATE crm_mail_deliveries SET status='sent',sent_at=?,error=NULL WHERE key=?").run(at.toISOString(),key);
  }catch{db.prepare("UPDATE crm_mail_deliveries SET status='failed',error='Ошибка отправки SMTP' WHERE key=?").run(key);}
 }
}
export function startCrmMail(db){let busy=false;const tick=async()=>{if(busy)return;busy=true;try{await processCrmMail(db);}catch{console.error('CRM: ошибка проверки почтовых напоминаний');}finally{busy=false;}};setInterval(tick,60000).unref();void tick();}
