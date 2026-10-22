/* Uses the existing portal's forms, registry columns and object side panel. */
const CLIENT_TYPE_LABELS={trademark:'Товарные знаки',patent:'Патенты',software:'Программы для ЭВМ',contract:'Договоры',refused:'Отказные объекты'};
const CLIENT_OPFS=['','ООО','АО','ЗАО','ИП','физ. лицо'];

function clientPickerMarkup(src,label){
  return `<div class="field"><label for="client-holder-input">${label} — Клиенты 360</label><input data-k="holder" id="client-holder-input" type="text" role="combobox" aria-autocomplete="list" aria-controls="client-holder-results" aria-expanded="false" value="${esc(src.holder||'')}" placeholder="Начните вводить наименование или ИНН…" autocomplete="off"/><div id="client-holder-results" role="listbox" style="max-height:220px;overflow:auto"></div><div id="client-holder-create"></div><div class="hint" id="client-holder-hint">${src.clientId?'Карточка выбрана.':'Начните вводить название и выберите клиента.'}</div></div>`;
}
function bindClientPicker(panel,ps){
  const input=panel.querySelector('#client-holder-input'),results=panel.querySelector('#client-holder-results'),create=panel.querySelector('#client-holder-create'),hint=panel.querySelector('#client-holder-hint');
  let matches=[],active=-1;
  const choose=c=>{ps.draft.clientId=c.id;ps.draft.holder=c.name;input.value=c.name;results.innerHTML='';create.innerHTML='';matches=[];active=-1;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');hint.textContent='Карточка выбрана.';};
  const show=()=>{
    const q=input.value.trim().toLowerCase();
    matches=(state.clientOptions||[]).filter(c=>c.name.toLowerCase().includes(q)||(q&&c.inn.includes(q))).slice(0,20);active=-1;
    input.removeAttribute('aria-activedescendant');input.setAttribute('aria-expanded','true');
    results.innerHTML=matches.map((c,i)=>`<button type="button" class="btn" role="option" aria-selected="false" id="client-option-${i}" data-pick-client="${i}" style="display:block;width:100%;text-align:left;margin-top:5px">${esc(c.name)}${c.inn?' · ИНН '+esc(c.inn):''}</button>`).join('');
    create.innerHTML=!matches.length&&q?'<div class="hint" style="margin:8px 0">Совпадений не найдено</div><button type="button" class="btn primary" id="client-create-from-object">＋ Добавить клиента</button>':'';
    results.querySelectorAll('[data-pick-client]').forEach(b=>b.onclick=()=>choose(matches[Number(b.dataset.pickClient)]));
    const add=create.querySelector('button');if(add)add.onclick=()=>{
      state.clientReturn={panel:ps,route:state.route,clientView:state.clientView,contractKind:state.contractKind};
      const name=input.value.trim();closePanel();state.clientView=null;state.clientDetail=null;
      state.clientForm={name,inn:'',opf:'',website:'',contacts:[]};state.clientLink=null;go('clients');
    };
  };
  input.onfocus=show;
  input.oninput=()=>{
    ps.draft.holder=input.value;
    const exact=(state.clientOptions||[]).filter(c=>c.name.trim().toLowerCase()===input.value.trim().toLowerCase());
    ps.draft.clientId=exact.length===1?exact[0].id:'';
    hint.textContent=ps.draft.clientId?'Карточка выбрана.':'Выберите клиента из подсказок или добавьте нового.';show();
  };
  input.onkeydown=e=>{
    if(e.key==='Escape'){results.innerHTML='';create.innerHTML='';matches=[];active=-1;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');return;}
    if(['ArrowDown','ArrowUp'].includes(e.key)&&matches.length){e.preventDefault();active=(active+(e.key==='ArrowDown'?1:matches.length-1)+matches.length)%matches.length;results.querySelectorAll('[role="option"]').forEach((b,i)=>b.setAttribute('aria-selected',String(i===active)));input.setAttribute('aria-activedescendant','client-option-'+active);results.querySelector('#client-option-'+active)?.scrollIntoView({block:'nearest'});}
    if(e.key==='Enter'&&active>=0&&matches[active]){e.preventDefault();choose(matches[active]);}
  };
}
function returnToClientObject(client=null){
  const back=state.clientReturn;if(!back)return false;
  state.clientReturn=null;state.clientForm=null;state.clientView=back.clientView;
  if(client)Object.assign(back.panel.draft,{clientId:client.id,holder:client.name});
  state.clientOptions=state.clientsList||state.clientOptions;
  go(back.route);state.contractKind=back.contractKind;state.panel=back.panel;renderAll();renderPanel();return true;
}

async function loadClientDetail(id){
  state.clientView=id;state.clientDetail=null;state.clientForm=null;state.clientLink=null;
  renderClients();
  try{const d=await api('/clients/'+encodeURIComponent(id));if(state.clientView===id){state.clientDetail=d;renderClients();}}
  catch(e){toast(e.message,true);state.clientView=null;renderClients();}
}
function editClient(c=null){
  state.clientReturn=null;
  state.clientForm=c?JSON.parse(JSON.stringify(c)):{name:'',inn:'',opf:'',website:'',contacts:[]};
  state.clientLink=null;renderClients();
}
function clientTable(type,rows){
  const cols=type==='contract'?[{key:'regNumber',label:'№ договора',cls:'mono'},{key:'priorityDate',label:'Дата договора',cls:'mono'}]:REG[type].cols;
  return `<div class="tablewrap" data-client-table="${type}"><table><thead><tr>${cols.map(c=>`<th>${c.label}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.map(o=>rowHtml(o,cols)).join(''):`<tr><td colspan="${cols.length}"><div class="empty">${type==='contract'?'Договоров пока нет':'Записей пока нет'}</div></td></tr>`}</tbody></table></div>`;
}
function bindClientTables(d){
  document.querySelectorAll('[data-client-table]').forEach(table=>{
    const type=table.dataset.clientTable;
    table.querySelectorAll('tr[data-id]').forEach(tr=>{
      tr.tabIndex=0;const open=e=>{if(!e.target.closest('button'))openDetail(tr.dataset.id);};
      if(type==='contract')tr.onclick=open;else tr.ondblclick=open;
      tr.onkeydown=e=>{if(e.key==='Enter'&&e.target===tr)openDetail(tr.dataset.id);};
    });
    table.querySelectorAll('[data-copy]').forEach(b=>{
      b.ondblclick=e=>e.stopPropagation();b.onclick=async e=>{e.stopPropagation();try{await navigator.clipboard.writeText(b.dataset.copy);toast('Номер скопирован');}catch{toast('Выделите номер вручную',true);}};
    });
    table.querySelectorAll('[data-return]').forEach(b=>b.onclick=e=>{e.stopPropagation();changeRefused(d.objects.refused.find(o=>o.id===b.dataset.return),false);});
  });
}
function renderClientForm(){
  const f=state.clientForm;
  const input=(label,key,type='text')=>`<div class="field"><label>${label}</label><input data-cf="${key}" type="${type}" value="${esc(f[key]||'')}"/></div>`;
  $('#view').innerHTML=`<h2>${f.id?'Редактирование карточки':'Новая карточка'}</h2><div class="listcard" style="padding:20px">
    <div class="field"><label>ОПФ</label><select data-cf="opf">${CLIENT_OPFS.map(v=>`<option value="${v}" ${f.opf===v?'selected':''}>${v||'— не указана'}</option>`).join('')}</select></div>
    ${input('Наименование','name')}${input('ИНН (10 или 12 цифр; если неизвестен — оставьте пустым)','inn')}${input('Сайт','website','url')}
    <h3>Контактная информация</h3>
    ${f.contacts.map((c,i)=>`<div style="padding:12px 0;border-bottom:1px solid var(--hairline)"><div class="grid2">${[['name','Имя'],['email','Email'],['phone','Телефон'],['telegram','Telegram']].map(([k,l])=>`<div class="field"><label>${l}</label><input data-contact="${i}" data-contact-key="${k}" type="${k==='email'?'email':k==='phone'?'tel':'text'}" value="${esc(c[k]||'')}"/></div>`).join('')}</div><button class="btn danger" data-remove-contact="${i}">Убрать контакт</button></div>`).join('')}
    <button class="btn" id="client-contact-add" style="margin:14px 0">Добавить контакт</button>
    <div class="hint">Объекты этой карточки также отображаются в общих реестрах. Договоры добавляются по мере заключения.</div>
    <div style="display:flex;gap:12px;margin-top:18px"><button class="btn primary" id="client-save" ${f.busy?'disabled':''}>Сохранить</button><button class="btn" id="client-cancel">Отмена</button></div></div>`;
  document.querySelectorAll('[data-cf]').forEach(el=>el.oninput=()=>f[el.dataset.cf]=el.value);
  document.querySelectorAll('[data-contact]').forEach(el=>el.oninput=()=>f.contacts[Number(el.dataset.contact)][el.dataset.contactKey]=el.value);
  document.querySelectorAll('[data-remove-contact]').forEach(b=>b.onclick=()=>{f.contacts.splice(Number(b.dataset.removeContact),1);renderClients();});
  $('#client-contact-add').onclick=()=>{if(f.contacts.length>=20){toast('Максимум 20 контактов',true);return;}f.contacts.push({name:'',email:'',phone:'',telegram:''});renderClients();};
  $('#client-cancel').onclick=()=>{if(confirm('Закрыть без сохранения?')){if(returnToClientObject())return;state.clientForm=null;renderClients();}};
  $('#client-save').onclick=async()=>{
    if(f.busy)return;f.busy=true;renderClients();
    try{const res=await api('/clients'+(f.id?'/'+f.id:''),{method:f.id?'PATCH':'POST',body:jbody(f)});Object.assign(f,{id:res.client.id,revision:res.client.revision});state.clientsList=(await api('/clients')).clients;if(returnToClientObject(res.client)){toast('Клиент создан и выбран. Продолжите заполнение объекта.');return;}await loadClientDetail(res.client.id);toast('Карточка сохранена');}
    catch(e){f.busy=false;renderClients();toast(e.message,true);}
  };
}
async function beginClientLink(d){
  try{
    const types=['trademark','patent','software','refused','contract'];
    const data=await Promise.all(types.map(t=>api('/objects?type='+t)));
    if(state.clientView!==d.id)return;
    state.clientLink={items:data.flatMap(x=>x.objects).filter(o=>o.clientId!==d.id),q:''};renderClients();
  }catch(e){toast(e.message,true);}
}
function renderClientLink(d){
  const l=state.clientLink,q=l.q.toLowerCase();
  const rows=l.items.filter(o=>[o.name,o.holder,o.appNumber,o.regNumber].some(v=>String(v||'').toLowerCase().includes(q)));
  return `<div class="listcard" style="padding:16px;margin:16px 0"><h3>Привязать существующую запись</h3><div class="hint">При переносе от другой карточки изменится правообладатель / контрагент записи. Копия не создаётся.</div><input id="client-link-search" placeholder="Поиск по названию, владельцу, номеру" value="${esc(l.q)}" style="width:100%;margin:12px 0"/><div style="max-height:350px;overflow:auto">${rows.slice(0,80).map(o=>`<div class="lrow"><div class="lr-main"><div>${esc(o.name)} · ${esc(o.regNumber||o.appNumber||'без номера')}</div><div class="hint">${esc(CLIENT_TYPE_LABELS[o.type])} · ${esc(o.holder||'Без владельца')}${o.refusedAt?' · Отказной':''}</div></div><button class="btn" data-link-object="${esc(o.id)}">Привязать</button></div>`).join('')||'Ничего не найдено'}</div><div class="hint">Показано ${Math.min(rows.length,80)} из ${rows.length}. Уточните поиск.</div><button class="btn" id="client-link-close">Закрыть</button></div>`;
}
function renderClients(){
  if(state.clientForm){renderClientForm();return;}
  if(state.clientView){
    const d=state.clientDetail;if(!d){$('#view').innerHTML='<div class="pageloader">Загрузка…</div>';return;}
    $('#view').innerHTML=`<div class="toolbar"><button class="btn" id="client-back">← Все клиенты</button><span class="spacer"></span><button class="btn" id="client-edit">Редактировать карточку</button></div>
      <h2>${esc(d.name)}</h2><div class="hint" style="margin:8px 0 18px">ОПФ: ${esc(d.opf||'не указана')} · ИНН: ${esc(d.inn||'не указан')}</div>
      ${d.website?`<div class="field"><label>Сайт</label><div class="val">${esc(d.website)}</div></div>`:''}
      <h3>Контактная информация</h3><div class="listcard" style="margin-bottom:20px">${d.contacts.length?d.contacts.map(c=>`<div class="lrow"><div class="lr-main"><div>${esc(c.name||'Контакт')}</div><div class="lr-s">Email: ${esc(c.email||'—')} · Телефон: ${esc(c.phone||'—')} · Telegram: ${esc(c.telegram||'—')}</div></div></div>`).join(''):'<div class="empty">Контакты пока не добавлены</div>'}</div>
      <h3>Договоры</h3>${clientTable('contract',d.objects.contract)}<button class="btn" data-client-create="contract" style="margin:12px 0">Добавить договор</button>
      <h3>Объекты</h3><div class="toolbar">${['trademark','patent','software'].map(t=>`<button class="btn" data-client-create="${t}">${REG[t].add}</button>`).join('')}<button class="btn" id="client-link">Привязать существующий</button></div>
      ${state.clientLink?renderClientLink(d):''}<div class="hint">Двойной щелчок по объекту — открыть карточку. Номера можно копировать кнопкой ⧉.</div>
      ${['trademark','patent','software'].map(t=>`<h3 class="price-cat">${CLIENT_TYPE_LABELS[t]} (${d.objects[t].length})</h3>${clientTable(t,d.objects[t])}`).join('')}
      ${d.objects.refused.length?`<h3 class="price-cat">Отказные объекты (${d.objects.refused.length})</h3>${clientTable('refused',d.objects.refused)}`:''}
      <h3 class="price-cat">Технические задания</h3><div class="listcard"><div class="empty">Технических заданий пока нет</div></div>`;
    $('#client-back').onclick=()=>{state.clientView=null;state.clientDetail=null;state.clientLink=null;renderClients();};
    $('#client-edit').onclick=()=>editClient(d);
    $('#client-link').onclick=()=>beginClientLink(d);
    document.querySelectorAll('[data-client-create]').forEach(b=>b.onclick=()=>{
      if(b.dataset.clientCreate==='contract')state.contractKind=d.opf==='физ. лицо'?'individual':'legal';
      openCreate(b.dataset.clientCreate,d);
    });
    bindClientTables(d);
    if(state.clientLink){
      $('#client-link-close').onclick=()=>{state.clientLink=null;renderClients();};
      $('#client-link-search').oninput=e=>{const pos=e.target.selectionStart;state.clientLink.q=e.target.value;renderClients();const el=$('#client-link-search');el.focus();el.setSelectionRange(pos,pos);};
      document.querySelectorAll('[data-link-object]').forEach(b=>b.onclick=async()=>{
        const o=state.clientLink.items.find(x=>x.id===b.dataset.linkObject);
        if(!confirm(`Привязать «${o.name}» к «${d.name}»?${o.holder?' Прежний правообладатель / контрагент: '+o.holder+'.':''}`))return;
        b.disabled=true;
        try{await api('/objects/'+o.id,{method:'PATCH',body:jbody({clientId:d.id,confirmRelink:true})});await refresh();state.clientLink=null;renderClients();toast('Запись привязана');}
        catch(e){b.disabled=false;toast(e.message,true);}
      });
    }
    return;
  }
  const list=state.clientsList;if(!list){$('#view').innerHTML='<div class="pageloader">Загрузка…</div>';return;}
  const q=String(state.clientsQ||'').toLowerCase();
  const filtered=list.filter(c=>[c.name,c.inn,...c.contacts.flatMap(x=>Object.values(x))].some(v=>String(v).toLowerCase().includes(q)));
  $('#view').innerHTML=`<div class="toolbar"><input id="clients-search" placeholder="Название, ИНН или контакт…" value="${esc(state.clientsQ||'')}" style="flex:1;min-width:160px"/><button class="btn primary" id="client-add">Добавить карточку</button></div><div class="hint" style="margin-bottom:14px">${filtered.length} карточек. Клиенты связаны с объектами по постоянному идентификатору.</div><div class="listcard">${filtered.map(c=>`<div class="lrow" data-client="${esc(c.id)}" tabindex="0" role="button" style="cursor:pointer"><div class="lr-main"><div class="lr-t">${esc(c.name)}</div><div class="lr-s">${esc(c.opf||'ОПФ не указана')} · ИНН: ${esc(c.inn||'не указан')} · ${c.total} записей</div></div></div>`).join('')||'<div class="empty">Карточек не найдено</div>'}</div>`;
  $('#client-add').onclick=()=>editClient();
  $('#clients-search').oninput=e=>{const pos=e.target.selectionStart;state.clientsQ=e.target.value;renderClients();const el=$('#clients-search');el.focus();el.setSelectionRange(pos,pos);};
  document.querySelectorAll('[data-client]').forEach(el=>{el.onclick=()=>loadClientDetail(el.dataset.client);el.onkeydown=e=>{if(e.key==='Enter')loadClientDetail(el.dataset.client);};});
}
