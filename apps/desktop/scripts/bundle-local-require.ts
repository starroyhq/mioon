import path from 'node:path';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';

/** Typed adapters keep legacy JS behind unknown when checked by tsc. esbuild
 * cannot trace createRequire aliases, so expose only their statically verified
 * relative calls to the bundler. Application sources and frozen catalogs stay
 * intact; dynamic or escaped require capabilities fail the build. */
export function exposeLocalRequire(source,filename){
  const declaration='const require = createRequire(import.meta.url);';
  if(!source.includes(declaration))return null;
  const file=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  let statement;
  for(const node of file.statements){
    if(ts.isVariableStatement(node)&&node.declarationList.flags&ts.NodeFlags.Const&&node.declarationList.declarations.length===1){
      const item=node.declarationList.declarations[0];
      if(ts.isIdentifier(item.name)&&item.name.text==='require'&&node.getText(file)===declaration)statement=node;
    }
  }
  if(!statement)throw new Error(`Unsupported local require declaration: ${filename}`);
  function visit(node){
    if(node===statement)return;
    if(ts.isIdentifier(node)&&node.text==='require'){
      const call=node.parent,arg=ts.isCallExpression(call)?call.arguments[0]:undefined;
      if(!ts.isCallExpression(call)||call.expression!==node||call.arguments.length!==1||!arg||!ts.isStringLiteral(arg)||!/^\.{1,2}\//u.test(arg.text)||arg.text.includes('\0'))throw new Error(`Non-static local require in desktop adapter: ${filename}`);
    }
    ts.forEachChild(node,visit);
  }
  visit(file);
  return source.slice(0,statement.getStart(file))+source.slice(statement.end);
}

export function localRequireBundlePlugin(root){
  const owned=[['packages','business','src'],['packages','contracts','src'],['apps','server','src']].map(parts=>path.join(path.resolve(root),...parts)+path.sep);
  return {name:'mioon-static-legacy-adapters',setup(build){
    build.onLoad({filter:/\.ts$/},async args=>{
      if(!owned.some(directory=>args.path.startsWith(directory)))return null;
      const contents=exposeLocalRequire(await readFile(args.path,'utf8'),args.path);
      return contents===null?null:{contents,loader:'ts',resolveDir:path.dirname(args.path)};
    });
  }};
}
