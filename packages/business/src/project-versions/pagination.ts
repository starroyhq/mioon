import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {versionError} from './repository.ts';
const secret=randomBytes(32);
export function encodeCursor(value:Record<string,unknown>):string{
  const body=Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
}
export function decodeCursor(cursor:string):Record<string,unknown>{
  try{
    const [body,signature,...rest]=cursor.split('.');
    if(!body||!signature||rest.length||cursor.length>4096)throw Error();
    const expected=createHmac('sha256',secret).update(body).digest(),got=Buffer.from(signature,'base64url');
    if(got.length!==expected.length||!timingSafeEqual(got,expected))throw Error();
    const value:unknown=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error();
    return value as Record<string,unknown>;
  }catch{throw versionError('PROJECT_VERSION_CURSOR_INVALID','版本分页游标无效、已过期或不属于此请求。',400);}
}
