// Заглушка «прежнего app» для проверки пакета переключения на синтетическом бое (Fornex).
// Отвечает на /ready так же, как ядро: код 200 и JSON с числом готовых ботов. Ничего не хранит.
// Боевой код не затрагивает: файл нужен только стенду проверки (tools/cutover-synth.sh).
const port = Number(process.env.STANDIN_PORT ?? "8088");
const bots = Number(process.env.STANDIN_BOTS ?? "4");

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req: Request): Response {
    const path = new URL(req.url).pathname;
    if (path === "/ready" || path === "/health") {
      return Response.json({ status: "ready", bots: { ready: bots, failed: 0 } });
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(JSON.stringify({ level: "info", event: "standin_started", port, bots }));
