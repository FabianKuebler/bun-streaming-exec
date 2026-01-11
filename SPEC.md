# bun-streaming-exec

Streaming TypeScript/JavaScript executor for LLM-generated code.

## Overview

Execute code statements as they stream from an LLM, without waiting for the complete code block. Statements run immediately when detected, enabling:

- API calls start while tokens still streaming
- UI renders incrementally
- Errors surface immediately
- Real-time execution feedback

## Installation

```bash
bun add bun-streaming-exec
```

## Quick Start

```typescript
import { StreamingExecutor } from 'bun-streaming-exec';

const exec = new StreamingExecutor({
  context: { fetch },
});

const { events, result } = exec.run(llmTokenStream);

for await (const event of events) {
  console.log(`Executed: ${event.statement}`);
  if (event.logs) console.log(event.logs);
  if (event.error) console.error(`Error: ${event.error.message}`);
}

const { logs, error } = await result;
```

---

## API Reference

### `new StreamingExecutor(options?)`

Creates a new executor instance.

```typescript
class StreamingExecutor {
  constructor(options?: StreamingExecutorOptions);
}
```

#### Options

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `context` | `Record<string, unknown>` | `{}` | Initial variables/functions available to executed code |
| `timeout` | `number` | `30000` | Per-statement execution timeout in milliseconds |
| `jsx` | `boolean \| JsxOptions` | `false` | Enable JSX/TSX syntax support |
| `continueOnError` | `boolean` | `false` | Continue executing after errors instead of stopping |

#### Example

```typescript
const exec = new StreamingExecutor({
  context: {
    fetch,
    React,
    myApi: new MyApiClient(),
  },
  timeout: 10000,
});
```

---

### `executor.run(stream)`

Executes code from an async iterable token stream.

```typescript
run(stream: AsyncIterable<string>): StreamingRun;
```

#### Parameters

- `stream` - Async iterable yielding string chunks (tokens from LLM)

#### Returns

```typescript
type StreamingRun = {
  events: AsyncIterable<ExecutionEvent>;
  result: Promise<ExecutionResult>;
};
```

- `events` - Async iterable of execution events (one per statement)
- `result` - Promise resolving when stream ends (independent of event consumption)

#### Behavior

1. Tokens are buffered until a semicolon is encountered
2. On semicolon, buffer is parsed as TypeScript
3. If parse succeeds (complete statement), code is transpiled and executed
4. If parse fails (incomplete), continue buffering
5. On stream end, remaining buffer is flushed and executed
6. Execution stops on first error (unless `continueOnError: true`)

#### Example

```typescript
const { events, result } = exec.run(tokenStream);

for await (const event of events) {
  // Process each executed statement
}

const finalResult = await result;
```

---

### `executor.context`

The underlying `vm.Context`. Variables declared in executed code are accessible here.

```typescript
readonly context: vm.Context;
```

#### Example

```typescript
await exec.run(toStream("const x = 42;")).result;
console.log(exec.context.x); // 42
```

---

### `executor.running`

Whether an execution is currently in progress.

```typescript
readonly running: boolean;
```

---

## Types

### `StreamingExecutorOptions`

```typescript
type StreamingExecutorOptions = {
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
   * Enable JSX/TSX syntax support.
   * Set to true for default React settings, or provide JsxOptions for custom configuration.
   * @default false
   */
  jsx?: boolean | JsxOptions;

  /**
   * Continue executing subsequent statements after an error.
   * When false (default), execution stops on first error.
   * When true, all statements are attempted and errors are reported per-statement.
   * @default false
   */
  continueOnError?: boolean;
};

type JsxOptions = {
  jsx?: "react" | "react-jsx" | "react-jsxdev" | "preserve";
  jsxFactory?: string;
  jsxFragmentFactory?: string;
  jsxImportSource?: string;
};
```

### `StreamingExecutor`

