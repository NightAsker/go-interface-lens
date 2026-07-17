# Changelog

All notable changes to Go Interface Lens are documented here.

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
