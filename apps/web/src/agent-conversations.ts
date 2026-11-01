import type {Locale} from '../../../packages/i18n/src/index.ts';

export type ConversationDay='today'|'yesterday'|'earlier';
export function conversationDay(updatedAt:string,now=new Date()):ConversationDay {
  const date=new Date(updatedAt),day=(value:Date)=>`${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
  if(!Number.isFinite(date.getTime()))return 'earlier';if(day(date)===day(now))return 'today';
  const yesterday=new Date(now);yesterday.setDate(now.getDate()-1);return day(date)===day(yesterday)?'yesterday':'earlier';
}
export function conversationTime(updatedAt:string,locale:Locale,day:ConversationDay):string {
  const date=new Date(updatedAt);if(!Number.isFinite(date.getTime()))return '';
  return new Intl.DateTimeFormat(locale,day==='earlier'?{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}:{hour:'2-digit',minute:'2-digit'}).format(date);
}
export function conversationMatches(title:string,query:string,locale:Locale):boolean {return title.toLocaleLowerCase(locale).includes(query.trim().toLocaleLowerCase(locale));}
