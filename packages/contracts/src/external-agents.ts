import { z } from 'zod';

export const EXTERNAL_AGENTS_CHANNEL = 'mioon:external-agents:v1';

export const externalAgentSchema = z.enum(['claude-code', 'codex']);
export type ExternalAgent = z.infer<typeof externalAgentSchema>;

export const cliStateSchema = z.enum(['not-installed', 'installed', 'needs-repair', 'install-failed']);
export type CliState = z.infer<typeof cliStateSchema>;

export const cliReasonSchema = z.enum([
  'CLI_FILE_MISSING',
  'CLI_TARGET_MISSING',
  'CLI_VERSION_MISMATCH',
  'CLI_AUTO_UPDATE_FAILED',
  'CLI_INSTALL_TARGET_EXISTS',
  'CLI_INSTALL_NOT_WRITABLE',
  'CLI_INSTALL_FAILED',
]);
export type CliReason = z.infer<typeof cliReasonSchema>;

export const skillStateSchema = z.enum(['not-installed', 'installed', 'update-available', 'modified']);
export type SkillState = z.infer<typeof skillStateSchema>;

export const externalAgentsCommandNameSchema = z.enum(['mioon', 'mioon-dev']);
export const externalAgentsOnPathSchema = z.enum(['yes', 'no', 'unknown']);
export const externalAgentsInstallLocationSchema = z.enum(['default', 'choose']);

export const externalAgentsPathHintSchema = z.object({
  line: z.string().min(1),
  rcFile: z.string().min(1),
}).strict();

export const externalAgentsReasonValuesSchema = z.object({
  installedVersion: z.string().min(1).optional(),
  directory: z.string().min(1).optional(),
}).strict();

export const externalAgentsCliSchema = z.object({
  state: cliStateSchema,
  version: z.string().min(1).optional(),
  commandPath: z.string().min(1).optional(),
  displayPath: z.string(),
  onPath: externalAgentsOnPathSchema,
  pathHint: externalAgentsPathHintSchema.optional(),
  reason: cliReasonSchema.optional(),
  reasonValues: externalAgentsReasonValuesSchema.optional(),
}).strict();

export const externalAgentsMcpCommandsSchema = z.object({
  claudeCode: z.string(),
  codex: z.string(),
}).strict();

export const externalAgentsSkillSchema = z.object({
  agent: externalAgentSchema,
  state: skillStateSchema,
  displayDirectory: z.string(),
}).strict();

export const externalAgentsViewSchema = z.object({
  commandName: externalAgentsCommandNameSchema,
  appVersion: z.string().min(1),
  cli: externalAgentsCliSchema,
  mcpCommands: externalAgentsMcpCommandsSchema,
  skills: z.array(externalAgentsSkillSchema).readonly(),
}).strict();
export type ExternalAgentsView = z.infer<typeof externalAgentsViewSchema>;

export const externalAgentsRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('read') }).strict(),
  z.object({ kind: z.literal('install-cli'), location: externalAgentsInstallLocationSchema }).strict(),
  z.object({ kind: z.literal('uninstall-cli') }).strict(),
  z.object({ kind: z.literal('repair-cli') }).strict(),
  z.object({ kind: z.literal('install-skill'), agent: externalAgentSchema }).strict(),
  z.object({ kind: z.literal('uninstall-skill'), agent: externalAgentSchema }).strict(),
  z.object({ kind: z.literal('update-skill'), agent: externalAgentSchema, overwriteModified: z.boolean() }).strict(),
]);
export type ExternalAgentsRequest = z.infer<typeof externalAgentsRequestSchema>;

export const externalAgentsErrorCodeSchema = z.enum([
  'EXTERNAL_AGENTS_UNAVAILABLE',
  'EXTERNAL_AGENTS_INVALID',
  'EXTERNAL_AGENTS_BUSY',
  'CLI_REQUIRED',
  'SKILL_MODIFIED',
]);
export type ExternalAgentsErrorCode = z.infer<typeof externalAgentsErrorCodeSchema>;

export const externalAgentsErrorSchema = z.object({
  code: externalAgentsErrorCodeSchema,
  status: z.union([z.literal(400), z.literal(409), z.literal(503)]),
}).strict();
export type ExternalAgentsError = z.infer<typeof externalAgentsErrorSchema>;

export const externalAgentsReplySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: externalAgentsViewSchema }).strict(),
  z.object({ ok: z.literal(false), error: externalAgentsErrorSchema }).strict(),
]);
export type ExternalAgentsReply = z.infer<typeof externalAgentsReplySchema>;

export interface ExternalAgentsBridge {
  read(): Promise<ExternalAgentsView>;
  installCli(location: 'default' | 'choose'): Promise<ExternalAgentsView>;
  uninstallCli(): Promise<ExternalAgentsView>;
  repairCli(): Promise<ExternalAgentsView>;
  installSkill(agent: ExternalAgent): Promise<ExternalAgentsView>;
  uninstallSkill(agent: ExternalAgent): Promise<ExternalAgentsView>;
  updateSkill(agent: ExternalAgent, overwriteModified: boolean): Promise<ExternalAgentsView>;
}
