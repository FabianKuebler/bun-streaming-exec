/**
 * Streaming VM Executor
 *
 * Execute TypeScript/JavaScript statements as they stream from an LLM,
 * without waiting for the complete code block.
 *
 * Key behaviors:
 * 1. Buffer characters until semicolon detected
 * 2. Parse with TypeScript - if no errors, statement is complete
 * 3. Extract bindings from AST, transpile TS/JSX to JS
 * 4. Wrap in async IIFE and execute in vm context
 * 5. Hoist declared variables/functions/classes to vm context for persistence
 */
import { Console as NodeConsole } from "node:console";
import { Writable } from "node:stream";
import * as vm from "node:vm";
import { parseStatement, extractBindingsFromAST, type Bindings } from "./ts-parser";
import type {
  StreamingExecutorOptions,
  StreamingRun,
  ExecutionEvent,
  ExecutionError,
  ExecutionErrorType,
  ExecutionResult,
  JsxOptions,
} from "./types";

const DEFAULT_TIMEOUT = 30000;

type QueuedEvent = { event: ExecutionEvent } | { done: true };

export class StreamingExecutor {
  private readonly _context: vm.Context;
  private readonly transpiler: Bun.Transpiler;
  private readonly timeout: number;
  private readonly jsx: boolean;
  private readonly continueOnError: boolean;
  private _running = false;

  constructor(options?: StreamingExecutorOptions) {
    this._context = vm.createContext({});
    this.timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    this.continueOnError = options?.continueOnError ?? false;
    this.jsx = !!options?.jsx;

    if (this.jsx) {
      const jsxConfig: JsxOptions =
        typeof options?.jsx === "object" ? options.jsx : {};
      this.transpiler = new Bun.Transpiler({
        loader: "tsx",
        target: "bun",
        tsconfig: {
          compilerOptions: {
            jsx: jsxConfig.jsx ?? "react",
            jsxFactory: jsxConfig.jsxFactory ?? "React.createElement",
            jsxFragmentFactory: jsxConfig.jsxFragmentFactory ?? "React.Fragment",
            ...(jsxConfig.jsxImportSource && {
              jsxImportSource: jsxConfig.jsxImportSource,
            }),
          },
        },
      });
    } else {
      this.transpiler = new Bun.Transpiler({
        loader: "ts",
        target: "bun",
      });
    }

    // Initialize built-in globals
    this.initializeBuiltins();

    // Apply user-provided context
    if (options?.context) {
      for (const [key, value] of Object.entries(options.context)) {
        (this._context as Record<string, unknown>)[key] = value;
      }
    }
  }

  /**
   * The VM context. Access declared variables or inject new ones.
   */
  get context(): vm.Context {
    return this._context;
  }

  /**
   * True while a run() is in progress.
   */
  get running(): boolean {
    return this._running;
  }

