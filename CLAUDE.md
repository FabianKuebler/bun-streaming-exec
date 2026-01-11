# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun test                    # Run all tests
bun test --watch            # Run tests in watch mode
bun test streaming          # Run tests matching "streaming"
bun run typecheck           # TypeScript type checking
```

## Architecture

This is a Bun-specific library that executes TypeScript/JavaScript code streamed from LLMs statement-by-statement, without waiting for complete code blocks.

### Core Flow

1. **Token streaming** (`streaming-executor.ts`) - Characters buffer until semicolon detected
2. **Completeness check** (`ts-parser.ts`) - TypeScript parser determines if buffer is a complete statement (handles semicolons in strings/comments)
3. **Transpilation** - `Bun.Transpiler` converts TS/TSX to JS
4. **Execution** - Code wrapped in async IIFE, run in `vm.Context`
5. **Binding hoisting** - Declared variables/functions/classes extracted from AST and hoisted to context for persistence across statements

### Key Design Decisions

- **Parser-based statement detection**: Uses TypeScript's parser (not regex/character tracking) to determine statement boundaries. This correctly handles semicolons inside strings, template literals, regex, and comments.
- **Async IIFE wrapping**: Each statement executes as `(async () => { code; return { bindings }; })()` to support top-level await and capture declared bindings.
- **Context persistence**: Variables declared in one statement or run are available in subsequent ones via VM context hoisting.
- **Console capture**: Custom `node:console` instance writes to buffer, captured per-statement in `logs` field.

### Files

- `src/streaming-executor.ts` - Main `StreamingExecutor` class with `run()` method
- `src/ts-parser.ts` - `parseStatement()` for completeness, `extractBindingsFromAST()` for variable/function/class extraction
- `src/types.ts` - All public type definitions
