import { describe, test, expect } from "bun:test";
import { StreamingExecutor } from "../src";
import type { ExecutionEvent } from "../src";

// Helper to create an async iterable from a string
async function* toStream(code: string): AsyncIterable<string> {
  yield code;
}

// Helper to create character-by-character stream
async function* toCharStream(code: string): AsyncIterable<string> {
  for (const char of code) {
    yield char;
  }
}

// Helper to collect all events from a run
async function collectEvents(
  events: AsyncIterable<ExecutionEvent>
): Promise<ExecutionEvent[]> {
  const result: ExecutionEvent[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

// =============================================================================
// Execution Tests
// =============================================================================

describe("Execution", () => {
  test("Basic - simple statement executes, logs captured", async () => {
    const exec = new StreamingExecutor();
    const { events, result } = exec.run(toStream('console.log("hello");'));

    const evts = await collectEvents(events);
    const res = await result;

    expect(evts).toHaveLength(1);
    expect(evts[0].statement).toBe('console.log("hello");');
    expect(evts[0].logs).toBe("hello\n");
    expect(evts[0].error).toBeUndefined();
    expect(res.logs).toBe("hello\n");
    expect(res.error).toBeUndefined();
  });

  test("Multiple statements - each statement yields separate event", async () => {
    const exec = new StreamingExecutor();
    const code = "const x = 1; const y = 2; console.log(x + y);";
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    await result;

    expect(evts).toHaveLength(3);
    expect(evts[0].statement).toBe("const x = 1;");
    expect(evts[1].statement).toBe("const y = 2;");
    expect(evts[2].statement).toBe("console.log(x + y);");
    expect(evts[2].logs).toBe("3\n");
  });

  test("Async/await - top-level await works", async () => {
    const exec = new StreamingExecutor();
    const code = "const x = await Promise.resolve(42); console.log(x);";
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    await result;

    expect(evts).toHaveLength(2);
    expect(evts[1].logs).toBe("42\n");
  });

  test("Async ordering - sequential async statements execute in order", async () => {
    const exec = new StreamingExecutor();
    const code = `
      const arr = [];
      arr.push(await Promise.resolve(1));
      arr.push(await Promise.resolve(2));
      arr.push(await Promise.resolve(3));
      console.log(arr.join(','));
    `;
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    const lastEvent = evts[evts.length - 1];
    expect(lastEvent.logs).toBe("1,2,3\n");
  });

  test("Console methods - log, error, warn, info all captured", async () => {
    const exec = new StreamingExecutor();
    const code = `
      console.log("log");
      console.error("error");
      console.warn("warn");
      console.info("info");
    `;
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    expect(res.logs).toContain("log");
    expect(res.logs).toContain("error");
    expect(res.logs).toContain("warn");
    expect(res.logs).toContain("info");
  });

  test("Console serialization - objects/arrays serialize correctly", async () => {
    const exec = new StreamingExecutor();
    const code = 'console.log({ a: 1 }); console.log([1, 2, 3]);';
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    expect(res.logs).toContain("a");
    expect(res.logs).toContain("1");
  });
});

// =============================================================================
// Streaming Tests
// =============================================================================

describe("Streaming", () => {
  test("Char-by-char - single character chunks produce correct result", async () => {
    const exec = new StreamingExecutor();
    const code = "const x = 1; console.log(x);";
    const { events, result } = exec.run(toCharStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    expect(evts).toHaveLength(2);
    expect(evts[1].logs).toBe("1\n");
  });

  test("Whole code - entire code in one chunk produces correct result", async () => {
    const exec = new StreamingExecutor();
    const code = "const x = 5; const y = 10; console.log(x * y);";
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    await result;

    expect(evts).toHaveLength(3);
    expect(evts[2].logs).toBe("50\n");
  });

  test("Variable chunks - random chunk sizes produce same result", async () => {
    const exec = new StreamingExecutor();
    const code = "const a = 'hello'; const b = 'world'; console.log(a + ' ' + b);";

    // Create variable sized chunks
    async function* variableChunks(): AsyncIterable<string> {
      let i = 0;
      while (i < code.length) {
        const chunkSize = Math.floor(Math.random() * 5) + 1;
        yield code.slice(i, i + chunkSize);
        i += chunkSize;
      }
    }

    const { events, result } = exec.run(variableChunks());
    const evts = await collectEvents(events);
    const res = await result;

    expect(evts.length).toBeGreaterThanOrEqual(2);
    expect(res.logs).toContain("hello world");
  });

  test("Empty stream - no events, no errors", async () => {
    const exec = new StreamingExecutor();
    async function* empty(): AsyncIterable<string> {}

    const { events, result } = exec.run(empty());
    const evts = await collectEvents(events);
    const res = await result;

    expect(evts).toHaveLength(0);
    expect(res.logs).toBe("");
    expect(res.error).toBeUndefined();
  });

  test("Whitespace only - no events, no errors", async () => {
    const exec = new StreamingExecutor();
    const { events, result } = exec.run(toStream("   \n\t\n  "));

    const evts = await collectEvents(events);
    const res = await result;

    expect(evts).toHaveLength(0);
    expect(res.error).toBeUndefined();
  });
});

// =============================================================================
// Scope Persistence Tests
// =============================================================================

describe("Scope Persistence", () => {
  test("Across statements - variable from statement 1 available in statement 2", async () => {
    const exec = new StreamingExecutor();
    const code = "const x = 42; console.log(x);";
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    await result;

    expect(evts[1].logs).toBe("42\n");
  });

  test("Across runs - variable from run 1 available in run 2", async () => {
    const exec = new StreamingExecutor();

    // First run
    const run1 = exec.run(toStream("const myVar = 'persistent';"));
    await collectEvents(run1.events);
    await run1.result;

    // Second run - can access myVar
    const run2 = exec.run(toStream("console.log(myVar);"));
    const evts2 = await collectEvents(run2.events);
    await run2.result;

    expect(evts2[0].logs).toBe("persistent\n");
  });

  test("Functions - declared functions persist and callable", async () => {
    const exec = new StreamingExecutor();

    // First run - declare function
    const run1 = exec.run(toStream("function greet(name) { return 'Hello, ' + name; }"));
    await collectEvents(run1.events);
    await run1.result;

    // Second run - call function
    const run2 = exec.run(toStream("console.log(greet('World'));"));
    const evts2 = await collectEvents(run2.events);
    await run2.result;

    expect(evts2[0].logs).toBe("Hello, World\n");
  });

  test("Classes - declared classes persist and instantiable", async () => {
    const exec = new StreamingExecutor();

    // First run - declare class
    const run1 = exec.run(
      toStream("class Counter { constructor() { this.count = 0; } inc() { this.count++; } }")
    );
    await collectEvents(run1.events);
    await run1.result;

    // Second run - instantiate and use
    const run2 = exec.run(
      toStream("const c = new Counter(); c.inc(); c.inc(); console.log(c.count);")
    );
    const evts2 = await collectEvents(run2.events);
    await run2.result;

    expect(evts2[evts2.length - 1].logs).toBe("2\n");
  });
});

// =============================================================================
// Statement Completion Tests
// =============================================================================

describe("Statement Completion", () => {
  test("For loop - internal semicolons don't split", async () => {
    const exec = new StreamingExecutor();
    // Note: for loop without trailing semicolon batches with next statement until semicolon
    // This is correct behavior - the parser determines completeness
    const code = "let sum = 0; for (let i = 0; i < 3; i++) { sum += i; }; console.log(sum);";
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    await result;

    // Should be 3 statements: let sum, for loop (with ;), console.log
    expect(evts).toHaveLength(3);
    expect(evts[2].logs).toBe("3\n");
  });

  test("No semicolon - function declaration executes on stream end", async () => {
    const exec = new StreamingExecutor();
    const code = "function foo() { return 42; }";
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    await result;

    expect(evts).toHaveLength(1);
    expect(evts[0].statement).toBe("function foo() { return 42; }");

    // Verify function is accessible
    expect(exec.context.foo).toBeDefined();
  });

  test("Batching - function and call batched until semicolon", async () => {
    const exec = new StreamingExecutor();
    const code = "function bar() { return 'bar'; }\nbar();";
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    await result;

    // Should execute as one unit since only one semicolon
    expect(evts).toHaveLength(1);
  });

  test("Multiple per trigger - first semicolon executes first statement only", async () => {
    const exec = new StreamingExecutor();
    const code = "const a = 1; const b = 2;";
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    await result;

    expect(evts).toHaveLength(2);
    expect(evts[0].statement).toBe("const a = 1;");
    expect(evts[1].statement).toBe("const b = 2;");
  });
});

// =============================================================================
// Error Tests
// =============================================================================

describe("Errors", () => {
  test("Parse error - incomplete syntax at stream end gives type: 'parse'", async () => {
    const exec = new StreamingExecutor();
    const code = "const x = ";
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    expect(evts).toHaveLength(1);
    expect(evts[0].error).toBeDefined();
    expect(evts[0].error!.type).toBe("parse");
    expect(evts[0].error!.message).toBe("Incomplete statement");
    expect(res.error).toBeDefined();
    expect(res.error!.type).toBe("parse");
  });

  test("Runtime error - thrown error caught gives type: 'runtime'", async () => {
    const exec = new StreamingExecutor();
    const code = 'throw new Error("test error");';
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    expect(evts).toHaveLength(1);
    expect(evts[0].error).toBeDefined();
    expect(evts[0].error!.type).toBe("runtime");
    expect(evts[0].error!.message).toBe("test error");
    expect(res.error!.type).toBe("runtime");
  });

  test("Timeout - long-running statement gives type: 'timeout'", async () => {
    const exec = new StreamingExecutor({ timeout: 100 });
    const code = "await new Promise(r => setTimeout(r, 500));";
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    expect(evts).toHaveLength(1);
    expect(evts[0].error).toBeDefined();
    expect(evts[0].error!.type).toBe("timeout");
    expect(evts[0].error!.message).toBe("Execution timeout");
  });

  test("Error line - error reports correct line number", async () => {
    const exec = new StreamingExecutor();
    const code = "const x = 1;\nconst y = 2;\nthrow new Error('line 3');";
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    await result;

    const errorEvent = evts.find((e) => e.error);
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.line).toBe(3);
  });

  test("Error stops - subsequent statements don't execute after error", async () => {
    const exec = new StreamingExecutor();
    const code = 'const x = 1; throw new Error("stop"); const y = 2;';
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    await result;

    // Only 2 events: const x, and throw (y never executes)
    expect(evts).toHaveLength(2);
    expect(evts[1].error).toBeDefined();
    expect(exec.context.y).toBeUndefined();
  });

  test("thrown property - original error object accessible", async () => {
    const exec = new StreamingExecutor();
    const code = 'throw new TypeError("type error");';
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    await result;

    // Note: VM context has its own global TypeError, so instanceof check
    // against host TypeError fails. Check constructor name instead.
    const thrown = evts[0].error!.thrown as Error;
    expect(thrown.constructor.name).toBe("TypeError");
    expect(thrown.message).toBe("type error");
  });
});

// =============================================================================
// Line Number Tests
// =============================================================================

describe("Line Numbers", () => {
  test("Tracking - multi-line code reports correct line per statement", async () => {
    const exec = new StreamingExecutor();
    const code = "const x = 1;\nconst y = 2;\nconst z = 3;";
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    await result;

    expect(evts[0].line).toBe(1);
    expect(evts[1].line).toBe(2);
    expect(evts[2].line).toBe(3);
  });

  test("Reset - second run() starts at line 1", async () => {
    const exec = new StreamingExecutor();

    // First run - 3 lines
    const run1 = exec.run(toStream("const a = 1;\nconst b = 2;\nconst c = 3;"));
    await collectEvents(run1.events);
    await run1.result;

    // Second run - should start at line 1 again
    const run2 = exec.run(toStream("const d = 4;\nconst e = 5;"));
    const evts2 = await collectEvents(run2.events);
    await run2.result;

    expect(evts2[0].line).toBe(1);
    expect(evts2[1].line).toBe(2);
  });
});

// =============================================================================
// Context Tests
// =============================================================================

describe("Context", () => {
  test("Initial context - provided values accessible in code", async () => {
    const exec = new StreamingExecutor({
      context: { myValue: 42, myFunc: (x: number) => x * 2 },
    });

    const code = "console.log(myValue); console.log(myFunc(5));";
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    expect(res.logs).toContain("42");
    expect(res.logs).toContain("10");
  });

  test("Context mutation - code can modify provided context values", async () => {
    const obj = { count: 0 };
    const exec = new StreamingExecutor({ context: { obj } });

    const code = "obj.count = 42;";
    const { events, result } = exec.run(toStream(code));

    await collectEvents(events);
    await result;

    expect(obj.count).toBe(42);
  });

  test("Built-in globals - setTimeout, console, globalThis available", async () => {
    const exec = new StreamingExecutor();

    const code = `
      console.log(typeof setTimeout);
      console.log(typeof console);
      console.log(typeof globalThis);
    `;
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    expect(res.logs).toContain("function");
    expect(res.logs).toContain("object");
  });

  test("Concurrency guard - throws if run() called while running", async () => {
    const exec = new StreamingExecutor();

    // Start a run with a slow operation
    async function* slowStream(): AsyncIterable<string> {
      yield "await new Promise(r => setTimeout(r, 100));";
    }

    const run1 = exec.run(slowStream());

    // Try to start another run immediately
    expect(() => exec.run(toStream("const x = 1;"))).toThrow(
      "Cannot call run() while another run is in progress"
    );

    // Clean up
    await collectEvents(run1.events);
    await run1.result;
  });
});

// =============================================================================
// Transpilation Tests
// =============================================================================

describe("Transpilation", () => {
  test("Type annotations - const x: number = 1 works", async () => {
    const exec = new StreamingExecutor();
    const code = "const x: number = 1; console.log(x);";
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    expect(res.logs).toBe("1\n");
    expect(res.error).toBeUndefined();
  });

  test("Interfaces - interface Foo {} transpiles to nothing, no error", async () => {
    const exec = new StreamingExecutor();
    const code = "interface Foo { bar: string; }";
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    expect(res.error).toBeUndefined();
  });

  test("Type aliases - type X = string transpiles to nothing, no error", async () => {
    const exec = new StreamingExecutor();
    const code = "type X = string;";
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    expect(res.error).toBeUndefined();
  });

  test("Enums - enum Color { Red } works", async () => {
    const exec = new StreamingExecutor();
    const code = "enum Color { Red, Green, Blue } console.log(Color.Green);";
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    expect(res.logs).toBe("1\n");
    expect(res.error).toBeUndefined();
  });

  test("JSX - <div /> transforms (requires React in context)", async () => {
    // Mock React
    const React = {
      createElement: (type: string, props: any, ...children: any[]) => ({
        type,
        props,
        children,
      }),
    };

    const exec = new StreamingExecutor({ context: { React }, jsx: true });
    const code = 'const el = <div className="test">Hello</div>; console.log(el.type);';
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    expect(res.logs).toBe("div\n");
    expect(res.error).toBeUndefined();
  });
});

// =============================================================================
// Additional Edge Cases
// =============================================================================

describe("Edge Cases", () => {
  test("Semicolons in strings don't trigger execution", async () => {
    const exec = new StreamingExecutor();
    const code = 'const s = "hello; world"; console.log(s);';
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    expect(evts).toHaveLength(2);
    expect(res.logs).toBe("hello; world\n");
  });

  test("Semicolons in template literals don't trigger execution", async () => {
    const exec = new StreamingExecutor();
    const code = "const s = `semi;colon`; console.log(s);";
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    expect(evts).toHaveLength(2);
    expect(res.logs).toBe("semi;colon\n");
  });

  test("Arrow functions work", async () => {
    const exec = new StreamingExecutor();
    const code = "const add = (a: number, b: number) => a + b; console.log(add(2, 3));";
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    expect(res.logs).toBe("5\n");
  });

  test("Destructuring works", async () => {
    const exec = new StreamingExecutor();
    const code = "const { a, b } = { a: 1, b: 2 }; console.log(a + b);";
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    expect(res.logs).toBe("3\n");
  });

  test("Array destructuring works", async () => {
    const exec = new StreamingExecutor();
    const code = "const [x, y] = [10, 20]; console.log(x + y);";
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    expect(res.logs).toBe("30\n");
  });

  test("Context property access works", async () => {
    const exec = new StreamingExecutor();
    const code = "const x = 42;";
    const { events, result } = exec.run(toStream(code));

    await collectEvents(events);
    await result;

    expect(exec.context.x).toBe(42);
  });

  test("Running property is true during execution", async () => {
    const exec = new StreamingExecutor();

    let wasRunning = false;

    async function* checkRunning(): AsyncIterable<string> {
      wasRunning = exec.running;
      yield "const x = 1;";
    }

    const { events, result } = exec.run(checkRunning());
    await collectEvents(events);
    await result;

    expect(wasRunning).toBe(true);
    expect(exec.running).toBe(false);
  });
});

// =============================================================================
// Result Promise Decoupling Tests
// =============================================================================

describe("Result Promise Decoupling", () => {
  test("Result resolves without consuming events", async () => {
    const exec = new StreamingExecutor();
    const code = "const x = 1; console.log(x);";
    const { result } = exec.run(toStream(code));

    // Don't consume events at all - just await result
    const res = await result;

    expect(res.logs).toBe("1\n");
    expect(res.error).toBeUndefined();
    expect(exec.running).toBe(false);
  });

  test("Result resolves with error without consuming events", async () => {
    const exec = new StreamingExecutor();
    const code = 'throw new Error("test");';
    const { result } = exec.run(toStream(code));

    const res = await result;

    expect(res.error).toBeDefined();
    expect(res.error!.type).toBe("runtime");
    expect(res.error!.message).toBe("test");
  });

  test("Can start new run after result resolves without event consumption", async () => {
    const exec = new StreamingExecutor();

    // First run - don't consume events
    const run1 = exec.run(toStream("const a = 1;"));
    await run1.result;

    // Second run should work
    const run2 = exec.run(toStream("const b = 2; console.log(a + b);"));
    const res2 = await run2.result;

    expect(res2.logs).toBe("3\n");
  });

  test("Partial event consumption still allows result to resolve", async () => {
    const exec = new StreamingExecutor();
    const code = "const x = 1; const y = 2; const z = 3;";
    const { events, result } = exec.run(toStream(code));

    // Consume only first event
    const iterator = events[Symbol.asyncIterator]();
    await iterator.next();

    // Result should still resolve
    const res = await result;
    expect(res.error).toBeUndefined();
  });
});

// =============================================================================
// Continue On Error Tests
// =============================================================================

describe("Continue On Error", () => {
  test("continueOnError: false (default) - stops on first error", async () => {
    const exec = new StreamingExecutor();
    const code = 'const x = 1; throw new Error("stop"); const y = 2;';
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    expect(evts).toHaveLength(2);
    expect(evts[1].error).toBeDefined();
    expect(exec.context.y).toBeUndefined();
  });

  test("continueOnError: true - continues after runtime error", async () => {
    const exec = new StreamingExecutor({ continueOnError: true });
    const code = 'const x = 1; throw new Error("error"); const y = 2; console.log(y);';
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    expect(evts).toHaveLength(4);
    expect(evts[0].statement).toBe("const x = 1;");
    expect(evts[1].error).toBeDefined();
    expect(evts[1].error!.type).toBe("runtime");
    expect(evts[2].statement).toBe("const y = 2;");
    expect(evts[3].logs).toBe("2\n");
    expect(exec.context.y).toBe(2);
  });

  test("continueOnError: true - continues after parse error", async () => {
    const exec = new StreamingExecutor({ continueOnError: true });
    // Using eval to trigger a transpilation error mid-stream
    const code = "const x = 1; const @invalid = 2; const y = 3;";
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    // First statement succeeds, second has parse error, third succeeds
    expect(evts.length).toBeGreaterThanOrEqual(2);
    expect(evts[0].error).toBeUndefined();
    const errorEvent = evts.find((e) => e.error?.type === "parse");
    expect(errorEvent).toBeDefined();
  });

  test("continueOnError: true - result contains first error only", async () => {
    const exec = new StreamingExecutor({ continueOnError: true });
    const code = 'throw new Error("first"); throw new Error("second");';
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    expect(evts).toHaveLength(2);
    expect(evts[0].error!.message).toBe("first");
    expect(evts[1].error!.message).toBe("second");
    // Result should have first error
    expect(res.error!.message).toBe("first");
  });

  test("continueOnError: true - continues after timeout", async () => {
    const exec = new StreamingExecutor({ continueOnError: true, timeout: 50 });
    const code = "await new Promise(r => setTimeout(r, 200)); const x = 42; console.log(x);";
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    expect(evts).toHaveLength(3);
    expect(evts[0].error!.type).toBe("timeout");
    expect(evts[2].logs).toBe("42\n");
  });

  test("continueOnError: true - all logs aggregated despite errors", async () => {
    const exec = new StreamingExecutor({ continueOnError: true });
    const code = 'console.log("a"); throw new Error("err"); console.log("b");';
    const { events, result } = exec.run(toStream(code));

    const evts = await collectEvents(events);
    const res = await result;

    expect(res.logs).toContain("a");
    expect(res.logs).toContain("b");
  });
});

// =============================================================================
// Internal API Regression Tests
// =============================================================================

describe("Internal API Regression", () => {
  // This test verifies that the internal parseDiagnostics API still works.
  // If this test fails after a TypeScript upgrade, we need to investigate
  // whether the internal API changed or find an alternative approach.
  test("parseDiagnostics - internal TS API still accessible", async () => {
    const ts = await import("typescript");
    const sourceFile = ts.createSourceFile(
      "test.ts",
      "const x = 1;",
      ts.ScriptTarget.ESNext,
      true
    );

    const diagnostics = (sourceFile as unknown as { parseDiagnostics: unknown[] })
      .parseDiagnostics;

    expect(diagnostics).toBeDefined();
    expect(Array.isArray(diagnostics)).toBe(true);
  });
});
