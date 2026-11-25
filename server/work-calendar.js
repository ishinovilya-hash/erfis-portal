// Federal five-day work calendar. Transfers: Government resolutions
// 24.09.2025 №1466 (2026), 17.09.2026 №1187 (2027).
// https://www.pravo.gov.ru/ ; https://www.mintrans.gov.ru/eye/press-center/branch-news/9491
const extraOff={2026:['01-09','03-09','05-11','12-31'],2027:['02-22','05-03','05-10','06-14','11-05','12-31']};
const extraWork={2026:[],2027:['02-20']};
const holidays=new Set(['01-01','01-02','01-03','01-04','01-05','01-06','01-07','01-08','02-23','03-08','05-01','05-09','06-12','11-04']);
export const moscowDate=(at=new Date())=>new Date(at.getTime()+10800000).toISOString().slice(0,10);
export function isWorkingDay(day){
 const year=Number(day.slice(0,4)),md=day.slice(5,10);
 if(!extraOff[year])throw Object.assign(Error(`Производственный календарь на ${year} год ещё не настроен`),{status:400});
 if(extraWork[year].includes(md))return true;
 return !holidays.has(md)&&!extraOff[year].includes(md)&&![0,6].includes(new Date(day+'T12:00:00Z').getUTCDay());
}
export function addWorkdays(day,count){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)throw Object.assign(Error('Неверная дата оплаты'),{status:400});
 if(!Number.isInteger(count)||Math.abs(count)>500)throw Object.assign(Error('Срок должен быть целым числом до 500 рабочих дней'),{status:400});
 isWorkingDay(day);let cursor=new Date(day+'T12:00:00Z'),remaining=Math.abs(count);
 while(remaining){cursor.setUTCDate(cursor.getUTCDate()+(count<0?-1:1));if(isWorkingDay(cursor.toISOString().slice(0,10)))remaining--;}
 return cursor.toISOString().slice(0,10);
}
export function deadlineAlert(deal,today=moscowDate()){
 if(deal.deleted_at||deal.stage!=='work'||!deal.deadline)return null;
 const due=deal.deadline.slice(0,10);
 if(due<today)return {kind:'overdue',due,label:'Срок сдачи просрочен'};
 if(due===today)return {kind:'today',due,label:'Срок сдачи сегодня'};
 try{if(today>=addWorkdays(due,-3))return {kind:'soon',due,label:'До сдачи не более 3 рабочих дней'};}catch{}
 return null;
}
