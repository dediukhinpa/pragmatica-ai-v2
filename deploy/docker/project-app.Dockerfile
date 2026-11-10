# syntax=docker/dockerfile:1
# ОБРАЗЕЦ: образ `app` проекта поверх базового образа ядра. Проект копирует этот файл к себе.
#
# Контекст сборки - каталог проекта (в нём package.json и src/), не репозиторий платформы.
# Ключи:
#   --build-arg BAI_APP_BASE=<репозиторий>@sha256:<digest>   базовый образ
#                                                           (по умолчанию bai-app-base)
#   --build-arg PROJECT_EXTRA_DEPS="имя@версия имя@версия"   зависимости проекта сверх платформы
# Платформенные пакеты уже лежат в базе: их заново не ставят, чтобы версия платформы в образе
# совпадала с версией базы (ее и записывает images.lock).
ARG BAI_APP_BASE=bai-app-base
FROM ${BAI_APP_BASE}
ARG PROJECT_EXTRA_DEPS=""
USER root
WORKDIR /app
# Свои зависимости проекта (если есть): ставятся рядом с пакетами платформы по lock-файлу базы.
RUN if [ -n "$PROJECT_EXTRA_DEPS" ]; then bun add --production --no-save $PROJECT_EXTRA_DEPS; fi
WORKDIR /app/project
COPY package.json /app/project/package.json
COPY src /app/project/src
USER bun
# Точка входа проекта вызывает runMain(project) из @business-ai/core/compose. Healthcheck задан
# в compose.base.yml (в образе нет curl/wget).
CMD ["bun", "run", "src/main.ts"]
