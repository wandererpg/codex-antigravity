import { Tasks } from '../src/tasks.mjs';
const tasks = new Tasks();
try {
  console.log(JSON.stringify({ ...(await tasks.status()), model_count: (await tasks.models()).models.length }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: { code: error.code || 'BRIDGE_ERROR', message: error.message } }, null, 2));
  process.exitCode = 1;
}
