import { run } from './assignReviewers.js';

run(process.env).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