```typescript
class StreamingExecutor {
  constructor(options?: StreamingExecutorOptions);

  /**
   * Execute code from an async token stream.
   * Can be called multiple times - context persists between runs.
   * Cannot be called while another run is in progress.
   */
  run(stream: AsyncIterable<string>): StreamingRun;

  /**
   * The VM context. Access declared variables or inject new ones.
   */
  readonly context: vm.Context;

  /**
   * True while a run() is in progress.
   */
  readonly running: boolean;
}
```

### `StreamingRun`

```typescript
type StreamingRun = {
  /**
   * Async iterable of execution events.
   * Yields one event per executed statement.
   * Events are buffered; consumption is independent of execution.
   */
  events: AsyncIterable<ExecutionEvent>;

  /**
   * Resolves when the stream ends and all statements have executed.
   * Contains aggregated logs and first error (if any).
   * Independent of event consumption - resolves even if events aren't consumed.
   */
  result: Promise<ExecutionResult>;
};
```

### `ExecutionEvent`

```typescript
type ExecutionEvent = {
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
   * Execution stops after first error (unless continueOnError: true).
   */
  error?: ExecutionError;
};
```

### `ExecutionErrorType`

```typescript
type ExecutionErrorType =
  | 'parse'     // Incomplete or invalid syntax
  | 'runtime'   // Code threw an error during execution
  | 'timeout';  // Statement exceeded timeout limit
```

### `ExecutionError`

```typescript
type ExecutionError = {
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
```

### `ExecutionResult`

```typescript
type ExecutionResult = {
  /**
   * All console output from the entire run, concatenated.
   */
  logs: string;

  /**
   * The first error that occurred, if any.
   * Execution stops on first error.
   */
  error?: ExecutionError;
};
```

---

## Behavior

### Statement Detection

Input chunks can be any size - from single characters to entire code blocks. Internally, characters are processed one at a time for line counting and semicolon detection:

```typescript
for await (const chunk of stream) {
  for (const char of chunk) {
    buffer += char;
    if (char === '\n') lineNumber++;
    if (char === ';') { /* try parse */ }
  }
}
```

When a semicolon is encountered, the buffer is parsed using the TypeScript parser. If parsing succeeds (no syntax errors), the statement is complete and executes. If parsing fails (incomplete statement), buffering continues.

This approach handles semicolons inside strings, template literals, regex, and comments automatically - the parser determines completeness, not character-level tracking.

### Transpilation

Code is transpiled from TypeScript/TSX to JavaScript before execution:

- TypeScript types are stripped
- JSX is transformed to `React.createElement` calls
- Modern syntax is preserved (targeting Bun runtime)

### Scope Persistence

Variables, functions, and classes declared in executed code persist in the VM context:

```typescript
// First run
exec.run(toStream("const x = 1;"));

// Second run - x is still available
exec.run(toStream("console.log(x);"));  // logs: 1
```

This enables multi-block conversations where later code references earlier definitions.

### Execution Model

Each statement is wrapped in an async IIFE for execution:

```typescript
// Source
const x = await fetch('/api');

// Executed as (simplified)
(async () => {
  const x = await fetch('/api');
  return { x };
})();
// x is then hoisted to context
```

This enables:
- Top-level await
- Proper async/await handling
- Variable hoisting to persistent context

### Line Number Tracking

Line numbers are tracked by counting newlines as tokens stream in. **Line numbers reset to 1 at the start of each `run()` call.**

```typescript
// First run - lines 1, 2, 3
exec.run(toStream("const x = 1;\nconst y = 2;\nconsole.log(x + y);"));

// Second run - lines reset to 1, 2, 3 (not 4, 5, 6)
exec.run(toStream("const z = 3;\nconst w = 4;\nconsole.log(z + w);"));
```

Each `ExecutionEvent` includes the starting line number of that statement within the current run. If an error occurs, the error's `line` property indicates where the failing statement began in the current code block.

### Error Handling

- **Parse errors** - If final buffer can't be parsed, error with "Incomplete statement"
- **Runtime errors** - Caught and reported with original error object
- **Timeout errors** - Statement terminated, error with "Execution timeout"
- **First error stops execution** - Subsequent statements are not executed (unless `continueOnError: true`)

