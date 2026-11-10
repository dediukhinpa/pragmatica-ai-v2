/** Точка запуска набора по передачам: `bun run eval:handoff -- --mode replay`. */
import { runHandoffCli } from '@business-ai/eval';
import { registerPragmatikaEval } from './index';

registerPragmatikaEval();
process.exit(await runHandoffCli(process.argv.slice(2)));
