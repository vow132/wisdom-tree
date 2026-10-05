import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const environmentFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(environmentFile)) process.loadEnvFile(environmentFile);