With `continueOnError: true`, execution continues after errors and all statements are attempted. The `result.error` contains the first error encountered.

### Timeout

Each statement has an independent timeout (default 30s). If exceeded:

1. A timeout error is reported
2. Error event is emitted with timeout message
3. Run stops (unless `continueOnError: true`)

**Important:** The timeout only applies to async operations (e.g., `await fetch(...)`). Synchronous infinite loops (`while(true){}`) cannot be interrupted and will hang the process.

```typescript
const exec = new StreamingExecutor({ timeout: 5000 });

exec.run(toStream("await new Promise(r => setTimeout(r, 10000));"));
// After 5s: ExecutionError { message: "Execution timeout", ... }
```

### Concurrency

- One run at a time per executor
- Calling `run()` while `running === true` throws an error
- Multiple executors can run concurrently (separate VM contexts)

### Event Buffering

Events and result are decoupled:

- Execution runs independently of event consumption
- Events queue in memory until consumed
- `result` resolves when execution completes, regardless of whether events are consumed
- For typical LLM code (short-lived), memory usage is not a concern

---

## Built-in Globals

The following are automatically available in the VM context:

| Global | Description |
|--------|-------------|
| `globalThis` | Reference to the context itself |
| `console` | Captured console (output goes to `logs`) |
| `setTimeout` | Standard timer |
| `clearTimeout` | Standard timer |
| `setInterval` | Standard timer |
| `clearInterval` | Standard timer |
| `queueMicrotask` | Microtask scheduling |

**Not available** (must be provided via `context` option):

- `fetch`
- `Request`, `Response`, `Headers`
- `Buffer`
- `process`
- `require`, `import`
- Any Node.js or Bun-specific APIs

---

## Examples

### Basic Usage

```typescript
import { StreamingExecutor } from 'bun-streaming-exec';

const exec = new StreamingExecutor();

async function* tokenize(code: string) {
  for (const char of code) {
    yield char;
    await new Promise(r => setTimeout(r, 10)); // Simulate streaming
  }
}

const code = `
const x = 1;
const y = 2;
console.log(x + y);
`;

const { events, result } = exec.run(tokenize(code));

for await (const event of events) {
  console.log(`[Line ${event.line}] ${event.statement}`);
  if (event.logs) console.log(`Output: ${event.logs}`);
}

// Output:
// [Line 1] const x = 1;
// [Line 2] const y = 2;
// [Line 3] console.log(x + y);
// Output: 3
```

### With LLM Stream (Anthropic)

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { StreamingExecutor } from 'bun-streaming-exec';

const client = new Anthropic();
const exec = new StreamingExecutor({ context: { fetch } });

async function* extractCode(stream: AsyncIterable<any>) {
  let inCodeBlock = false;
  for await (const event of stream) {
    if (event.type === 'content_block_delta') {
      const text = event.delta.text;
      // Simplified - real impl needs proper fence detection
      if (text.includes('```')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) yield text;
    }
  }
}

const stream = client.messages.stream({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Write code to fetch a random joke' }],
});

const { events, result } = exec.run(extractCode(stream));

for await (const event of events) {
  if (event.logs) process.stdout.write(event.logs);
  if (event.error) console.error('Error:', event.error.message);
}
```

### With LLM Stream (Vercel AI SDK)

```typescript
import { streamText } from 'ai';
import { StreamingExecutor } from 'bun-streaming-exec';

const exec = new StreamingExecutor({ context: { fetch } });

const { textStream } = await streamText({
  model: yourModel,
  prompt: 'Write TypeScript code to...',
});

// Extract code from markdown (simplified)
async function* extractCode(stream: AsyncIterable<string>) {
  // ... fence detection logic
}

const { events } = exec.run(extractCode(textStream));

for await (const event of events) {
  console.log('Executed:', event.statement);
}
```

### Context Persistence

```typescript
const exec = new StreamingExecutor({
  context: { fetch },
});

