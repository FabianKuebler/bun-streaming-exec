/**
 * TypeScript Parser
 *
 * Parses TypeScript/TSX code and extracts information:
 * - parseStatement: checks if code is syntactically complete
 * - extractBindingsFromAST: extracts top-level variable/function/class bindings
 */
import ts from "typescript";

export type ParseResult =
  | { complete: false }
  | { complete: true; sourceFile: ts.SourceFile };

export type Bindings = {
  variables: string[];
  functions: string[];
  classes: string[];
};

/**
 * Parse a statement and check if it's syntactically complete.
 * Returns the AST if complete, allowing reuse for binding extraction.
 */
export function parseStatement(source: string, jsx = false): ParseResult {
  const sourceFile = ts.createSourceFile(
    jsx ? "statement.tsx" : "statement.ts",
    source,
    ts.ScriptTarget.ESNext,
    true,
    jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  // INTERNAL API: parseDiagnostics is not exposed in public TypeScript types.
  // This has been stable since TS 2.x but could break in future major versions.
  // We pin typescript in devDependencies and have a regression test to catch breakage.
  // See: https://github.com/microsoft/TypeScript/blob/main/src/compiler/types.ts
  const diagnostics = (sourceFile as unknown as { parseDiagnostics: unknown[] })
    .parseDiagnostics;

  if (diagnostics.length > 0) {
    return { complete: false };
  }

  return { complete: true, sourceFile };
}

/**
 * Extract all top-level bindings from a parsed AST.
 */
export function extractBindingsFromAST(sourceFile: ts.SourceFile): Bindings {
  const variables: string[] = [];
  const functions: string[] = [];
  const classes: string[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        variables.push(...extractFromBindingName(decl.name));
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      functions.push(statement.name.text);
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      classes.push(statement.name.text);
    }
  }

  return { variables, functions, classes };
}

function extractFromBindingName(node: ts.BindingName): string[] {
  if (ts.isIdentifier(node)) {
    return [node.text];
  }

  if (ts.isObjectBindingPattern(node)) {
    return node.elements.flatMap((el) => extractFromBindingName(el.name));
  }

  if (ts.isArrayBindingPattern(node)) {
    return node.elements.flatMap((el) =>
      ts.isOmittedExpression(el) ? [] : extractFromBindingName(el.name),
    );
  }

  return [];
}
