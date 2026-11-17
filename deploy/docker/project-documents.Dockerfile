# syntax=docker/dockerfile:1
# Образ `documents` проекта: платформенный bai-documents по digest из lock плюс проектные маршруты
# `/docx/*` (дополнение договора, блок стороны, подписант, вид договора).
#
# Платформенные файлы не копируются и не правятся: слой добавляет только пакет
# `pragmatika_documents` и меняет точку входа. База уже содержит LibreOffice, Tesseract и
# зависимости python-docx (python-docx нужен платформенному /render). Контекст сборки -
# закоммиченное дерево проекта (tools/build-app-image.sh --kind documents).
#   --build-arg BAI_DOCUMENTS_BASE=<репозиторий>@sha256:<digest>   платформенный bai-documents
ARG BAI_DOCUMENTS_BASE=bai-documents
FROM ${BAI_DOCUMENTS_BASE}
# База держит PYTHONPATH=/app и непривилегированного пользователя 10001: пакет кладётся рядом с
# платформенным `documents` под root (права файлов берутся из git: 644/755, писать пользователю
# сервиса нельзя), запуск остаётся от 10001. Флаг --chmod не используется: классический сборщик
# без BuildKit его не знает.
USER root
COPY --chown=root:root services/documents-docx/pragmatika_documents /app/pragmatika_documents
USER 10001:10001
# Тот же порт и healthcheck, что у базы (/health платформы); входит в проектный слой только
# точка запуска.
CMD ["python", "-m", "pragmatika_documents"]