  /**
   * Execute code from an async token stream.
   * Can be called multiple times - context persists between runs.
   * Cannot be called while another run is in progress.
   */
  run(stream: AsyncIterable<string>): StreamingRun {
    if (this._running) {
      throw new Error("Cannot call run() while another run is in progress");
    }

    this._running = true;

    // Event queue for decoupling execution from consumption
    const eventQueue: QueuedEvent[] = [];
    let queueResolver: (() => void) | null = null;

    const pushEvent = (item: QueuedEvent) => {
      eventQueue.push(item);
      if (queueResolver) {
        queueResolver();
        queueResolver = null;
      }
    };

    const waitForEvent = (): Promise<void> => {
      if (eventQueue.length > 0) return Promise.resolve();
      return new Promise((resolve) => {
        queueResolver = resolve;
      });
    };

    let allLogs = "";
    let finalError: ExecutionError | undefined;

    let resolveResult!: (result: ExecutionResult) => void;
    const resultPromise = new Promise<ExecutionResult>((resolve) => {
      resolveResult = resolve;
    });

    const self = this;

    // Background execution task - runs independently of event consumption
    (async () => {
      let buffer = "";
      let lineNumber = 1;
      let statementStartLine = 1;

      try {
        for await (const chunk of stream) {
          for (const char of chunk) {
            buffer += char;

            // Try to execute on semicolon
            if (char === ";") {
              const trimmed = buffer.trim();
              if (trimmed) {
                const parseResult = parseStatement(trimmed, self.jsx);
                if (parseResult.complete) {
                  const bindings = extractBindingsFromAST(parseResult.sourceFile);
                  const transpileResult = self.transpile(trimmed);

                  if ("error" in transpileResult) {
                    const error: ExecutionError = {
                      type: "parse",
                      thrown: new Error(transpileResult.error),
                      message: transpileResult.error,
                      line: statementStartLine,
                    };
                    if (!finalError) finalError = error;
                    pushEvent({
                      event: {
                        statement: trimmed,
                        line: statementStartLine,
                        logs: "",
                        error,
                      },
                    });
                    if (!self.continueOnError) {
                      return;
                    }
                    buffer = "";
                    statementStartLine = lineNumber;
                    continue;
                  }

                  const execResult = await self.executeStatement(
                    transpileResult.code,
                    bindings,
                    statementStartLine
                  );

                  const logs = execResult.logs;
                  allLogs += logs;

                  const event: ExecutionEvent = {
                    statement: trimmed,
                    line: statementStartLine,
                    logs,
                    error: execResult.error,
                  };

                  pushEvent({ event });

                  if (execResult.error) {
                    if (!finalError) finalError = execResult.error;
                    if (!self.continueOnError) {
                      return;
                    }
                  }

                  buffer = "";
                  // Next statement starts on current line (after semicolon)
                  statementStartLine = lineNumber;
                }
                // If not complete, keep buffering (semicolon was inside string/regex/etc)
              }
            }

            // Track newlines after processing (so line number for statement start is correct)
            if (char === "\n") {
              lineNumber++;
              // If buffer is empty/whitespace, next statement starts on the new line
              if (buffer.trim() === "") {
                statementStartLine = lineNumber;
              }
            }
          }
        }

        // Handle remaining buffer after stream ends
        const trimmed = buffer.trim();
        if (trimmed && (self.continueOnError || !finalError)) {
          const parseResult = parseStatement(trimmed, self.jsx);
          if (parseResult.complete) {
            const bindings = extractBindingsFromAST(parseResult.sourceFile);
            const transpileResult = self.transpile(trimmed);

            if ("error" in transpileResult) {
              const error: ExecutionError = {
                type: "parse",
                thrown: new Error(transpileResult.error),
                message: transpileResult.error,
                line: statementStartLine,
              };
              if (!finalError) finalError = error;
              pushEvent({
                event: {
                  statement: trimmed,
                  line: statementStartLine,
                  logs: "",
                  error,
                },
              });
            } else {
              const execResult = await self.executeStatement(
                transpileResult.code,
                bindings,
                statementStartLine
              );

              const logs = execResult.logs;
              allLogs += logs;

              const event: ExecutionEvent = {
                statement: trimmed,
                line: statementStartLine,
                logs,
                error: execResult.error,
              };

              pushEvent({ event });

              if (execResult.error && !finalError) {
                finalError = execResult.error;
              }
            }
          } else {
            // Parse error - incomplete statement at end of stream
            const error: ExecutionError = {
              type: "parse",
              thrown: new Error("Incomplete statement"),
              message: "Incomplete statement",
              line: statementStartLine,
            };
            if (!finalError) finalError = error;

            pushEvent({
              event: {
                statement: trimmed,
                line: statementStartLine,
                logs: "",
                error,
              },
            });
          }
        }
      } finally {
        self._running = false;
        pushEvent({ done: true });
        resolveResult({ logs: allLogs, error: finalError });
      }
    })();

    // Event generator pulls from queue
    const eventGenerator = (async function* (): AsyncGenerator<ExecutionEvent> {
      while (true) {
        await waitForEvent();
        const item = eventQueue.shift()!;
        if ("done" in item) {
          return;
        }
        yield item.event;
      }
    })();

    return {
      events: eventGenerator,
      result: resultPromise,
    };
  }

