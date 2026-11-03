// Synthetic child process for the retained-task exclusive-owner regression.
// It never signals another process or changes lock/security settings.
import {openStore} from '../../packages/business/src/project-file/test-store.ts';
interface OwnerRequest {projectId: string; taskId: string; digest: string; [key: string]: unknown}
const [root,text]=process.argv.slice(2);
if(!root||!text)throw Error('Usage: edit-tasks-owner-process <root> <requestJson>');
JSON.parse(text) as OwnerRequest;
let code: string | undefined;
try { const unexpected = openStore(root); unexpected.close(); }
catch (error) { code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN'; }
process.stdout.write(JSON.stringify({ownerDenied: code === 'PROJECT_LOCKED', code}));
