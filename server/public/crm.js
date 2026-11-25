const CRM_DIRECTIONS=[['patents','Изобретения и полезные модели'],['trademarks','Товарные знаки'],['mincifry','Минцифры'],['software','Программы для ЭВМ']];
/* CRM uses the portal session, clients and existing employee directory. */
const CRM_SERVICE_SUGGESTIONS=['Регистрация товарного знака','Поиск товарного знака','Продление товарного знака','Регистрация изобретения','Регистрация полезной модели','Патентный поиск','Регистрация промышленного образца','Регистрация программы для ЭВМ','Включение ПО в реестр Минцифры','Лицензионный договор','Отчуждение исключительного права'];
const CRM_LABELS={new:'Новый лид',offer:'Выставлено КП',contract:'Заключение договора / счёт',work:'В работе',act_ready:'Можно делать акт',act_sent:'Акт отправлен',won:'Сделан акт',lost:'Отказ'};
const crm={deals:null,clients:[],trash:[],mode:'active',responsible:'',drag:null,busy:false};
const crmMoney=n=>Number(n||0).toLocaleString('ru-RU',{maximumFractionDigits:2})+' ₽';
const crmClient=id=>crm.clients.find(c=>c.id===id);
const crmDT=v=>v?new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',dateStyle:'short',timeStyle:'short'}).format(new Date(v)): 'Без срока';
const crmInputTime=v=>v?new Date(new Date(v).getTime()+10800000).toISOString().slice(0,16):'';
const crmISO=v=>v?v+':00+03:00':'';
function crmBusy(){return crm.busy||!!crm.drag||!!document.querySelector('#crm-dialog');}
async function loadCrm(){
  const [deals,clients,trash,report]=await Promise.all([api('/crm/deals'),api('/clients'),api('/crm/deals?trash=1'),api('/crm/report')]);
  crm.report=report;crm.deals=deals.deals;crm.clients=clients.clients;crm.trash=trash.deals;
}
function crmVisible(d){
  const q=state.ui.q.toLocaleLowerCase('ru').trim();
  return (!crm.responsible||d.responsible_id===crm.responsible)&&
    (!q||[d.title,crmClient(d.client_id)?.name,d.contact?.name,d.contact?.phone,d.contact?.email,...(d.tags||[])].some(v=>String(v||'').toLocaleLowerCase('ru').includes(q)));
}
function crmReport(){
  const report=crm.report,rows=report?.rows||[];
  const current=report.month;
  const first=rows.length?rows.map(r=>r.month).sort()[0]:current;
  const months=[];
  for(let month=current;month>=first;){months.push(month);const [y,m]=month.split('-').map(Number);month=m===1?`${y-1}-12`:`${y}-${String(m-1).padStart(2,'0')}`;}
  const directions=[...CRM_DIRECTIONS,['','Без направления']];
  crmDialog('Передано в работу · по месяцам',`<p class="hint">Количество сделок по дате первой передачи в работу. Повторный перевод не считается новой продажей. Завершение, перенос в отстойник и её очистка не удаляют факт из отчёта. Исправление даты или направления в карточке пересчитывает отчёт.</p><div class="crm-report-table"><table><thead><tr><th>Месяц</th>${directions.map(([,label])=>`<th>${label}</th>`).join('')}<th>Всего</th></tr></thead><tbody>${months.map(month=>{const counts=directions.map(([key])=>rows.find(r=>r.month===month&&r.direction===key)?.count||0);return `<tr><td>${month.split('-').reverse().join('.')}</td>${counts.map(n=>`<td>${n}</td>`).join('')}<td>${counts.reduce((a,b)=>a+b,0)}</td></tr>`;}).join('')}</tbody></table></div><p class="hint">Сделок без даты передачи: ${report.missingDate}. Заполните дату и направление в карточках старых сделок. Одна сделка считается одной единицей.</p>`,null);
}
function crmCard(d,trash=false){
  const tasks=(d.tasks||[]).filter(t=>t.status==='open');
  const overdue=tasks.some(t=>t.due_at&&new Date(t.due_at)<new Date());
  return `<article class="crm-card" tabindex="0" aria-label="${esc(d.title)} — открыть двойным кликом или Enter" ${trash?'':'draggable="true"'} data-deal="${esc(d.id)}">
    <div class="crm-company" title="${esc(crmClient(d.client_id)?.name||'Клиент')}">${esc(crmClient(d.client_id)?.name||'Клиент')}</div>
    ${d.created_at?`<div class="crm-card-date" title="Дата создания сделки">${esc(new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow'}).format(new Date(d.created_at)))}</div>`:''}
    <button class="crm-card-title" title="${esc(d.title)}" data-open-deal="${esc(d.id)}">${esc(d.title)}</button>
    <div class="crm-card-owner" title="${esc(userName(d.responsible_id)||'Без ответственного')}">${esc(userName(d.responsible_id)||'Без ответственного')}</div>
    <div class="crm-card-money" title="${d.paid===null?'Оплата не указана':esc(`Оплачено: ${crmMoney(d.paid)} · Остаток: ${crmMoney(Math.max(0,d.budget-d.paid))}`)}">${crmMoney(d.budget)}</div>
    ${tasks.length?`<div class="crm-task-marker ${overdue?'overdue':''}">${overdue?'Просрочено · ':''}Задач: ${tasks.length}</div>`:''}
    ${d.tags?.length?`<div class="crm-tags">${d.tags.map(t=>`<span>${esc(t)}</span>`).join('')}</div>`:''}
    ${trash?`<button class="btn" data-restore-deal="${esc(d.id)}">Восстановить</button>`:''}</article>`;
}
function renderCrm(){
  if(!crm.deals){$('#view').innerHTML='<div class="pageloader">Загрузка CRM…</div>';return;}
  const rows=(crm.mode==='trash'?crm.trash:crm.deals).filter(crmVisible);
  const stages=Object.keys(CRM_LABELS).filter(s=>!['won','lost'].includes(s));
  const tasks=rows.flatMap(d=>(d.tasks||[]).filter(t=>t.status==='open').map(t=>({...t,deal:d}))).sort((a,b)=>(a.due_at||'9999').localeCompare(b.due_at||'9999'));
  const active=crm.deals.filter(d=>!['won','lost'].includes(d.stage));
  const month=crm.report?.month||new Date(Date.now()+10800000).toISOString().slice(0,7);
  const count=(direction)=>(crm.report?.rows||[]).find(r=>r.month===month&&r.direction===direction)?.count||0;
  $('#view').innerHTML=`<div class="crm-summary crm-month-summary"><span><strong>${active.length}</strong> активных сделок</span><div class="crm-month-panel"><div class="crm-month-heading">Передано в работу · ${esc(month.split('-').reverse().join('.'))}<button class="btn" id="crm-report">По месяцам</button></div><div class="crm-month-metrics">${CRM_DIRECTIONS.map(([key,label])=>`<div><strong>${count(key)}</strong><span>${label}</span></div>`).join('')}</div><div class="hint">Без направления за месяц: ${count('')}${crm.report?.missingDate?` · Без даты передачи: ${crm.report.missingDate}`:''}</div></div></div>
    <div class="toolbar crm-toolbar"><div class="crm-tabs">${[['active','Воронка'],['tasks','Задачи'],['trash',`Отстойник (${crm.trash.length+crm.deals.filter(d=>d.stage==='lost').length})`],['won',`Успешно завершённые (${crm.deals.filter(d=>d.stage==='won').length})`]].map(([k,l])=>`<button class="btn ${crm.mode===k?'primary':''}" data-crm-mode="${k}">${l}</button>`).join('')}</div>
    <select id="crm-responsible" aria-label="Ответственный"><option value="">Все ответственные</option>${state.users.map(u=>`<option value="${esc(u.id)}" ${crm.responsible===u.id?'selected':''}>${esc(u.name)}</option>`).join('')}</select>
    <span class="spacer"></span><button class="btn primary" id="crm-add">Новая сделка</button></div>
    ${crm.mode==='trash'?`<div class="toolbar"><span class="hint">Сделки хранятся здесь до ручной очистки. Клиенты и объекты не удаляются.</span><button class="btn danger" id="crm-empty" ${crm.trash.length?'':'disabled'}>Очистить отстойник</button></div><div class="crm-card-grid">${rows.map(d=>crmCard(d,true)).join('')||(crm.deals.some(d=>d.stage==='lost'&&crmVisible(d))?'':'<div class="empty">Отстойник пуст</div>')}${crm.deals.filter(d=>d.stage==='lost'&&crmVisible(d)).map(d=>crmCard(d)).join('')}</div>`:
    crm.mode==='won'?`<div class="crm-card-grid">${rows.filter(d=>d.stage==='won').map(d=>crmCard(d)).join('')||'<div class="empty">Успешно завершённых сделок пока нет</div>'}</div>`:
    crm.mode==='tasks'?`<div class="listcard">${tasks.map(t=>`<div class="lrow"><div class="lr-main"><button class="crm-card-title" data-open-deal="${esc(t.deal.id)}">${esc(t.title)}</button><div class="lr-s">${esc(t.deal.title)} · ${esc(userName(t.assigned_to)||'Без ответственного')}</div><div class="${t.due_at&&new Date(t.due_at)<new Date()?'overdue':'hint'}">${esc(crmDT(t.due_at))} МСК</div></div><button class="btn" data-task-done="${esc(t.id)}" data-task-deal="${esc(t.deal.id)}">Выполнено</button></div>`).join('')||'<div class="empty">Невыполненных задач нет</div>'}</div>`:
    `<div class="crm-board">${stages.map(s=>{const list=rows.filter(d=>d.stage===s);return `<section class="crm-column" data-stage="${s}"><header><h3>${CRM_LABELS[s]}</h3><span>${list.length} · ${crmMoney(list.reduce((n,d)=>n+d.budget,0))}</span></header><div class="crm-column-cards">${list.map(d=>crmCard(d)).join('')||'<div class="crm-column-empty">Перетащите сделку сюда</div>'}</div></section>`;}).join('')}</div>`}
    <div id="crm-drop-actions" class="crm-drop-actions" hidden><div id="crm-drop-trash" class="crm-drop-trash">Отстойник</div><div id="crm-drop-won" class="crm-drop-won">Успешно завершена</div></div>`;
  document.querySelectorAll('[data-crm-mode]').forEach(b=>b.onclick=()=>{crm.mode=b.dataset.crmMode;renderCrm();});
  $('#crm-responsible').onchange=e=>{crm.responsible=e.target.value;renderCrm();};
  $('#crm-add').onclick=()=>crmEdit();
  $('#crm-report').onclick=crmReport;
  const openDeal=id=>crmEdit([...crm.deals,...crm.trash].find(d=>d.id===id));
  document.querySelectorAll('[data-open-deal]').forEach(b=>{
    if(!b.closest('.crm-card'))b.onclick=()=>openDeal(b.dataset.openDeal);
  });
  document.querySelectorAll('.crm-card[data-deal]').forEach(card=>{
    card.ondblclick=e=>{if(e.target.closest('[data-restore-deal]'))return;openDeal(card.dataset.deal);};
    card.onkeydown=e=>{if(e.key==='Enter'&&!e.target.closest('[data-restore-deal]')){e.preventDefault();openDeal(card.dataset.deal);}};
  });
  document.querySelectorAll('[data-restore-deal]').forEach(b=>b.onclick=()=>crmMutation('/crm/deals/'+b.dataset.restoreDeal+'/restore','POST',{revision:crm.trash.find(d=>d.id===b.dataset.restoreDeal).revision}));
  document.querySelectorAll('[data-task-done]').forEach(b=>b.onclick=()=>crmCompleteTask(b.dataset.taskDeal,b.dataset.taskDone));
  if($('#crm-empty'))$('#crm-empty').onclick=()=>{if(confirm(`Безвозвратно удалить ${crm.trash.length} сделок из отстойника вместе с их задачами и примечаниями?`))crmMutation('/crm/trash','DELETE',{deals:crm.trash.map(({id,revision})=>({id,revision}))});};
  document.querySelectorAll('.crm-card[draggable]').forEach(el=>{
    el.ondragstart=e=>{const d=crm.deals.find(x=>x.id===el.dataset.deal);crm.drag={id:d.id,revision:d.revision};e.dataTransfer.setData('text/plain',d.id);e.dataTransfer.effectAllowed='move';$('#crm-drop-actions').hidden=false;};
    el.ondragend=()=>{crm.drag=null;if($('#crm-drop-actions'))$('#crm-drop-actions').hidden=true;document.querySelectorAll('.crm-drop-over').forEach(x=>x.classList.remove('crm-drop-over'));};
  });
  const drop=(el,fn)=>{el.ondragover=e=>{if(crm.drag){e.preventDefault();e.dataTransfer.dropEffect='move';el.classList.add('crm-drop-over');}};el.ondragleave=()=>el.classList.remove('crm-drop-over');el.ondrop=e=>{e.preventDefault();el.classList.remove('crm-drop-over');const drag=crm.drag;crm.drag=null;$('#crm-drop-actions').hidden=true;if(drag)fn(drag);};};
  document.querySelectorAll('[data-stage]').forEach(el=>drop(el,drag=>{const d=crm.deals.find(x=>x.id===drag.id);if(d&&d.stage!==el.dataset.stage)crmWorkflow(d,{revision:drag.revision,stage:el.dataset.stage});}));
  drop($('#crm-drop-won'),drag=>{const d=crm.deals.find(x=>x.id===drag.id);if(d&&d.stage!=='won')crmWorkflow(d,{revision:drag.revision,stage:'won'});});
  drop($('#crm-drop-trash'),drag=>crmMutation('/crm/deals/'+drag.id,'DELETE',{revision:drag.revision}));
}
async function crmMutation(path,method,body){
  if(crm.busy)return;crm.busy=true;
  try{await api(path,{method,body:jbody(body)});await loadCrm();if(state.route==='crm')renderCrm();toast('Сохранено');}
  catch(e){toast(e.message,true);}finally{crm.busy=false;}
}
async function crmCompleteTask(dealId,taskId){
  const d=crm.deals.find(x=>x.id===dealId),t=d?.tasks.find(x=>x.id===taskId);if(!t)return;
  await crmMutation('/crm/tasks/'+taskId,'PATCH',{revision:t.revision,deal_revision:d.revision,status:'done'});
}
function crmClose(){const el=$('#crm-dialog');if(el){el.close();el.remove();}}
function crmDialog(title,body,onSave,saveLabel='Сохранить'){
  crmClose();const el=document.createElement('dialog');el.id='crm-dialog';el.className='crm-dialog';
  el.innerHTML=`<form><header><h2>${esc(title)}</h2><button type="button" class="btn" data-cancel aria-label="Закрыть">×</button></header><div class="crm-dialog-content">${body}</div><div class="crm-error" role="alert"></div><footer><button type="button" class="btn" data-cancel>Отмена</button>${onSave?`<button class="btn primary" type="submit">${esc(saveLabel)}</button>`:''}</footer></form>`;
  document.body.appendChild(el);el.showModal();
  el.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=()=>{if(!crm.busy)crmClose();});
  el.oncancel=e=>{if(crm.busy)e.preventDefault();else setTimeout(()=>el.remove(),0);};
  el.querySelector('form').onsubmit=async e=>{
    e.preventDefault();if(!onSave||crm.busy)return;const form=e.target;
    form.querySelector('.crm-error').textContent='';
    try{await onSave(Object.fromEntries(new FormData(form)),form);}catch(err){if(el.isConnected)form.querySelector('.crm-error').textContent=err.message;else toast(err.message,true);}
  };
  return el;
}
function crmField(label,key,value='',type='text',required=false){return `<label class="crm-field">${label}<input name="${key}" type="${type}" value="${esc(value??'')}" ${required?'required':''} ${type==='number'?'min="0" step="0.01"':''}></label>`;}
function crmSelect(label,key,value,options,required=false){return `<label class="crm-field">${label}<select name="${key}" ${required?'required':''}>${options.map(([v,l])=>`<option value="${esc(v)}" ${v===value?'selected':''}>${esc(l)}</option>`).join('')}</select></label>`;}
const crmUsers=()=>[['','— Выберите сотрудника'],...state.users.map(u=>[u.id,u.name])];
async function crmSave(d,b){
  crm.busy=true;const el=$('#crm-dialog');el?.querySelectorAll('button').forEach(x=>x.disabled=true);
  try{await api('/crm/deals'+(d.id?'/'+d.id:''),{method:d.id?'PATCH':'POST',body:jbody(b)});crmClose();await loadCrm();renderCrm();toast('Сделка сохранена');}
  finally{crm.busy=false;el?.querySelectorAll('button').forEach(x=>x.disabled=false);}
}
function crmWorkflow(d,b){
  const merged={...d,...b},stage=merged.stage;
  if(d.id&&d.stage===stage){return crmSave(d,b);}
  let title,fields;
  if(stage==='new'){title='Свяжитесь с клиентом';fields=crmSelect('Ответственный','responsible_id',merged.responsible_id||state.me.id,crmUsers(),true)+crmField('Что сделать','next_action',merged.next_action||'Связаться с клиентом','text',true)+crmField('Когда связаться · МСК','next_contact',crmInputTime(merged.next_contact),'datetime-local',true);}
  else if(stage==='offer'){title='Когда связаться повторно?';fields=crmSelect('Ответственный','responsible_id',merged.responsible_id||state.me.id,crmUsers(),true)+crmField('Следующее действие','next_action',merged.next_action||'Уточнить решение по КП','text',true)+crmField('Дата и время · МСК','next_contact',crmInputTime(merged.next_contact),'datetime-local',true);}
  else if(stage==='work'){title='Передайте работу специалисту';fields=`<p class="hint">Стоимость работ: ${crmMoney(merged.budget)}. Передаём после полной оплаты; аванс отмечается отдельно.</p>`+crmSelect('Исполнитель','executor_id',merged.executor_id||'',crmUsers(),true)+crmField('Срок выполнения','deadline',merged.deadline?.slice(0,10),'date',true)+crmField('Получено за работы, ₽','paid',merged.paid??'','number',true)+`<label class="crm-check"><input name="allow_advance" type="checkbox" ${merged.allow_advance?'checked':''}>Начать работу по авансу</label>`;}
  else if(stage==='lost'){title='Почему сделка не состоялась?';fields=crmField('Причина отказа','lost_reason',merged.lost_reason||'','text',true);}
  else{return crmSave(d,b).catch(e=>toast(e.message,true));}
  crmDialog(title,fields,async f=>{
    const patch={...b};
    if(stage==='new'||stage==='offer'){Object.assign(patch,{responsible_id:f.responsible_id,next_action:f.next_action,next_contact:crmISO(f.next_contact),task:{title:f.next_action,assigned_to:f.responsible_id,due_at:crmISO(f.next_contact)}});}
    if(stage==='work'){Object.assign(patch,{executor_id:f.executor_id,deadline:f.deadline,paid:Number(f.paid),allow_advance:f.allow_advance==='on',task:{title:'Выполнить работу: '+merged.title,assigned_to:f.executor_id,due_at:f.deadline}});if(patch.paid<merged.budget&&!(patch.allow_advance&&patch.paid>0))throw Error('Укажите полную оплату или отметьте начало по полученному авансу.');}
    if(stage==='lost')patch.lost_reason=f.lost_reason;
    await crmSave(d,patch);
  },d.id?'Перевести сделку':'Создать сделку');
}
function crmEdit(original){
  const d=original||{title:'',client_id:'',stage:'new',responsible_id:state.me.id,budget:0,duties:0,paid:null,contact:{},tags:[],notes:[],tasks:[]};
  if(d.deleted_at){crmDialog('Сделка в отстойнике',`<p>${esc(d.title)}</p><p>${esc(crmClient(d.client_id)?.name)}</p><p>Восстановите сделку, чтобы изменить её.</p>`,null);return;}
  const contact=d.contact||{};
  const body=`<div class="crm-form-grid">${crmField('Название сделки','title',d.title,'text',true)}
    <label class="crm-field">Клиент 360<input name="client_name" list="crm-client-list" value="${esc(crmClient(d.client_id)?.name||'')}" required autocomplete="off"><datalist id="crm-client-list">${crm.clients.map(c=>`<option value="${esc(c.name)}"></option>`).join('')}</datalist></label>
    ${crmSelect('Этап','stage',d.stage,Object.entries(CRM_LABELS))}${crmSelect('Ответственный','responsible_id',d.responsible_id||'',crmUsers(),true)}
    ${crmField('Стоимость работ, ₽','budget',d.budget,'number',true)}${crmField('Пошлины, ₽','duties',d.duties||0,'number')}
    ${crmField('Оплачено за работы, ₽ · пусто = неизвестно','paid',d.paid??'','number')}<label class="crm-field">Услуга<input name="service" list="crm-service-list" value="${esc(d.service||'')}" placeholder="Выберите или введите своё название" autocomplete="off"><datalist id="crm-service-list">${[...new Set([...CRM_SERVICE_SUGGESTIONS,...crm.deals.map(x=>x.service).filter(Boolean)])].sort((a,b)=>a.localeCompare(b,'ru')).map(name=>`<option value="${esc(name)}"></option>`).join('')}</datalist></label>
    ${crmSelect('Направление услуги','direction',d.direction||'',[['','— Не указано'],...CRM_DIRECTIONS])}${crmField('Дата первой передачи в работу','work_started_on',d.work_started_on||'','date')}<p class="hint">Дата заполняется при первом переводе в работу. Для старых сделок укажите её вручную.</p>${crmField('Источник','source',d.source)}${crmField('Теги через запятую','tags',(d.tags||[]).join(', '))}
    ${crmSelect('Исполнитель','executor_id',d.executor_id||'',crmUsers())}${crmField('Дата окончания','deadline',d.deadline?.slice(0,10),'date')}
    </div><h3>Контакт</h3><div class="crm-form-grid">${[['name','Имя'],['email','Email'],['phone','Телефон'],['telegram','Telegram'],['position','Должность']].map(([k,l])=>crmField(l,'contact_'+k,contact[k]||'',k==='email'?'email':'text')).join('')}</div>
    ${contact.company?`<p class="hint">Компания контакта в amoCRM: ${esc(contact.company)}</p>`:''}
    <h3>Примечания</h3><div class="crm-notes">${(d.notes||[]).map(n=>`<p>${esc(typeof n==='string'?n:n.text)}</p>`).join('')||'<p class="hint">Примечаний пока нет</p>'}</div><label class="crm-field">Добавить примечание<textarea name="new_note" rows="3"></textarea></label>
    ${d.id?`<h3>Задачи</h3>${(d.tasks||[]).map(t=>`<div class="crm-task-line"><div><button type="button" class="crm-card-title" data-edit-task="${esc(t.id)}">${esc(t.title)}</button><div class="hint">${esc(userName(t.assigned_to)||'Без ответственного')} · ${esc(crmDT(t.due_at))} МСК · ${t.status==='done'?'Выполнено':'Не выполнено'}</div></div>${t.status==='open'?`<button class="btn" type="button" data-edit-complete="${esc(t.id)}">Выполнено</button>`:''}</div>`).join('')||'<p class="hint">Задач пока нет</p>'}<div class="crm-editor-actions"><button type="button" class="btn" id="crm-task-add">Добавить задачу</button><button type="button" class="btn" id="crm-client-open">Карточка клиента →</button><button type="button" class="btn" id="crm-upsell-add">Доп. продажа</button><button type="button" class="btn danger" id="crm-deal-delete">В отстойник</button></div>`:''}`;
  const el=crmDialog(d.id?'Карточка сделки':'Новая сделка',body,async f=>{
    const client=crm.clients.find(c=>c.name===f.client_name.trim());if(!client)throw Error('Выберите существующего клиента из списка. Нового клиента сначала создайте в «Клиенты 360».');
    const patch={title:f.title,client_id:client.id,responsible_id:f.responsible_id,stage:f.stage,budget:Number(f.budget),duties:Number(f.duties||0),paid:f.paid===''?null:Number(f.paid),service:f.service,direction:f.direction,work_started_on:f.work_started_on,source:f.source,tags:f.tags.split(',').map(x=>x.trim()).filter(Boolean),executor_id:f.executor_id||null,deadline:f.deadline,contact:{...contact,...Object.fromEntries(['name','email','phone','telegram','position'].map(k=>[k,f['contact_'+k]]))}};
    if(d.id)patch.revision=d.revision;
    if(d.parent_deal_id)patch.parent_deal_id=d.parent_deal_id;
    if(f.new_note.trim())patch.notes=[...(d.notes||[]),f.new_note.trim()];
    return crmWorkflow(d,patch);
  });
  if(!d.id){el.querySelector('[name="client_name"]').onchange=e=>{const c=crm.clients.find(x=>x.name===e.target.value);const t=c?.contacts?.[0];if(t)for(const k of ['name','email','phone','telegram']){const input=el.querySelector(`[name="contact_${k}"]`);if(!input.value)input.value=t[k]||'';}};}
  if(d.id){
    $('#crm-client-open').onclick=async()=>{crmClose();state.route='clients';history.replaceState(null,'','#/clients');state.clientView=d.client_id;state.clientDetail=null;renderAll();await loadClientDetail(d.client_id);};
    $('#crm-deal-delete').onclick=()=>{if(confirm('Переместить сделку в отстойник? Её можно будет восстановить.')){crmClose();crmMutation('/crm/deals/'+d.id,'DELETE',{revision:d.revision});}};
    el.querySelectorAll('[data-edit-task]').forEach(b=>b.onclick=()=>{if(confirm('Изменить задачу? Несохранённые изменения карточки не сохранятся.'))crmTaskForm(d,d.tasks.find(t=>t.id===b.dataset.editTask));});
    $('#crm-task-add').onclick=()=>{if(confirm('Перейти к новой задаче? Несохранённые изменения карточки не сохранятся.'))crmTaskForm(d);};
    $('#crm-upsell-add').onclick=()=>{if(confirm('Создать отдельную сделку для доп. продажи? Несохранённые изменения карточки не сохранятся.'))crmEdit({title:'Доп. продажа: '+d.title,client_id:d.client_id,parent_deal_id:d.id,stage:'new',responsible_id:d.responsible_id,budget:0,duties:0,paid:null,contact:{...contact},tags:['Доп. продажа'],notes:[],tasks:[]});};
    el.querySelectorAll('[data-edit-complete]').forEach(b=>b.onclick=async()=>{if(!confirm('Отметить задачу выполненной? Несохранённые изменения карточки не сохранятся.'))return;crmClose();await crmCompleteTask(d.id,b.dataset.editComplete);crmEdit(crm.deals.find(x=>x.id===d.id));});
  }
}
function crmTaskForm(d,t=null){
  crmDialog(t?'Изменить задачу':'Что нужно сделать?',crmField('Задача','title',t?.title||'','text',true)+crmSelect('Ответственный','assigned_to',t?.assigned_to||d.responsible_id||state.me.id,crmUsers(),true)+crmField('Дата и время · МСК','due_at',crmInputTime(t?.due_at),'datetime-local',true),async f=>{
    const task={title:f.title,assigned_to:f.assigned_to,due_at:crmISO(f.due_at)};
    if(!t)return crmSave(d,{revision:d.revision,task});
    crm.busy=true;
    try{await api('/crm/tasks/'+t.id,{method:'PATCH',body:jbody({...task,revision:t.revision,deal_revision:d.revision})});crmClose();await loadCrm();renderCrm();toast('Задача сохранена');}finally{crm.busy=false;}
  });
}
async function openCrmDealById(id){
  try{crmClose();state.route='crm';history.replaceState(null,'','#/crm');await loadCrm();renderAll();const d=crm.deals.find(x=>x.id===id);if(d)crmEdit(d);else toast('Сделка не найдена или перемещена в корзину',true);}catch(e){toast(e.message,true);}
}
