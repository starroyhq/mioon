import {ClientError} from '@mioon/client';
/** Path imports describe the backend machine, never the CLI machine across a
 * remote connection. The shared connection loader independently enforces its
 * existing local-origin policy for every descriptor/token-file path. */
export function assertLocalAssetImportOrigin(base:string|undefined):void {
 if(base===undefined)return;
 let url:URL;
 try{url=new URL(base);}catch{throw new ClientError('VALIDATION_ERROR','Path import requires a backend on this machine. Use explicit --upload to send bytes instead of a local path.');}
 if(!['127.0.0.1','localhost'].includes(url.hostname)||url.protocol!=='http:')throw new ClientError('VALIDATION_ERROR','Path import requires a backend on this machine. Use explicit --upload to send bytes instead of a local path.');
}
