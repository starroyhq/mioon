import type {LutImportInput,LutResource,LutImportResponse,LutListResponse,LutInspectResponse} from '../../packages/contracts/src/lut-resources.ts';
import {createLutResourceServices} from '../../packages/business/src/lut-resources.ts';
import {isLutRpcResponse} from '../../packages/client/src/lut-resources.ts';
type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
type Expect<T extends true>=T;
type NotAny<T>=0 extends 1&T?false:true;
type InputChecked=Expect<NotAny<LutImportInput>>;
type ResourceChecked=Expect<NotAny<LutResource>>;
type InputKeys=Expect<Equal<keyof LutImportInput,'projectId'|'requestId'|'name'|'dataBase64'>>;
type ColourUnverified=Expect<Equal<LutResource['colourCompatibility'],'unverified'>>;
type NotRendered=Expect<Equal<LutResource['renderBinding'],'not_implemented'>>;
type Service=ReturnType<typeof createLutResourceServices>;
type ImportTyped=Expect<Equal<ReturnType<Service['handlers']['lut.import']>,LutImportResponse>>;
type ListTyped=Expect<Equal<ReturnType<Service['handlers']['lut.list']>,LutListResponse>>;
type InspectTyped=Expect<Equal<ReturnType<Service['handlers']['lut.inspect']>,LutInspectResponse>>;
export function check(input:LutImportInput,resource:LutResource):boolean {
 // @ts-expect-error Resource intake does not accept filesystem paths.
 const bad:LutImportInput={...input,path:'/private/anything.cube'};
 // @ts-expect-error Public metadata never includes original content bytes.
 const content=resource.content;
 // @ts-expect-error Normalized input does not prove SDR eligibility.
 const compatible:'sdr'=resource.colourCompatibility;
 // @ts-expect-error No grading or clip binding is implemented here.
 const applied:'applied'=resource.renderBinding;
 void [bad,content,compatible,applied];return isLutRpcResponse('lut.import',input,{resource});
}
