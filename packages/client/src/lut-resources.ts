import {createHash} from 'node:crypto';
import {isLutResponse,lutImportInputSchema,lutImportResponseSchema,LUT_RESOURCE_LIMITS} from '@mioon/contracts/lut-resources';

/** Node shared-client ACK validation binds the response to the exact submitted
 * byte identity, not just a matching project, display name or request key. */
export function isLutRpcResponse(operation:string,input:unknown,value:unknown):boolean {
  if(!isLutResponse(operation,input,value))return false;
  if(operation!=='lut.import')return true;
  const parsed=lutImportInputSchema.safeParse(input),result=lutImportResponseSchema.safeParse(value);
  if(!parsed.success||!result.success)return false;
  const encoded=parsed.data.dataBase64;
  if(encoded.length%4||!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded))return false;
  const bytes=Buffer.from(encoded,'base64');
  return bytes.length>0&&bytes.length<=LUT_RESOURCE_LIMITS.sourceBytes&&bytes.toString('base64')===encoded&&
    result.data.resource.sizeBytes===bytes.length&&result.data.resource.sha256===createHash('sha256').update(bytes).digest('hex');
}
