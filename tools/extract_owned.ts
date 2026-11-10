/**
 * Вырезать из файла Прагматики объявления проектных символов (и то, от чего они зависят).
 * Вход (stdin, JSON): { text, names, platformExports, selfSpec }
 *   names           - проектные символы, которые нужно вырезать;
 *   platformExports - что уже экспортирует платформенный двойник файла (его не дублируем);
 *   selfSpec        - относительный спецификатор самого файла (`./errors`), откуда брать общее.
 * Выход (stdout): текст оверлея.
 */
import ts from 'typescript';

interface Input {
  text: string;
  names: string[];
  platformExports: string[];
  selfSpec: string;
}

const input = JSON.parse(await Bun.stdin.text()) as Input;
const sf = ts.createSourceFile('x.ts', input.text, ts.ScriptTarget.ES2022, true);
const platform = new Set(input.platformExports);

interface Stmt {
  node: ts.Statement;
  declared: string[];
  used: Set<string>;
}

function declaredNames(s: ts.Statement): string[] {
  if (ts.isVariableStatement(s)) {
    return s.declarationList.declarations.flatMap((d) =>
      ts.isIdentifier(d.name) ? [d.name.text] : []);
  }
  if (
    ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s) ||
    ts.isTypeAliasDeclaration(s) || ts.isEnumDeclaration(s)
  ) {
    return s.name ? [s.name.text] : [];
  }
  return [];
}

function usedIdentifiers(n: ts.Node, out: Set<string>): void {
  if (ts.isIdentifier(n)) out.add(n.text);
  n.forEachChild((c) => usedIdentifiers(c, out));
}

const stmts: Stmt[] = [];
const imports: ts.ImportDeclaration[] = [];
for (const s of sf.statements) {
  if (ts.isImportDeclaration(s)) {
    imports.push(s);
    continue;
  }
  const used = new Set<string>();
  usedIdentifiers(s, used);
  stmts.push({ node: s, declared: declaredNames(s), used });
}

const byName = new Map<string, Stmt>();
for (const st of stmts) for (const n of st.declared) byName.set(n, st);

const include = new Set<Stmt>();
const fromSelf = new Set<string>();
const queue: string[] = input.names.filter((n) => byName.has(n));
while (queue.length > 0) {
  const name = queue.pop() as string;
  const st = byName.get(name);
  if (!st || include.has(st)) continue;
  include.add(st);
  for (const id of st.used) {
    if (!byName.has(id)) continue;
    if (platform.has(id) && !input.names.includes(id)) {
      fromSelf.add(id);
      continue;
    }
    queue.push(id);
  }
}

const usedAll = new Set<string>();
for (const st of include) for (const id of st.used) usedAll.add(id);

const lines: string[] = [];
for (const imp of imports) {
  const clause = imp.importClause;
  const spec = (imp.moduleSpecifier as ts.StringLiteral).text;
  if (!clause) continue;
  const typeOnly = clause.isTypeOnly ? 'type ' : '';
  const parts: string[] = [];
  let def = '';
  if (clause.name && usedAll.has(clause.name.text)) def = clause.name.text;
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) {
    if (usedAll.has(bindings.name.text)) {
      lines.push(`import ${typeOnly}* as ${bindings.name.text} from '${spec}';`);
    }
  } else if (bindings && ts.isNamedImports(bindings)) {
    for (const el of bindings.elements) {
      if (!usedAll.has(el.name.text)) continue;
      const t = el.isTypeOnly ? 'type ' : '';
      const orig = el.propertyName ? `${el.propertyName.text} as ${el.name.text}` : el.name.text;
      parts.push(t + orig);
    }
  }
  if (def || parts.length > 0) {
    const head = def ? def + (parts.length > 0 ? ', ' : '') : '';
    const body = parts.length > 0 ? `{ ${parts.join(', ')} }` : '';
    lines.push(`import ${typeOnly}${head}${body} from '${spec}';`);
  }
}
if (fromSelf.size > 0) {
  lines.push(`import { ${[...fromSelf].sort().join(', ')} } from '${input.selfSpec}';`);
}
lines.push('');
for (const st of stmts) {
  if (include.has(st)) lines.push(st.node.getFullText().replace(/^\n+/, ''));
}
process.stdout.write(lines.join('\n') + '\n');
