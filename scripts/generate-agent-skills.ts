import {readdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// The desktop backend is bundled by esbuild, so Mio's built-in methods cannot
// be read from Markdown files at run time. Their sources stay reviewable as
// Markdown and are embedded verbatim; tests check this file matches them.
const sources=new URL('../packages/business/src/agent/skills/',import.meta.url);
const target=new URL('../packages/business/src/agent/task-skill-catalog-v2.ts',import.meta.url);

export function renderAgentTaskSkillCatalog():string{
 const files=readdirSync(sources).filter(name=>name.endsWith('.md')).sort();
 const entries=Object.fromEntries(files.map(name=>[name.slice(0,-'.md'.length),readFileSync(new URL(name,sources),'utf8')]));
 return '// Generated with node scripts/generate-agent-skills.ts from packages/business/src/agent/skills/*.md.\n'+
  '// Edit the Markdown sources and regenerate; the skills test checks this file matches them.\n'+
  'export const AGENT_TASK_SKILL_SOURCES:Readonly<Record<string,string>>=Object.freeze('+JSON.stringify(entries,null,1)+');\n';
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))writeFileSync(target,renderAgentTaskSkillCatalog());
