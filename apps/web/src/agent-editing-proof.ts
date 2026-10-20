/** Read-only proof from the host target ledger plus an active claim owned by
 * this window. Aggregate timeline revisions alone cannot certify this proof. */
export interface AgentEditingProof {ownerId:string;kind:string;id:string;revision:number;timelineRevision:number}
