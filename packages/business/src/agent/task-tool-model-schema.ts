type SchemaObject=Record<string,unknown>;
const object=(value:unknown):value is SchemaObject=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const hidden=new Set(['projectId','requestId']);
const invalid=():never=>{throw Error('Agent tool schema contains an unresolved or recursive reference.');};
function reference(root:unknown,value:unknown):unknown{
 if(typeof value!=='string'||value!=='#'&&!value.startsWith('#/'))return invalid();
 let pointer:string;try{pointer=decodeURIComponent(value.slice(1));}catch{return invalid();}
 if(/~(?![01])/u.test(pointer))return invalid();
 let target=root;
 for(const token of pointer.split('/').slice(1)){
  const field=token.replaceAll('~1','/').replaceAll('~0','~');
  if((!object(target)&&!Array.isArray(target))||!Object.hasOwn(target,field))return invalid();
  target=(target as SchemaObject)[field];
 }
 if(!object(target)&&typeof target!=='boolean')return invalid();return target;
}
/** Compare inline conversion against the original standalone schema before
 * removing host fields. Resolving first preserves references to their concrete
 * constraints; recursive/unresolved schemas fail instead of becoming `any`. */
export function projectAgentTaskToolSchema(source:unknown):unknown{
 function project(value:unknown,ancestors:ReadonlySet<string>,depth:number):unknown{
  if(depth>128)return invalid();
  if(Array.isArray(value))return value.map(child=>project(child,ancestors,depth+1));
  if(!object(value))return value;
  if(Object.hasOwn(value,'$ref')){
   const ref=value.$ref;if(typeof ref!=='string'||ancestors.has(ref))return invalid();
   const next=new Set(ancestors);next.add(ref);
   const resolved=project(reference(source,ref),next,depth+1),siblings=Object.fromEntries(Object.entries(value).filter(([key])=>key!=='$ref'));
   if(!Object.keys(siblings).length)return resolved;
   if(!object(resolved))return invalid();
   return {...resolved,...project(siblings,ancestors,depth+1) as SchemaObject};
  }
  return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,
   key==='properties'&&object(child)?Object.fromEntries(Object.entries(child).filter(([field])=>!hidden.has(field)).map(([field,nested])=>[field,project(nested,ancestors,depth+1)])):
   key==='required'&&Array.isArray(child)?child.filter(field=>!hidden.has(String(field))):project(child,ancestors,depth+1),
  ]));
 }
 return project(source,new Set(),0);
}
