import {shutdownFixture as original,deferred as originalDeferred} from './worker-shutdown-fixture.ts';
import type {Provider,ProviderContext} from '../../packages/business/src/provider-registry.ts';
import type {MediaJob,TypedStore,TypedServices} from './strict-service-responses.ts';
type Base=Awaited<ReturnType<typeof original>>;
type Context=ProviderContext & {signal:AbortSignal};
type Methods={submit(snapshot:unknown,context:Context):unknown;reconcile(requestId:string,context:Context):unknown;poll(id:string,context:Context):unknown;download(id:string,destination:string,context:Context):unknown};
export type ShutdownFixture=Omit<Base,'store'|'services'|'provider'|'providers'|'read'> & {store:TypedStore;services:TypedServices;provider:Provider;providers:Map<string,Provider>;read():MediaJob & {error:{code:string;message:string;retryable:boolean}}};
export const shutdownFixture=original as unknown as (t:Parameters<typeof original>[0],methods?:Partial<Methods>,options?:Parameters<typeof original>[2])=>Promise<ShutdownFixture>;
export const deferred=originalDeferred as <T=unknown>()=>{promise:Promise<T>;resolve(value?:T):void;reject(error:unknown):void};
