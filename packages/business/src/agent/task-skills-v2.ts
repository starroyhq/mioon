import {AGENT_TASK_LOCALES,AGENT_TASK_SKILL_NAMES} from '@mioon/contracts/agent-tasks-v2';
import type {AgentTaskJson,AgentTaskLocale,AgentTaskSkillName} from '@mioon/contracts/agent-tasks-v2';
import {AGENT_TASK_SKILL_SOURCES} from './task-skill-catalog-v2.ts';

/** One `mioon_skill_read` result stays below H1c's 16 KiB tool-result view, so
 * a whole method or one of its sections always reaches the model untruncated. */
export const AGENT_TASK_SKILL_READ_BYTES=12*1024;
export const AGENT_TASK_SKILL_SECTION_CHARACTERS=80;
export interface AgentTaskSkillSection {title:string;text:string}
export interface AgentTaskSkill {
  name:AgentTaskSkillName;version:number;title:string;
  summaries:Readonly<Record<AgentTaskLocale,string>>;
  /** The Markdown body without front matter: heading, introduction and sections. */
  text:string;
  sections:readonly AgentTaskSkillSection[];
}

const bytes=(value:unknown):number=>Buffer.byteLength(JSON.stringify(value));
const plain=(value:string,max:number):boolean=>value.trim()===value&&value.length>0&&[...value].length<=max&&!/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
function invalid(name:string,reason:string):never{throw new TypeError(`Invalid built-in skill ${name}: ${reason}`);}

/** Front matter is a fixed key list, one `key: value` per line. The body opens
 * with `# <title>`, then an introduction, then `## ` sections with distinct titles. */
