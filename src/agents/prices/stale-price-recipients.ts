import {
  createStaffNameMatcher,
  createStaffPathSurnameFinder,
  type StaffPerson,
} from '@business-ai/core';
import type { FileAuthors } from '@business-ai/core';
import { mapPool } from '@business-ai/core';
import { extensionOf } from '@business-ai/core';
import {
  employeeAccessVerdict,
  latestEmployeeThreads,
  openedEmployeeThread,
} from './employee-threads';
import type { PricesDeps } from './deps';

/** Расширения Office-файлов, у которых есть свойства документа (создатель, редактор). */
export const AUTHORSHIP_EXTENSIONS: readonly string[] = [
  '.docx',
  '.xlsx',
  '.xlsm',
  '.pptx',
  '.xls',
  '.doc',
];
/** Сколько файлов за проверку читается ради авторства; остальные идут в общий поток. */
export const PRICE_FILE_AUTHORSHIP_MAX_FILES = 100;
/** Сколько файлов читается одновременно. */
const AUTHORSHIP_CONCURRENCY = 3;

/** Счётчики определения адресатов (для журнала): без имён, путей и идентификаторов. */
interface RecipientStats {
  /** Файлов, по которым запрошено авторство. */
  asked: number;
  /** Файлов, по которым найден хотя бы один сотрудник. */
  resolved: number;
  /** Имён, не сопоставленных ни с кем. */
  unmatched: number;
  /** Имён, подходящих нескольким сотрудникам (не угадываются). */
  ambiguous: number;
  /** Файлов, у которых авторство получить не удалось (ошибка чтения или сервиса). */
  failed: number;
  /** Найденных сотрудников без личного треда или без права писать агенту. */
  noThread: number;
  /** Из них - сотрудников, которым бот не пишет по политике доступа (не ошибка). */
  denied: number;
  /** Сотрудников, которым тред построен по id: бот пишет первым (`recipientOpenThread`). */
  opened: number;
  /** Файлов, адресаты которых определены по фамилии в пути (свойства Office не читались). */
  pathResolved: number;
  /** Файлов, адресат которых определён по «кем изменён». */
  officeModified: number;
  /** Файлов, адресат которых определён по «кем создан» (когда «кем изменён» не сопоставлен). */
  officeCreated: number;
  /** Файлов, ни по пути, ни по свойствам никого не нашедших (уходят ответственному). */
  fallback: number;
  /** Файлов, адресат которых найден на шаге Office и не состоит в отделе закупок. */
  otherDepartment: number;
  /** Сопоставлений, отброшенных списком исключённых получателей (шаг продолжается). */
  excluded: number;
}

/** Адресаты недельной сводки: путь файла -> тред сотрудника (один файл - несколько тредов). */
export interface FileRecipients {
  threadsByPath: Map<string, string[]>;
  /**
   * Треды, построенные по id (сотрудник не писал боту, `recipientOpenThread`): отправка в них
   * может не пройти, и тогда файлы переадресуются ответственному, а не роняют сводку.
   */
  openedThreads: Set<string>;
  stats: RecipientStats;
}

const NO_STATS: RecipientStats = {
  asked: 0,
  resolved: 0,
  unmatched: 0,
  ambiguous: 0,
  failed: 0,
  noThread: 0,
  denied: 0,
  opened: 0,
  pathResolved: 0,
  officeModified: 0,
  officeCreated: 0,
  fallback: 0,
  otherDepartment: 0,
  excluded: 0,
};

/** Адресная раздача включена: есть сервис авторства, каталог сотрудников и состав. */
function authorshipRouting(deps: PricesDeps): {
  authorship: NonNullable<PricesDeps['authorship']>;
  staff: NonNullable<PricesDeps['staff']>;
  departments: readonly string[];
  extraUserIds: ReadonlySet<string>;
} | null {
  const { authorship, staff } = deps;
  const departments = deps.staffDepartmentIds ?? [];
  const extraUserIds = deps.staffExtraUserIds ?? new Set<string>();
  if (authorship === undefined || staff === undefined) return null;
  if (departments.length === 0 && extraUserIds.size === 0) return null;
  return { authorship, staff, departments, extraUserIds };
}

