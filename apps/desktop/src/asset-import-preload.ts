const channel='mioon:asset-import';
export interface NativeAssetSelection {readonly token:string;readonly name:string}
export interface AssetImportBridge {choose():Promise<NativeAssetSelection[]>;files(files:readonly File[]):Promise<NativeAssetSelection[]>;import(token:string,requestId:string):Promise<unknown>}
export function createAssetImportBridge({invoke,pathForFile}:{invoke:(channel:string,input:unknown)=>Promise<unknown>;pathForFile:(file:File)=>string}):AssetImportBridge{
 const selected=async(input:unknown):Promise<NativeAssetSelection[]>=>{
  const value=await invoke(channel,input);if(!Array.isArray(value)||value.length>100||value.some(item=>!item||typeof item!=='object'||typeof item.token!=='string'||typeof item.name!=='string'||Object.keys(item).sort().join(',')!=='name,token'))throw Error('Invalid native asset selection.');return value;
 };
 return Object.freeze({choose:()=>selected({action:'choose'}),files:(files:readonly File[])=>{
  if(!Array.isArray(files)||files.length<1||files.length>100)return Promise.reject(Error('Invalid native file selection.'));
  // webUtils obtains the OS backing path; a synthetic renderer File has none.
  const paths=files.map(file=>pathForFile(file));if(paths.some(file=>!file))return Promise.reject(Error('The file is not backed by an OS selection.'));
  return selected({action:'drop',paths});
 },import:(token:string,requestId:string)=>invoke(channel,{action:'import',token,requestId})});
}
