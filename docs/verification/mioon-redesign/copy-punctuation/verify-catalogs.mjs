import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import * as before from './before/i18n/index.ts';
import * as after from '/Users/kouzen/.codex/worktrees/mioon-redesign/mioon/packages/i18n/src/index.ts';
const strip=text=>text.replace(/(?:。|(?<!\.)\.)(?=[\t \r]*(?:\n|$))/gu,'');
assert.deepEqual(Object.keys(after.catalogs),Object.keys(before.catalogs));assert.deepEqual(after.validateCatalogs(),[]);
let templates=0,changed=0,ellipsis=0,paragraphs=0;
for(const [key,entry] of Object.entries(before.catalogs))for(const locale of before.LOCALES){
 const old=entry[locale],now=after.catalogs[key][locale],pairs=typeof old==='string'?[[old,now]]:[[old.one,now.one],[old.other,now.other]];
 for(const [oldText,newText] of pairs){templates++;assert.equal(newText,strip(oldText),key+'/'+locale);if(oldText!==newText)changed++;if(/(?:…|\.{2,})$/u.test(oldText)){assert.equal(newText,oldText);ellipsis++;}if(oldText.includes('\n\n'))paragraphs++;}
}
for(const value of ['用户输入。','User text.','example.json','https://example.test/a.b','Wait...'])assert.equal(after.renderMessage('en',value),value);
const paramCase=Object.entries(after.catalogs).find(([,entry])=>typeof entry.en==='string'&&/\{[A-Za-z][A-Za-z0-9_]*\}$/u.test(entry.en));assert.ok(paramCase);const[key,entry]=paramCase;const params=Object.fromEntries([...entry.en.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)].map(([,name])=>[name,name==='count'?2:'file.name.']));assert.ok(after.translate('en',key,params).endsWith('file.name.'));
const report={templates,changedActiveTemplates:changed,preservedEllipsisTemplates:ellipsis,multiParagraphTemplates:paragraphs,localeAndPlaceholderParity:true,rawUserContentUntouched:true,parameterPunctuationUntouched:true};await writeFile(new URL('./catalog-verification.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