/**
 * Сотрудники для сопоставления по фамилии в пути: подотделы заданных отделов плюс отдельные
 * id из каталога всех активных (неактивный id молча отпадает). Один человек - один раз.
 */
async function loadPriceStaff(
  routing: NonNullable<ReturnType<typeof authorshipRouting>>,
  loadEveryone: () => Promise<readonly StaffPerson[]>,
): Promise<readonly StaffPerson[]> {
  const byId = new Map<string, StaffPerson>();
  for (const department of routing.departments) {
    for (const person of await routing.staff.activeMembersOf(department)) {
      byId.set(person.userId, person);
    }
  }
  if (routing.extraUserIds.size > 0) {
    // Отдельные id - добавка к составу отделов: сбой её запроса не должен отключать шаг по
    // отделам (ревью 217). Без добавки сотрудники из списка уйдут ответственному.
    try {
      for (const person of await loadEveryone()) {
        if (routing.extraUserIds.has(person.userId)) byId.set(person.userId, person);
      }
    } catch {
      // Ошибка остаётся в общем обещании каталога: шаг Office получит её отдельно.
    }
  }
  return [...byId.values()];
}

/**
 * Для каждого файла определить личные треды сотрудников отдела закупок. Каскад (код, модель не
 * участвует; имена остаются внутри службы и не попадают в журнал):
 * 1) фамилия сотрудника отдела закупок в самой глубокой папке пути, где она есть (две фамилии - оба); свойства
 *    файла при этом не читаются и лимит чтений не тратят;
 * 2) свойства Office: «кем изменён», а если он не сопоставлен - «кем создан»; подходит активный
 *    сотрудник любого отдела (неактивный не сопоставляется);
 *    Сотрудники из `recipientExcludeUserIds` не бывают получателями ни на одном шаге: найденный
 *    исключённый считается неопознанным, шаг продолжается;
 * 3) иначе файл вне карты и уходит ответственному.
 * Любая неудача (сбой сервиса, имя не найдено или неоднозначно, у сотрудника нет личного треда
 * или права) оставляет файл вне карты.
 */
