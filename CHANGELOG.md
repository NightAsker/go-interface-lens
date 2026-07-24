# Changelog

All notable changes to Go Interface Lens are documented here.

## [1.2.2] - 2026-07-24

### Changed

- Increase the default Tree-sitter worker concurrency from 2 to 16.
- Allow `goInterfaceLens.astConcurrency` values from 1 through 32 and enforce
  the same upper bound in the worker pool.

## [1.2.1] - 2026-07-24

### Changed

- Replace the handwritten Go tokenizer and parser with Microsoft-maintained
  `@vscode/tree-sitter-wasm` and the Tree-sitter Go grammar.
- Require VS Code 1.76 or newer for the Node 16-compatible Tree-sitter runtime.
- Parse one source file per task and release its syntax tree immediately after
  extracting compact declaration metadata.
- Keep startup indexing text-based and parse only the current document,
  candidate packages, and required embedded or imported dependency packages.

### Fixed

- Use grammar nodes to distinguish unparenthesized composite result types from
  method bodies, including `interface{}`, `any`, maps, slices, pointers,
  channels, functions, anonymous structs/interfaces, and generic composites.
- Normalize Tree-sitter channel and standard-library interface signatures
  consistently during embedded method-set resolution.

### Packaging

- Vendor only the locked upstream Tree-sitter JavaScript runtime, core runtime
  WASM, Go grammar WASM, and MIT license; exclude all other grammars.

## [1.1.6] - 2026-07-24

### Fixed

- Parse unparenthesized `interface{}`, anonymous `struct`/`interface`, and nested
  map, slice, pointer, array, channel, function, and generic result types without
  mistaking their type braces for the start of a method body.

## [1.1.5] - 2026-07-21

### Improved

- Prewarm declaration parser workers after the background workspace index is
  ready, removing worker startup from the first implementation lookup without
  eagerly parsing workspace files.
- Reuse alias-analysis AST views and import-path caches during lazy queries to
  avoid rebuilding the same merged declaration indexes.
- Share the current document AST between both CodeLens providers until the
  document version changes.

## [1.1.4] - 2026-07-20

### Fixed

- Respect Go method shadowing when a struct embeds an interface but declares a
  same-named pointer-receiver method, so only `*T` is reported as implementing
  the interface.

## [1.1.3] - 2026-07-20

### Changed

- Rewrite the README around the extension's candidate-index and lazy-AST
  architecture, supported Go syntax, configuration, usage, and troubleshooting.

## [1.1.2] - 2026-07-20

### Fixed

- Normalize named pointer, slice, array, variadic, channel, qualified, and
  Unicode parameters without discarding their types or named result types.
- Normalize field names recursively inside function and anonymous-interface
  types while preserving anonymous-struct field identity.
- Resolve package-qualified type aliases and alias chains lazily when they are
  needed to compare otherwise mismatched method signature slots.

## [1.1.1] - 2026-07-20

### Fixed

- Recognize structs that implement interfaces through embedded local, imported,
  aliased, standard-library, or module dependency interfaces.
- Treat `byte`/`uint8`, `rune`/`int32`, and `any`/`interface{}` as identical in
  method signatures while respecting package-level shadowing.
- Keep interface aliases out of concrete implementation results while still
  promoting their methods through embedding.

### Improved

- Resolve embedded dependency declarations lazily from the exact go.mod-locked
  module version, local replacement, module replacement, or GOROOT package.
- Reuse the worker-backed declaration cache for dependency packages without
  expanding the startup index or returning dependency concrete types.

## [1.1.0] - 2026-07-17

### Added

- Add a declaration-level Go lexer and AST parser for interfaces, structs,
  aliases, receiver methods, imports, generics, and nested type expressions.
- Parse candidate packages concurrently in a bounded worker pool and persist
  compact per-file declaration IR across extension restarts.
- Add lazy workspace and module-cache AST filtering for interface,
  method-implementation, and reverse-interface navigation.

### Improved

- Distinguish value and pointer receiver method sets, including the different
  promotion rules for embedded `T` and `*T`.
- Resolve workspace imported interfaces and embedded types by module import
  path, preventing unrelated packages' same-named types from matching.
- Recognize split multiline declarations that the previous receiver regex could
  not parse, while retaining fast text matching only as candidate recall.
- Show reverse-interface actions immediately and perform precise matching only
  after click.

### Performance

- Keep startup limited to the existing broad source index; no workspace-wide
  AST is constructed.
- Parse only candidate packages, prioritize interactive jobs, deduplicate
  in-flight file parsing, and cache completed query results.
- On the synthetic 402-file benchmark, startup indexing took about 77ms, the
  cold rare-method AST query took about 33ms, and only two files were parsed.

## [1.0.3] - 2026-07-16

### Changed

- Prewarm open workspace indexes in the background shortly after extension
  activation, without blocking CodeLens rendering.
- Start the same deduplicated background build when an interface-only file is
  opened, so its first implementation lookup is usually ready before click.
- Show progress feedback after 250ms instead of leaving slow first searches
  without visible feedback for one second.

### Performance

- Keep dependency directories and the Go module cache out of automatic
  prewarming; dependency lookup remains bounded and on-demand.

## [1.0.2] - 2026-07-16

### Added

- Include unsaved Go document changes in implementation lookup through a
  debounced in-memory overlay.
- Respect current GOOS/GOARCH filename constraints and build expressions when
  indexing workspace and dependency files.
- Recognize interface literal aliases, next-line interface braces, and compact
  receiver declarations.

### Fixed

- Canonicalize import aliases, package-local type aliases, and nested function
  parameter names before comparing method signatures.
- Return method-level results for implementations promoted through embedded
  local types, with navigation to the declaring method.
- Find compact single-line dependency interfaces and same-file interfaces that
  inherit the queried method.

### Performance

- Keep signature canonicalization in the merged-index build and cache promoted
  method locations, preserving in-memory query-time matching.
- Keep dependency lookup bounded and avoid Go toolchain subprocesses or full
  module-cache indexing.

## [1.0.1] - 2026-07-13

### Fixed

- Keep same-named interfaces and receiver types isolated by package during
  implementation and reverse-interface lookup.
- Resolve unqualified embedded interfaces and types within their declaring
  package instead of merging methods from neighbouring packages.

### Packaging

- Exclude tests, local outputs, publishing scripts, and development metadata
  from the VSIX package.

## [1.0.0] - 2026-07-10

### Added

- Bidirectional CodeLens navigation between Go interfaces and implementations.
- Interface-level and method-level implementation search.
- Reverse navigation from receiver methods to matching interfaces.
- Workspace-wide incremental indexing with multi-root support.
- Signature-aware matching, embedded interfaces, promoted methods, aliases, and generics support.
- Configurable folder, file, and type filtering.
- Optional dependency-interface lookup through the Go module cache.

### Performance

- Bounded-concurrency asynchronous file reads during initial indexing.
- Time-sliced parsing that yields to the VS Code extension host.
- Cached interface method expansion and a method-to-interface inverted index.
- First-match short-circuiting for conditional CodeLens checks.

### Attribution

- Includes modifications to MIT-licensed software. Required copyright and
  permission notices are retained in the LICENSE file.