  private transpile(source: string): { code: string } | { error: string } {
    try {
      const loader = this.jsx ? "tsx" : "ts";
      return { code: this.transpiler.transformSync(source, loader) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async executeStatement(
    transpiled: string,
    bindings: Bindings,
    line: number
  ): Promise<{ logs: string; error?: ExecutionError }> {
    // Create per-statement console to isolate logs from async operations
    const statementLogs: string[] = [];
    const statementConsole = this.createConsoleForBuffer(statementLogs);
    this.setContextConsole(statementConsole);

    try {
      const allNames = [
        ...bindings.variables,
        ...bindings.functions,
        ...bindings.classes,
      ];

      let wrapped: string;
      if (allNames.length > 0) {
        // Declaration - wrap, execute, and hoist
        const returnObj = allNames.join(", ");
        wrapped = `(async () => { ${transpiled}; return { ${returnObj} }; })()`;
      } else {
        // Regular statement - just execute
        wrapped = `(async () => { ${transpiled}; })()`;
      }

      const script = new vm.Script(wrapped);

      // Execute with timeout
      const resultPromise = script.runInContext(this._context) as Promise<
        Record<string, unknown> | void
      >;

      const result = await this.withTimeout(resultPromise, this.timeout);

      // Hoist bindings to context
      if (allNames.length > 0 && result) {
        for (const name of allNames) {
          (this._context as Record<string, unknown>)[name] = (
            result as Record<string, unknown>
          )[name];
        }
      }

      return { logs: statementLogs.join("") };
    } catch (e) {
      const logs = statementLogs.join("");

      // Check if it's a timeout error we created
      if (e instanceof Error && e.message === "Execution timeout") {
        return {
          logs,
          error: {
            type: "timeout",
            thrown: e,
            message: "Execution timeout",
            line,
          },
        };
      }

      return {
        logs,
        error: {
          type: "runtime",
          thrown: e,
          message: this.formatErrorMessage(e),
          line,
        },
      };
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timeoutId: Timer | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error("Execution timeout"));
      }, ms);
    });

    try {
      const result = await Promise.race([promise, timeoutPromise]);
      clearTimeout(timeoutId);
      return result;
    } catch (e) {
      clearTimeout(timeoutId);
      throw e;
    }
  }

  private initializeBuiltins(): void {
    const ctx = this._context as Record<string, unknown>;

    // Self-reference
    ctx.globalThis = ctx;

    // Timers
    ctx.setTimeout = setTimeout;
    ctx.clearTimeout = clearTimeout;
    ctx.setInterval = setInterval;
    ctx.clearInterval = clearInterval;
    ctx.queueMicrotask = queueMicrotask;

    // Console starts as a no-op, gets replaced per-statement during execution
    this.setContextConsole(this.createConsoleForBuffer([]));
  }

  private setContextConsole(console: InstanceType<typeof NodeConsole>): void {
    const ctx = this._context as Record<string, unknown>;
    ctx.console = console as unknown as Console;
    if (ctx.globalThis && typeof ctx.globalThis === "object") {
      (ctx.globalThis as Record<string, unknown>).console = ctx.console;
    }
  }

  private createConsoleForBuffer(
    buffer: string[]
  ): InstanceType<typeof NodeConsole> {
    const sink = new Writable({
      write: (chunk, _encoding, callback) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        buffer.push(text);
        callback();
      },
    });

    return new NodeConsole({
      stdout: sink,
      stderr: sink,
      colorMode: false,
    });
  }

  private formatErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === "object" && error !== null) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.length > 0) {
        return message;
      }
    }
    return String(error);
  }
}
