import { readFileSync } from 'node:fs';
export const routingConfig = JSON.parse(readFileSync(new URL('../config/routing.json', import.meta.url), 'utf8'));
