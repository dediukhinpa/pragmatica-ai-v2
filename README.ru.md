# pragmatica-ai-v2

Тонкий проект ассистента закупа на версионной платформе: пакеты `@business-ai/core`,
`@business-ai/adapters`, `@business-ai/testing`, `@business-ai/eval`. Платформа (ядро, сервисы,
шлюз, мониторинг) живёт в `business-ai`, здесь только то, что относится к проекту.
English: [README.md](README.md).

## Раскладка

| Путь | Что это |
|---|---|
| `src/project.ts` | манифест проекта (`defineProject`): агенты, модели, схема конфигурации, действия доступа |
| `src/agents/` | агенты и их замыкание, **генерируются** `tools/sync-agents.sh` |
| `prompts/` | резерв под промпты на шлюзе (этап 10) |
| `db/app/` | миграции проекта (поток `app`), `db/legacy-map.tsv` — соответствие старых версий |
| `config/` | словари и паттерны ПДн для `/config` сервисов, образец политики доступа |
| `deploy/` | `compose.yml` (проект `pragmatika`), `.env.example` |
| `eval/`, `e2e/` | кейсы и записи eval, сквозные сценарии |
| `tools/` | `sync-agents.sh` и помощники, инструменты эталона |

## Файлы `src/agents/**` руками не правим

Всё в `src/agents/**` и `tests/agents/**` перезаписывается скриптом
`tools/sync-agents.sh <коммит старого репозитория>`. До переключения (этап 8) агентов развивают
только в старом репозитории. Если v2 нужна другая форма файла, меняются правила переписывания
в `tools/sync-agents.sh` / `tools/sync_agents.py`, патчи в `tools/overrides/` или манифест, но
не сгенерированный файл. Скрипт записывает контрольную сумму каждого сгенерированного файла в
`tools/sync-manifest.tsv`; тест `tests/sync-guard.test.ts` падает, если файл правили руками.

## Проверки

```
export BAI_NPM_REGISTRY=http://127.0.0.1:24873/   # локальный реестр разработки
bun install
bun run typecheck
bun test
```

## Код проекта на месте хуков платформы

В платформе пока нет части хуков, которые были в прежнем ядре; проект возвращает это поведение
своими файлами (каждый пробел описан как запрос на патч платформы):

| Файл | Что возвращает |
|---|---|
| `src/chat-intake.ts`, `src/chat-launch.ts` | текст сообщения сотрудника для агента документов; ход агента после кнопок «Готово» и «заменить КП» (мост ставится в `ports(env)`) |
| `src/legacy-tools.ts`, `src/legacy-tool-texts.ts` | описания и схемы инструментов и общие блоки промпта в прежнем виде |
| `src/lifecycle-disk-sync.ts`, `src/background-*.ts` | закрытие неотчитанных прогонов синхронизации с диска; команды владельца `bun run src/background-cli.ts <mail-info-backfill\|mail-trust-survey\|crm-suppliers-sync>` |
| `src/mail-sender-lookup.ts` | допуск отправителей почты по базе поставщиков |
| `src/adapters/deal-*.ts` | заявка закупа по сделке CRM (`BITRIX24_DEAL_FIELD_MAP`) |
