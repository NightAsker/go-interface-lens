# Changelog

All notable changes to Go Interface Lens are documented here.

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
