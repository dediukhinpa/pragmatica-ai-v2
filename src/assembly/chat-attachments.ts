import type { AuditRepository, ChatEvent, Clock, ProjectContext } from '@business-ai/core';
import {
  ChatAttachmentArchive,
  chatAttachmentsConfigOf,
  type ChatAttachmentEventSink,
} from '../chat-attachments';
import type { PragmatikaConfig } from '../config';
import { ORDER_CALC_AGENT_ID } from '../agents/order-calc';

/** Контекст сборки Прагматики. */
type Context = ProjectContext<PragmatikaConfig>;

/** Исполнитель записи аудита об очистке и вытеснении архива. */
export const CHAT_ATTACHMENTS_AUDIT_ACTOR = 'chat-attachments';
/** Действие аудита: вытеснение файлов по пределу объёма. */
export const CHAT_ATTACHMENTS_EVICT_ACTION = 'chat_attachments_evicted';
/** Действие аудита: ежедневная очистка по сроку. */
export const CHAT_ATTACHMENTS_PURGE_ACTION = 'chat_attachments_purge';

/**
 * Записать событие в аудит; сбой аудита ход и очистку не ломает (ключ - момент и действие, повтор
 * в ту же миллисекунду не плодит дубль).
 */
export async function auditChatAttachments(
  audit: AuditRepository,
  clock: Clock,
  action: string,
  fields: Record<string, string | number>,
): Promise<void> {
  const at = clock.now().toISOString();
  const details = Object.entries(fields)
    .map(([name, value]) => `${name}=${value}`)
    .join(' ');
  try {
    await audit.append(
      { at, actor: CHAT_ATTACHMENTS_AUDIT_ACTOR, action, details, result: 'ok' },
      `${action}:${at}`,
    );
  } catch {
    // Аудит вторичен: файлы и ход важнее записи о чистке.
  }
}

/** Агент, которому адресован бот (режим одного бота - агент по умолчанию). */
export function agentOfBot(
  chatBots: Readonly<Record<string, string>> | undefined,
  botId: string | undefined,
): string {
  if (botId === undefined) return ORDER_CALC_AGENT_ID;
  return chatBots?.[botId] ?? '';
}

/**
 * Архив файлов чатов (этап 9s): каждый файл, присланный сотрудником любому боту, сохраняется
 * в томе приёма на `CHAT_ATTACHMENTS_RETENTION_DAYS` суток. Перехват стоит на канале чата ДО
 * насоса: он видит и файлы, склеенные окном подписи (обработчики файлов манифеста получают
 * только первый), и файлы ботов без папки приёма, которые иначе живут лишь в памяти. Сохранение
 * не меняет того, что уходит агенту и модели, и не бросает исключений в ход.
 */
export function wireChatAttachments(ctx: Context): ChatAttachmentArchive {
  const { config, project, services } = ctx;
  const sink: ChatAttachmentEventSink = (event, fields) => {
    services.log(event, fields);
    if (event === CHAT_ATTACHMENTS_EVICT_ACTION) {
      void auditChatAttachments(services.audit, services.clock, event, fields);
    }
  };
  const enabled = project.CHAT_ATTACHMENTS_STORE_ENABLED === 'true';
  const archive = new ChatAttachmentArchive({
    intakeRoot: config.intake.root,
    config: chatAttachmentsConfigOf({
      enabled,
      retentionDays: project.CHAT_ATTACHMENTS_RETENTION_DAYS,
      maxBytes: project.CHAT_ATTACHMENTS_MAX_BYTES,
      attachmentMaxBytes: config.bitrix24?.attachments?.maxBytes,
      attachmentMaxFiles: config.bitrix24?.attachments?.maxFiles,
    }),
    clock: () => services.clock.now(),
    onEvent: sink,
  });
  // Выключено: файлы не сохраняются, но архив остаётся для чистки уже сохранённого.
  if (enabled) {
    services.chat.onEvent(async (event: ChatEvent) => {
      if (event.kind !== 'file') return;
      // `save` не бросает; внешний catch страхует от сбоя самого вызова: исключение здесь
      // вернуло бы событие в обработку и могло потерять ход сотрудника.
      try {
        await archive.save({
          threadId: event.threadId,
          userId: event.userId,
          ...(event.botId === undefined ? {} : { botId: event.botId }),
          agentId: agentOfBot(config.service.chatBots, event.botId),
          ...(event.sourceKey === undefined ? {} : { sourceKey: event.sourceKey }),
          file: {
            name: event.file.name,
            content: event.file.content,
            ...(event.file.disk === undefined
              ? {}
              : { disk: { path: event.file.disk.path, size: event.file.disk.size } }),
          },
        });
      } catch {
        services.log('chat_attachment_failed', { code: 'hook' });
      }
    });
  }
  return archive;
}
