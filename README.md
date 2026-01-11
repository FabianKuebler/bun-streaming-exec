# bun-streaming-exec

[![npm](https://img.shields.io/npm/v/bun-streaming-exec)](https://www.npmjs.com/package/bun-streaming-exec)

Streaming TypeScript/JavaScript executor for LLM-generated code.

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
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { sendMail, calendar } from './skills';

const exec = new StreamingExecutor({
  context: { sendMail, calendar },
});

const { textStream } = streamText({
  model: openai('gpt-5.2'),
  prompt: 'Write code to fetch and display user data',
});

const { events, result } = exec.run(textStream);

// yields as each statement executes
for await (const event of events) {
  if (event.logs) console.log(event.logs);
  if (event.error) console.error(event.error.message);
}

// resolves when execution completes
const { logs, error } = await result;
```

## API

### `new StreamingExecutor(options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `context` | `Record<string, unknown>` | `{}` | Variables/functions available to executed code |
| `timeout` | `number` | `30000` | Per-statement timeout in milliseconds |
| `jsx` | `boolean \| JsxOptions` | `false` | Enable JSX/TSX syntax support |
| `continueOnError` | `boolean` | `false` | Continue executing after errors instead of stopping |

### `executor.run(stream)`

Execute code from an async iterable token stream.

```typescript
run(stream: AsyncIterable<string>): StreamingRun
```

Returns:
- `events` - Async iterable of execution events (one per statement)
- `result` - Promise resolving when stream ends

### `executor.context`

The VM context. Variables declared in executed code are accessible here.

### `executor.running`

Whether an execution is currently in progress.

## Types

```typescript
type ExecutionEvent = {
  statement: string;      // Source code executed
  line: number;           // Starting line number (1-indexed)
  logs: string;           // Console output from this statement
  error?: ExecutionError; // Present if statement threw (stops execution unless continueOnError: true)
};

type ExecutionError = {
  type: 'parse' | 'runtime' | 'timeout';
  thrown: unknown;        // Original error object
  message: string;        // Error message
  line: number;           // Line where error occurred
};

type ExecutionResult = {
  logs: string;           // All console output
  error?: ExecutionError; // First error (if continueOnError: false) or first error encountered (if true)
};
```

## Behavior

### Statement Detection

Tokens are buffered until a semicolon is encountered. The TypeScript parser determines if the buffer is a complete statement. This handles semicolons inside strings, template literals, and comments automatically.

### Scope Persistence

Variables, functions, and classes persist across statements and across multiple `run()` calls:

```typescript
await exec.run(toStream("const x = 1;")).result;
await exec.run(toStream("console.log(x);")).result; // logs: 1
```

### Built-in Globals

Available: `globalThis`, `console`, `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `queueMicrotask`

Not available (provide via `context`): `fetch`, `Buffer`, `process`, `require`, `import`

## Limitations

- **No imports** - ES modules and CommonJS not supported. Provide dependencies via `context`.
- **No security sandbox** - Do not execute untrusted code. The `vm` module is not a security mechanism.
- **Bun-only** - Uses `Bun.Transpiler` for TypeScript/JSX.
- **Timeout limitation** - The timeout only applies to async operations. Synchronous infinite loops (`while(true){}`) cannot be interrupted and will hang the process.

## Acknowledgments

This project was written with [Claude Code](https://claude.ai/code).

## License

MIT
