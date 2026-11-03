import {z} from 'zod';
import {mioIdentitySchemas} from './mio-records.ts';

const {id, hash, date, requestId} = mioIdentitySchemas;
export const MIO_RULE_WRITE_STATES = ['prepared','publication_unknown','published','trust_pending','completed','not_applied'] as const;
export const MIO_RULE_PUBLICATION_PHASES = ['before_candidate','candidate_created','before_capture','original_captured','before_publish','published','before_restore','restored','before_cleanup','completed'] as const;
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/u).max(100);
const timestamp = z.string().regex(/^-?(0|[1-9][0-9]*)$/u).max(100);
export const mioRulesFileIdentitySchema = z.object({dev:decimal,ino:decimal,size:decimal,mtimeNs:timestamp,ctimeNs:timestamp}).strict();
export const mioRulesPublicationEvidenceSchema = z.object({
 version:z.literal(1),fixedRelativeName:z.literal('AGENTS.md'),phase:z.enum(MIO_RULE_PUBLICATION_PHASES),
 directoryIdentity:mioRulesFileIdentitySchema,candidateName:z.string().regex(/^\.mioon-rules-[0-9a-f-]{36}\.candidate$/u),
 backupName:z.string().regex(/^\.mioon-rules-[0-9a-f-]{36}\.backup$/u),expectedExists:z.boolean(),beforeHash:hash.nullable(),afterHash:hash,
 candidateIdentity:mioRulesFileIdentitySchema.nullable(),capturedIdentity:mioRulesFileIdentitySchema.nullable(),capturedHash:hash.nullable(),publishedIdentity:mioRulesFileIdentitySchema.nullable(),
}).strict().refine(value=>{
 const token=value.candidateName.slice('.mioon-rules-'.length,-'.candidate'.length);
 return id.safeParse(token).success&&value.backupName===`.mioon-rules-${token}.backup`&&value.expectedExists===(value.beforeHash!==null);
});
export type MioRulesPublicationEvidence = z.infer<typeof mioRulesPublicationEvidenceSchema>;
export const mioRuleWriteSchema = z.object({
 requestId,projectId:id,actor:z.enum(['manual','mio']),runId:id.nullable(),stepId:id.nullable(),digest:hash,approvalReceiptId:requestId.nullable(),
 expectedExists:z.boolean(),beforeHash:hash.nullable(),afterHash:hash,beforeBlobHash:hash.nullable(),afterBlobHash:hash,
 fixedRelativeName:z.literal('AGENTS.md'),fileIdentity:mioRulesPublicationEvidenceSchema.nullable(),state:z.enum(MIO_RULE_WRITE_STATES),createdAt:date,updatedAt:date,
}).strict().refine(value=>{
 if(value.actor==='manual'?(value.runId!==null||value.stepId!==null||value.approvalReceiptId!==null):(value.runId===null||value.stepId===null||value.approvalReceiptId===null))return false;
 if(value.expectedExists!==(value.beforeHash!==null)||value.beforeBlobHash!==value.beforeHash||value.afterBlobHash!==value.afterHash)return false;
 const evidence=value.fileIdentity;
 if(['published','trust_pending','completed'].includes(value.state)&&(evidence===null||evidence.candidateIdentity===null||evidence.publishedIdentity===null||!['published','before_cleanup','completed'].includes(evidence.phase)))return false;
 return evidence===null||(evidence.expectedExists===value.expectedExists&&evidence.beforeHash===value.beforeHash&&evidence.afterHash===value.afterHash);
});
export type MioRuleWrite = z.infer<typeof mioRuleWriteSchema>;
