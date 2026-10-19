import {openStore} from '../../packages/business/src/db.ts';
import {createServices} from '../../packages/business/src/services.ts';
const store=openStore(process.argv[2],{lock:false}),services=createServices(store,new Map());
process.send({ready:true});
process.once('message',async input=>{
 try{process.send({ok:true,value:await services.call('asset.annotation.set',input)});}
 catch(error){process.send({ok:false,code:error.code});}
 finally{await services.drain();store.close();process.disconnect();}
});
