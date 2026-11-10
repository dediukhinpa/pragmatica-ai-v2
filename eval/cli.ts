/** Точка запуска eval: `bun run eval -- --models a,b --mode replay`. */
import { runCli } from '@business-ai/eval';
import { registerPragmatikaEval } from './index';

registerPragmatikaEval();
process.exit(await runCli(process.argv.slice(2)));
