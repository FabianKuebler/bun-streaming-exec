import type * as vm from "node:vm";

/**
 * JSX compiler options passed to Bun.Transpiler.
 */
export type JsxOptions = {
  jsx?: "react" | "react-jsx" | "react-jsxdev" | "preserve";
  jsxFactory?: string;
  jsxFragmentFactory?: string;
  jsxImportSource?: string;
};

/**
 * Options for creating a StreamingExecutor instance.
 */
export type StreamingExecutorOptions = {
  /**
   * Initial context - variables and functions available to executed code.
   * These become globals in the VM context.
   */
  context?: Record<string, unknown>;

  /**
   * Per-statement execution timeout in milliseconds.
   * If a statement takes longer, it's terminated with a timeout error.
   * @default 30000
   */
  timeout?: number;

  /**
   * JSX configuration.
   * - undefined/false: JSX disabled (default)
   * - true: JSX enabled with React defaults
   * - object: JSX enabled with custom config
   */
  jsx?: boolean | JsxOptions;

  /**
   * Continue executing subsequent statements after an error.
   * When false (default), execution stops on first error.
   * When true, all statements are attempted and errors are collected per-event.
   * @default false
   */
  continueOnError?: boolean;
};

/**
 * Type of error that occurred during execution.
 */
export type ExecutionErrorType =
  | "parse" // Incomplete or invalid syntax
  | "runtime" // Code threw an error during execution
  | "timeout"; // Statement exceeded timeout limit

/**
 * Error information from execution.
 */
export type ExecutionError = {
  /**
   * Type of error that occurred.
   */
  type: ExecutionErrorType;

  /**
   * The actual thrown value. Access .stack if it's an Error instance.
   * For 'parse' and 'timeout' errors, this is an Error created by the executor.
   */
  thrown: unknown;

  /**
   * Extracted error message (convenience).
   */
  message: string;

  /**
   * Line number where error occurred (1-indexed).
   * Tracked by counting newlines in the streamed source.
   */
  line: number;
};

/**
 * Event emitted for each executed statement.
 */
export type ExecutionEvent = {
  /**
   * The source code that was executed (original, not transpiled).
   */
  statement: string;

  /**
   * Starting line number of this statement (1-indexed).
   * Resets to 1 at the start of each run().
   */
  line: number;

  /**
   * Console output produced by this statement.
   * Includes stdout and stderr from console.log, console.error, etc.
   */
  logs: string;

  /**
   * Present if the statement threw an error.
   * Execution stops after first error.
   */
  error?: ExecutionError;
};

/**
 * Final result after all statements have executed.
 */
export type ExecutionResult = {
  /**
   * All console output from the entire run, concatenated.
   */
  logs: string;

  /**
   * The first error that occurred, if any.
   */
  error?: ExecutionError;
};

/**
 * Return type of executor.run().
 */
export type StreamingRun = {
  /**
   * Async iterable of execution events.
   * Yields one event per executed statement.
   */
  events: AsyncIterable<ExecutionEvent>;

  /**
   * Resolves when the stream ends and all statements have executed.
   * Contains aggregated logs and first error (if any).
   * Resolves independently of whether `events` is consumed.
   */
  result: Promise<ExecutionResult>;
};
