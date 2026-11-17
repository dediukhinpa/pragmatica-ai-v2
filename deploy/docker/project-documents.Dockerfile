# syntax=docker/dockerfile:1
# Образ `documents` проекта: платформенный bai-documents по digest из lock плюс проектные маршруты
# `/docx/*` (дополнение договора, блок стороны, подписант, вид договора).
#
# Платформенные файлы не копируются и не правятся: слой добавляет только пакет
# `pragmatika_documents`, ставит LibreOffice Writer и меняет точку входа. В базе есть Tesseract и
# python-docx (нужен платформенному /render), но НЕТ LibreOffice: платформа собирает образ с
# WITH_LIBREOFFICE=0. Договоры приходят в .doc и RTF, их `/docx/*` приводят к docx через soffice
# (без него отказ `conversion_unavailable`), поэтому слой ставит его сам. Контекст сборки -
# закоммиченное дерево проекта (tools/build-app-image.sh --kind documents).
#   --build-arg BAI_DOCUMENTS_BASE=<репозиторий>@sha256:<digest>   платформенный bai-documents
ARG BAI_DOCUMENTS_BASE=bai-documents
FROM ${BAI_DOCUMENTS_BASE}
# База держит PYTHONPATH=/app и непривилегированного пользователя 10001: пакет кладётся рядом с
# платформенным `documents` под root (права файлов берутся из git: 644/755, писать пользователю
# сервиса нельзя), запуск остаётся от 10001. Флаг --chmod не используется: классический сборщик
# без BuildKit его не знает.
USER root
# Тот же минимальный набор и та же закреплённая версия, что в платформенном documents.Dockerfile
# при WITH_LIBREOFFICE=1: только Writer без интерфейса, без рекомендованных пакетов (Java, Base,
# Calc, Impress, справка); шрифты с кириллицей (Liberation - метрики Times New Roman и Arial) нужны,
# чтобы вёрстка после конвертации не разваливалась. Если зеркало Debian убрало эту версию, сборка
# падает на этом шаге: проверьте `apt-cache policy libreoffice-writer-nogui` и обновите версию
# осознанно (повторив проверку конвертации). Нужен доступ к deb.debian.org при сборке.
ARG LIBREOFFICE_VERSION=4:7.4.7-1+deb12u14
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        "libreoffice-writer-nogui=${LIBREOFFICE_VERSION}" \
        fonts-dejavu-core fonts-liberation2 \
    && rm -rf /var/lib/apt/lists/*
COPY --chown=root:root services/documents-docx/pragmatika_documents /app/pragmatika_documents
USER 10001:10001
# Тот же порт и healthcheck, что у базы (/health платформы); входит в проектный слой только
# точка запуска.
CMD ["python", "-m", "pragmatika_documents"]