export async function resolveFileRecipients(
  deps: PricesDeps,
  paths: readonly string[],
  known: ReadonlyMap<string, FileAuthors> = new Map(),
  readBudget: number = PRICE_FILE_AUTHORSHIP_MAX_FILES,
): Promise<FileRecipients> {
  const stats: RecipientStats = { ...NO_STATS };
  const threadsByPath = new Map<string, string[]>();
  const openedThreads = new Set<string>();
  const routing = authorshipRouting(deps);
  if (routing === null || paths.length === 0) return { threadsByPath, openedThreads, stats };
  const officePaths = paths.filter((path) => AUTHORSHIP_EXTENSIONS.includes(extensionOf(path)));

  // Каталог всех активных сотрудников запрашивается лениво и не более одного раза за проверку:
  // он нужен и для отдельных id сотрудников, и для шага Office.
  let everyoneMembers: Promise<readonly StaffPerson[]> | null = null;
  const loadEveryoneMembers = (): Promise<readonly StaffPerson[]> => {
    everyoneMembers ??= routing.staff.allActiveMembers();
    return everyoneMembers;
  };
  let staff: readonly StaffPerson[];
  try {
    staff = await loadPriceStaff(routing, loadEveryoneMembers);
  } catch {
    // Каталог недоступен: всё уходит в общий поток, повтор - в следующий понедельник/тик.
    stats.failed = officePaths.length;
    stats.fallback = paths.length;
    deps.log?.('price_file_authorship', { ...stats });
    return { threadsByPath, openedThreads, stats };
  }

  const excludedIds = deps.recipientExcludeUserIds;
  const isExcluded = (userId: string): boolean => excludedIds?.has(userId) === true;

  // Шаг 1: фамилия в пути. Решённые файлы исключаются до расчёта лимита чтений. Исключённые
  // убираются из набора до фиксации результата: остальные фамилии папки остаются, а если не
  // осталось никого - файл идёт дальше по каскаду.
  const usersByPath = new Map<string, Set<string>>();
  const findBySurname = createStaffPathSurnameFinder(staff);
  for (const path of paths) {
    const found = findBySurname(path);
    stats.ambiguous += found.ambiguous;
    const allowed = found.userIds.filter((userId) => !isExcluded(userId));
    stats.excluded += found.userIds.length - allowed.length;
    if (allowed.length === 0) continue;
    usersByPath.set(path, new Set(allowed));
    stats.pathResolved += 1;
  }

  // Шаг 2: свойства Office. Уже прочитанные при выводе года (`known`) повторно не запрашиваются
  // и лимит чтений не тратят; остальным достаётся то, что осталось от `readBudget`.
  const supported = officePaths.filter((path) => !usersByPath.has(path));
  const cached = supported.filter((path) => known.has(path));
  const fresh = supported.filter((path) => !known.has(path)).slice(0, Math.max(0, readBudget));
  const asked = [...cached, ...fresh];
  stats.asked = asked.length;

  if (asked.length > 0) {
    // Два прохода: сначала заданный состав (отделы и отдельные сотрудники: однофамилец из другого
    // отдела не портит однозначное совпадение), и только при none/ambiguous - все активные.
    const departmentMatcher = createStaffNameMatcher(staff);
    const departmentIds = new Set(staff.map((person) => person.userId));
    let everyoneMatcher: Promise<ReturnType<typeof createStaffNameMatcher>> | null = null;
    const loadEveryone = (): Promise<ReturnType<typeof createStaffNameMatcher>> => {
      everyoneMatcher ??= loadEveryoneMembers().then((members) => createStaffNameMatcher(members));
      return everyoneMatcher;
    };
    await mapPool(asked, AUTHORSHIP_CONCURRENCY, async (path) => {
      try {
        const authors =
          known.get(path) ??
          (await routing.authorship.authorsOf(path, await deps.files.read(path)));
        // Каскад: «кем изменён», иначе «кем создан»; оба сразу не берутся.
        for (const [name, counter] of [
          [authors.lastModifiedBy, 'officeModified'],
          [authors.creator, 'officeCreated'],
        ] as const) {
          if (name === null || name.trim() === '') continue;
          let match = departmentMatcher(name);
          if (match.kind !== 'matched') match = (await loadEveryone())(name);
          if (match.kind === 'matched') {
            if (isExcluded(match.userId)) {
              stats.excluded += 1;
              continue;
            }
            usersByPath.set(path, new Set([match.userId]));
            stats[counter] += 1;
            if (!departmentIds.has(match.userId)) stats.otherDepartment += 1;
            return;
          }
          if (match.kind === 'ambiguous') stats.ambiguous += 1;
          else stats.unmatched += 1;
        }
      } catch {
        stats.failed += 1;
      }
    });
  }
  stats.fallback = paths.length - usersByPath.size;
  if (usersByPath.size === 0) {
    deps.log?.('price_file_authorship', { ...stats });
    return { threadsByPath, openedThreads, stats };
  }

  const personal = await latestEmployeeThreads(deps);
  const threadOf = new Map<string, string | null>();
  const resolveThread = async (userId: string): Promise<string | null> => {
    const cached = threadOf.get(userId);
    if (cached !== undefined) return cached;
    const known = personal.get(userId);
    // Нет обращения к боту: при включённом флаге бот пишет первым (этап 217), иначе - как раньше.
    const opened = known === undefined ? openedEmployeeThread(deps, userId) : null;
    const thread = known ?? opened;
    const verdict = thread === null ? 'denied' : await employeeAccessVerdict(deps, userId);
    const allowed = thread !== null && verdict === 'allowed';
    const result = allowed ? thread : null;
    threadOf.set(userId, result);
    if (result === null) {
      stats.noThread += 1;
      // Запрет политикой - штатный случай, не сбой: только счётчик в info-событии.
      if (thread !== null && verdict === 'denied') stats.denied += 1;
    } else if (opened !== null) {
      stats.opened += 1;
      openedThreads.add(opened);
    }
    return result;
  };
  for (const path of usersByPath.keys()) {
    const threads = new Set<string>();
    for (const userId of [...(usersByPath.get(path) ?? [])].sort()) {
      const thread = await resolveThread(userId);
      if (thread !== null) threads.add(thread);
    }
    if (threads.size > 0) {
      threadsByPath.set(path, [...threads].sort());
      stats.resolved += 1;
    }
  }
  deps.log?.('price_file_authorship', { ...stats });
  return { threadsByPath, openedThreads, stats };
}
