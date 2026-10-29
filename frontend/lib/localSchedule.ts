/** datetime-local uses the browser local wall clock, never UTC substring. */
export function localScheduleMinimum(now:number){
 const date=new Date(now+60000);if(!Number.isFinite(date.getTime()))return '';
 const pad=(value:number)=>String(value).padStart(2,'0');
 return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