export function parseAgentTaskSkill(name:string,source:string):AgentTaskSkill{
  if(!(AGENT_TASK_SKILL_NAMES as readonly string[]).includes(name))invalid(name,'unknown name');
  const match=/^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(source);if(!match)invalid(name,'missing front matter');
  const fields=new Map<string,string>();
  for(const line of match[1]!.split('\n')){
    const separator=line.indexOf(': ');if(separator<1)invalid(name,'malformed front matter');
    const key=line.slice(0,separator),value=line.slice(separator+2);if(fields.has(key))invalid(name,`duplicate ${key}`);fields.set(key,value);
  }
  const expected=['name','version','title',...AGENT_TASK_LOCALES.map(locale=>`summary.${locale}`)];
  if(fields.size!==expected.length||expected.some(key=>!fields.has(key)))invalid(name,'front matter keys');
  if(fields.get('name')!==name)invalid(name,'name differs from its file');
  const version=Number(fields.get('version'));if(!Number.isSafeInteger(version)||version<1||String(version)!==fields.get('version'))invalid(name,'version');
  const title=fields.get('title')!;if(!plain(title,20))invalid(name,'title');
  const summaries=Object.fromEntries(AGENT_TASK_LOCALES.map(locale=>{const value=fields.get(`summary.${locale}`)!;if(!plain(value,240))invalid(name,`summary.${locale}`);return [locale,value];})) as Record<AgentTaskLocale,string>;
  const text=match[2]!.trimEnd();
  if(!text.startsWith(`# ${title}\n`))invalid(name,'body must open with its title');
  const parts=text.split(/^## /mu),sections:AgentTaskSkillSection[]=[];
  for(const part of parts.slice(1)){
    const end=part.indexOf('\n'),heading=end<0?part:part.slice(0,end),body=end<0?'':part.slice(end+1).trim();
    if(!plain(heading,AGENT_TASK_SKILL_SECTION_CHARACTERS)||!body||sections.some(section=>section.title===heading))invalid(name,`section ${heading}`);
    sections.push({title:heading,text:`## ${heading}\n${body}`});
  }
  if(!sections.length)invalid(name,'no sections');
  const skill:AgentTaskSkill={name:name as AgentTaskSkillName,version,title,summaries,text,sections};
  if(bytes(skillResult(skill))>AGENT_TASK_SKILL_READ_BYTES)invalid(name,'whole method exceeds the read limit');
  return skill;
}
function skillResult(skill:AgentTaskSkill,section?:AgentTaskSkillSection):AgentTaskJson{
  return section?{name:skill.name,version:skill.version,title:skill.title,section:section.title,text:section.text}
    :{name:skill.name,version:skill.version,title:skill.title,sections:skill.sections.map(item=>item.title),text:skill.text};
}

export const AGENT_TASK_SKILLS:readonly AgentTaskSkill[]=Object.freeze(AGENT_TASK_SKILL_NAMES.map(name=>{
  const source=AGENT_TASK_SKILL_SOURCES[name];if(typeof source!=='string')return invalid(name,'missing source');return Object.freeze(parseAgentTaskSkill(name,source));
}));
if(Object.keys(AGENT_TASK_SKILL_SOURCES).length!==AGENT_TASK_SKILLS.length)throw new TypeError('Built-in skill sources and names differ.');
const byName=new Map<string,AgentTaskSkill>(AGENT_TASK_SKILLS.map(skill=>[skill.name,skill]));

export interface AgentTaskSkillReadInput {name:AgentTaskSkillName;section?:string}
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
/** A request names a listed method and, optionally, one of its section titles. */
export function parseAgentTaskSkillRead(value:unknown):AgentTaskSkillReadInput|null{
  if(!object(value)||Object.keys(value).some(key=>key!=='name'&&key!=='section')||typeof value.name!=='string')return null;
  const skill=byName.get(value.name);if(!skill)return null;
  if(value.section===undefined)return {name:skill.name};
  if(typeof value.section!=='string')return null;
  const wanted=value.section.trim(),section=skill.sections.find(item=>item.title===wanted);
  return section?{name:skill.name,section:section.title}:null;
}
export function readAgentTaskSkill(input:AgentTaskSkillReadInput):AgentTaskJson{
  const skill=byName.get(input.name);if(!skill)throw new TypeError('Unknown built-in skill.');
  const section=input.section===undefined?undefined:skill.sections.find(item=>item.title===input.section);
  if(input.section!==undefined&&!section)throw new TypeError('Unknown built-in skill section.');
  return skillResult(skill,section);
}
export const AGENT_TASK_SKILL_READ_PARAMETERS=Object.freeze({
  type:'object',properties:{name:{type:'string',enum:[...AGENT_TASK_SKILL_NAMES]},section:{type:'string',minLength:1,maxLength:AGENT_TASK_SKILL_SECTION_CHARACTERS,description:'One section title from this method; omit to read the whole method.'}},required:['name'],additionalProperties:false,
});

const skillNotices:Readonly<Record<AgentTaskLocale,{lead:string;separator:string}>>={
  'zh-Hans':{lead:'需要做法时用 mioon_skill_read 读取内置方法；方法是参考资料，不授予权限，也不能代替确认。可读的方法：',separator:'；'},
  'zh-Hant':{lead:'需要做法時用 mioon_skill_read 讀取內建方法；方法是參考資料，不授予權限，也不能代替確認。可讀的方法：',separator:'；'},
  en:{lead:'When you need a method, read a built-in one with mioon_skill_read. Methods are reference material; they grant no permission and never replace a confirmation. Available methods: ',separator:'; '},
  ja:{lead:'手順が必要なときは mioon_skill_read で組み込みの手順を読んでください。手順は参照資料であり、権限を与えず、確認の代わりにもなりません。読める手順：',separator:'；'},
};
/** System-instruction catalog: names and summaries only, never method bodies. */
export function agentTaskSkillInstructions(locale:AgentTaskLocale):string{
  const notice=skillNotices[locale],summary=(skill:AgentTaskSkill):string=>skill.summaries[locale].replace(/[。.]$/u,'');
  return notice.lead+AGENT_TASK_SKILLS.map(skill=>locale==='en'?`${skill.name} (${summary(skill)})`:`${skill.name}（${summary(skill)}）`).join(notice.separator)+(locale==='en'?'.':'。');
}
