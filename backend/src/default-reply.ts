import { readFile } from 'node:fs/promises';

// Public seed data shared by migration generation and the new-model form.
export const DEFAULT_MODEL_REPLY = await readFile(new URL('../data/default-model-reply.txt', import.meta.url), 'utf8');
