import { runChatAttachmentsCli } from './chat-attachments';

/**
 * Точка входа команд владельца для архива файлов чатов (этап 9s):
 * `bun run src/chat-attachments-cli.ts <find|path|stats|purge> [флаги]` внутри контейнера app.
 * Служба её не запускает; в сеть и базу команда не ходит.
 */
const code = await runChatAttachmentsCli(process.argv.slice(2), process.env, {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
process.exit(code);
