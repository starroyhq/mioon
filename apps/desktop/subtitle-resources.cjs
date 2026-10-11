const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const SUBTITLE_RESOURCE_FILES=Object.freeze(['mioon-subtitle-cjk-sc-v1.otf','OFL-1.1.txt','SOURCE-COPYRIGHT.txt','README.md','extract-font.py']);
const FONT_SHA256='7b13c45bba411924f99c1ee26e1a5ee1ea7fc768503a4d03987d587e16a72e99';
const RESOURCE_HASHES=Object.freeze({
 'mioon-subtitle-cjk-sc-v1.otf':FONT_SHA256,
 'OFL-1.1.txt':'cacb4866bed89a54fc5b1bc163989bca8d8fb72bc0517fdaa70db7325ba666ec',
 'SOURCE-COPYRIGHT.txt':'849f4ea9c214fa4ac3593b770c699f387534b11ce671264c1b10d85bdcb5997b',
 'README.md':'0bd10c7fed09a7c54fe82e5e58129ce538ae1c65974acb04a90708cff7c6d7c5',
 'extract-font.py':'a480fb8f194522d2eb00de575182aeb0808b3e3832b76c374af0b48f9f569a96',
});
const RESOURCE_BYTES=Object.freeze({'mioon-subtitle-cjk-sc-v1.otf':16437296,'OFL-1.1.txt':4219,'SOURCE-COPYRIGHT.txt':14712,'README.md':2283,'extract-font.py':1244});
const SUBTITLE_RESOURCE_MANIFEST=Object.freeze(Object.fromEntries(SUBTITLE_RESOURCE_FILES.map(name=>[name,Object.freeze({bytes:RESOURCE_BYTES[name],sha256:RESOURCE_HASHES[name]})])));
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
async function verifySubtitleResources(directory){
 const parent=await fs.lstat(directory);if(!parent.isDirectory()||parent.isSymbolicLink())throw Error('Invalid subtitle resource directory');
 const found=(await fs.readdir(directory)).sort();if(JSON.stringify(found)!==JSON.stringify([...SUBTITLE_RESOURCE_FILES].sort()))throw Error('Unexpected subtitle resource entry');
 const result={};
 for(const name of SUBTITLE_RESOURCE_FILES){
  const file=path.join(directory,name),before=await fs.lstat(file),font=name.endsWith('.otf');
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size!==RESOURCE_BYTES[name])throw Error('Invalid subtitle resource file');
  const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
  try{
   const initial=await handle.stat();if(!same(before,initial))throw Error('Subtitle resource changed');
   const buffer=Buffer.alloc(64*1024),hash=createHash('sha256');let bytes=0;
   while(bytes<before.size){const part=await handle.read(buffer,0,Math.min(buffer.length,before.size-bytes),bytes);if(!part.bytesRead)throw Error('Truncated subtitle resource');hash.update(buffer.subarray(0,part.bytesRead));bytes+=part.bytesRead;}
   if((await handle.read(buffer,0,1,bytes)).bytesRead||!same(initial,await handle.stat())||!same(initial,await fs.lstat(file)))throw Error('Subtitle resource changed');
   const sha256=hash.digest('hex');if(sha256!==RESOURCE_HASHES[name])throw Error(font?'Subtitle font hash mismatch':'Subtitle notice/provenance hash mismatch');result[name]={bytes,sha256};
  }finally{await handle.close();}
 }
 return result;
}
function packagedSubtitleDirectory(context){
 if(typeof context.appOutDir!=='string'||!path.isAbsolute(context.appOutDir))throw Error('Invalid package directory');
 if(context.electronPlatformName==='linux'||context.electronPlatformName==='win32')return path.join(context.appOutDir,'resources','subtitles');
 if(context.electronPlatformName!=='darwin'&&context.electronPlatformName!=='mas')throw Error('Unsupported package platform');
 const name=context.packager?.appInfo?.productFilename;if(typeof name!=='string'||!name||/[\\/\0]/.test(name)||name==='.'||name==='..')throw Error('Invalid application name');
 return path.join(context.appOutDir,`${name}.app`,'Contents','Resources','subtitles');
}
module.exports={SUBTITLE_RESOURCE_FILES,SUBTITLE_RESOURCE_MANIFEST,FONT_SHA256,verifySubtitleResources,packagedSubtitleDirectory};