// First code block
const run1 = exec.run(toStream(`
  const API_URL = 'https://api.example.com';
  const headers = { 'Authorization': 'Bearer xxx' };
`));
await run1.result;

// Second code block - can use variables from first
const run2 = exec.run(toStream(`
  const response = await fetch(API_URL, { headers });
  console.log(response.status);
`));
await run2.result;
```

### Error Handling

```typescript
const exec = new StreamingExecutor();

const { events, result } = exec.run(toStream(`
  const x = 1;
  throw new Error('Something went wrong');
  const y = 2;  // Never executed
`));

for await (const event of events) {
  if (event.error) {
    console.error(`[${event.error.type}] Line ${event.error.line}: ${event.error.message}`);

    // Access original error for stack trace
    if (event.error.thrown instanceof Error) {
      console.error(event.error.thrown.stack);
    }

    // Handle by type
    switch (event.error.type) {
      case 'parse':
        console.log('Syntax error in code');
        break;
      case 'runtime':
        console.log('Code threw an exception');
        break;
      case 'timeout':
        console.log('Code took too long');
        break;
    }
  }
}

const { error } = await result;
if (error) {
  console.log('Run failed:', error.message);
}
```

### Custom Timeout

```typescript
const exec = new StreamingExecutor({ timeout: 5000 });

const { events } = exec.run(toStream(`
  // This will timeout
  await new Promise(r => setTimeout(r, 10000));
`));

for await (const event of events) {
  if (event.error) {
    console.log(event.error.message); // "Execution timeout"
  }
}
```

---

## Limitations

### No Imports

ES modules (`import`) and CommonJS (`require`) are not supported. All dependencies must be provided via the `context` option.

```typescript
// This will NOT work
import { z } from 'zod';

// Do this instead
const exec = new StreamingExecutor({
  context: { z: require('zod').z },
});
```

### No Security Sandbox

The VM context is NOT a security sandbox. Malicious code can:

- Access the host process via various escapes
- Consume unbounded memory
- Block the event loop (until timeout)

**Do not execute untrusted code.** This library is designed for LLM-generated code in controlled environments where the LLM is instructed to generate safe code.

### Single-Threaded

All execution happens on the main thread. Long-running statements block other code until timeout.

### Bun-Only

This library uses Bun-specific APIs:

- `Bun.Transpiler` for TypeScript/JSX transpilation

It will not work in Node.js or browser environments.

---

## Internals

### How Statement Detection Works

1. Characters are buffered one by one
2. On semicolon, attempt to parse buffer as TypeScript
3. Parser tracks: string literals, template literals, regex, comments, brackets
4. If parse succeeds with no errors → complete statement
5. If parse fails → semicolon was inside something, keep buffering

### How Execution Works

1. TypeScript is transpiled to JavaScript via `Bun.Transpiler`
2. AST is analyzed to extract declared bindings (variables, functions, classes)
3. Code is wrapped in async IIFE: `(async () => { ${code}; return { bindings }; })()`
4. Script runs in VM context via `vm.Script.runInContext()`
5. Returned bindings are hoisted to context for persistence
6. Console output is captured via custom Console writing to buffer

### Dependencies

- `node:vm` - VM context and script execution
- `node:console` - Custom console for output capture
- `node:stream` - Writable stream for console output
- `typescript` - Parsing and AST analysis
- `Bun.Transpiler` - TypeScript/JSX transpilation

---

## Package Structure

```
bun-streaming-exec/
├── src/
│   ├── index.ts              # Public exports
│   ├── streaming-executor.ts # Main class implementation
│   ├── ts-parser.ts          # TypeScript parsing utilities
│   └── types.ts              # Type definitions
├── test/
│   └── streaming-executor.test.ts
├── package.json
├── tsconfig.json
├── .gitignore
├── LICENSE
├── README.md
└── SPEC.md
```

### Entry Point

```typescript
// src/index.ts
export { StreamingExecutor } from './streaming-executor';
export type {
  StreamingExecutorOptions,
  StreamingRun,
  ExecutionEvent,
  ExecutionError,
  ExecutionErrorType,
  ExecutionResult,
} from './types';
```

### package.json

```json
{
  "name": "bun-streaming-exec",
  "version": "0.1.0",
  "description": "Streaming TypeScript/JavaScript executor for LLM-generated code",
  "type": "module",
  "main": "src/index.ts",
  "module": "src/index.ts",
  "types": "src/index.ts",
  "exports": {
    ".": {
      "import": "./src/index.ts",
      "types": "./src/index.ts"
    }
  },
  "files": ["src", "README.md", "LICENSE"],
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.0.0"
  },
  "peerDependencies": {
    "bun": ">=1.0.0"
  },
  "keywords": ["bun", "streaming", "executor", "llm", "typescript", "vm"],
  "license": "MIT"
}
```

---

## Development

### Setup

```bash
git clone https://github.com/YOUR_USERNAME/bun-streaming-exec
cd bun-streaming-exec
bun install
```

### Testing

```bash
bun test
```

### Type Checking

```bash
bun run typecheck
```

---

## Test Coverage

Note: Statement completion uses the TypeScript parser to determine if buffered code is complete. Tests should verify end-to-end behavior, not parser internals.

### Execution

| Test | What to Verify |
|------|----------------|
| **Basic** | Simple statement executes, logs captured |
| **Multiple statements** | Each statement yields separate event |
| **Async/await** | Top-level await works |
| **Async ordering** | Sequential async statements execute in order |
| **Console methods** | log, error, warn, info all captured |
| **Console serialization** | Objects/arrays serialize correctly |

### Streaming

| Test | What to Verify |
|------|----------------|
| **Char-by-char** | Single character chunks produce correct result |
| **Whole code** | Entire code in one chunk produces correct result |
| **Variable chunks** | Random chunk sizes produce same result |
| **Empty stream** | No events, no errors |
| **Whitespace only** | No events, no errors |

### Scope Persistence

| Test | What to Verify |
|------|----------------|
| **Across statements** | Variable from statement 1 available in statement 2 |
| **Across runs** | Variable from run 1 available in run 2 |
| **Functions** | Declared functions persist and callable |
| **Classes** | Declared classes persist and instantiable |

### Statement Completion

| Test | What to Verify |
|------|----------------|
| **For loop** | `for (let i=0; i<10; i++) {}` - internal semicolons don't split |
| **No semicolon** | `function foo() {}` alone - executes on stream end |
| **Batching** | `function foo() {}\nfoo();` - batched until semicolon |
| **Multiple per trigger** | `const x=1; const y=2;` - first semicolon executes first statement only |

### Errors

| Test | What to Verify |
|------|----------------|
| **Parse error** | Incomplete syntax at stream end → type: 'parse' |
| **Runtime error** | Thrown error caught → type: 'runtime' |
| **Timeout** | Long-running statement → type: 'timeout' |
| **Error line** | Error reports correct line number |
| **Error stops** | Subsequent statements don't execute after error |
| **thrown property** | Original error object accessible |

### Line Numbers

| Test | What to Verify |
|------|----------------|
| **Tracking** | Multi-line code reports correct line per statement |
| **Reset** | Second run() starts at line 1 |

### Context

| Test | What to Verify |
|------|----------------|
| **Initial context** | Provided values accessible in code |
| **Context mutation** | Code can modify provided context values |
| **Built-in globals** | setTimeout, console, globalThis available |
| **Concurrency guard** | Throws if run() called while running |

### Transpilation

| Test | What to Verify |
|------|----------------|
| **Type annotations** | `const x: number = 1` works |
| **Interfaces** | `interface Foo {}` transpiles to nothing, no error |
| **Type aliases** | `type X = string` transpiles to nothing, no error |
| **Enums** | `enum Color { Red }` works (has runtime representation) |
| **JSX** | `<div />` transforms (requires React in context) |

---

## License

MIT
