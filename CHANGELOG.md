# Changelog

All notable changes to Go Interface Lens are documented here.

## [2.0.7] - 2026-08-20

### Changed

- Raise locked-dependency ripgrep sharding to a CPU-aware ceiling of 16
  processes and enforce that ceiling globally across concurrent interface,
  implementation, and type-reference searches. Ripgrep retains automatic
  internal threading.

## [2.0.6] - 2026-08-20

### Changed

- Split explicit locked-dependency search directories across up to four
  concurrent ripgrep processes. Each process retains ripgrep's automatic
  internal threading; single-root workspace searches remain single-process.

## [2.0.5] - 2026-08-19

### Changed

- Prefilter ripgrep declaration candidates by the target method's parameter and
  result counts before loading complete workspace or locked-dependency packages.
  The lightweight scanner handles multiline declarations, grouped names, nested
  function types, and generics, while retaining uncertain files for Tree-sitter.

## [2.0.4] - 2026-08-19

### Changed

- Support `*` and `?` wildcards in `goInterfaceLens.excludedFolders` and reject
  matching paths before they can enter Tree-sitter parsing.
- Remove the full-workspace lightweight candidate index and its persistent
  cache. Startup now only registers workspace roots and installs file watchers.
- Search file contents for receiver-method and interface declarations with
  ripgrep per query, load only matching complete packages, then recursively
  expand aliases and embedded types before exact Tree-sitter verification.
- Include partial anchor-method providers during type-reference expansion so
  implementations assembled from multiple cross-package embeds are found.
- Bound on-demand workspace loading to eight packages at a time and 16 source
  reads per selected package.
- Remove function bodies before Tree-sitter parses selected packages while
  preserving function signatures, source offsets, and line numbers.

## [2.0.3] - 2026-08-19

### Changed

- Remove automatic workspace indexing, relation-map construction, dependency
  batch scans, relation snapshots, and parser-worker startup. Navigation now
  builds its lightweight candidate index and parses exact AST candidates only
  after the user invokes a CodeLens action.
- Remove the dependency batch-scan concurrency setting; AST query concurrency
  remains CPU- and memory-aware and workers are created only by real queries.
- Add `goInterfaceLens.excludedPackagePatterns` to exclude wildcard-matched Go
  import paths from workspace indexing, dependency scans, and navigation.
- Strip function body contents before Tree-sitter declaration parsing while
  preserving signatures, source offsets, and line numbers.

## [2.0.2] - 2026-08-19

### Changed

- Prewarm workspace and locked-dependency relationships in bounded batches,
  preserving complete alias, embedding, generic, and method-set resolution
  while avoiding a workspace-wide retained AST view.
- Release batch AST entries, cached dependency source text, cache-pack memory,
  and excess parser workers as soon as their relationship results are merged.
- Rebuild invalidated relationship maps through the same bounded pipeline and
  retain only the completed forward/reverse indexes after prewarming.
- Bound parser concurrency by cgroup memory headroom in addition to available
  CPUs, and expose dependency ripgrep concurrency as a setting that defaults to
  eight threads.
- Log prewarm stage memory watermarks, peak/final RSS and heap usage, worker
  counts, batch sizes, and memory collection/recycle activity.

### Fixed

- Apply configured generated/test-file exclusions consistently while indexing
  workspace and dependency packages.
- Keep dependency candidates that rely on aliases declared in another file
  when prefiltering packages for exact AST verification.

## [2.0.1] - 2026-08-18

### Changed

- Derive warm and background AST worker concurrency from the CPUs available to
  the extension host, while treating the configured value as a ceiling of 32.
- Search at most one dependency method anchor per workspace interface with a
  line-oriented ripgrep pass, then compensate only the small set of files that
  contain multiline receiver declarations.
- Persist complete candidate results for immutable locked module versions so a
  relationship rebuild can skip dependency discovery after workspace edits.
- Filter line-start method-call noise before loading complete dependency
  packages while retaining interface, alias, embedding, and split-file recall.

### Fixed

- Treat timed-out dependency searches with partial stdout as incomplete, keep
  them out of complete relationship snapshots, and fall back to an exact
  foreground query instead of returning a cached false negative.
- Report zero dependency scans when a complete relationship snapshot is
  restored without running dependency discovery in the current activation.

## [2.0.0] - 2026-08-18

### Changed

- Batch all workspace interface method anchors into one locked-dependency
  candidate scan and one shared AST view during implementation prewarming.
- Share dependency alias, embedding, and type-reference expansion across every
  workspace interface instead of rebuilding a dependency context per interface.
- Build forward implementations, reverse interfaces, and method locations in
  one rare-method-indexed relationship pass.
- Persist complete relationship snapshots so unchanged workspaces can answer
  implementation queries without restoring every AST on the next startup.
- Store declaration ASTs in cache packs with a separate bounded I/O lane, and
  persist dependency ASTs even when their source was prefetched for build tags.
- Select dependency anchors using dependency-side hit counts and restrict
  follow-up type searches to aliases and embedded fields.
- Reuse the previous dependency AST context after package-local edits and parse
  only changed packages when interface signatures are unchanged.
- Report phase timings for workspace AST work, dependency discovery/loading,
  relationship construction, and snapshot restoration.

## [1.2.11] - 2026-08-18

### Fixed

- Include locked dependency implementations and exact method locations in the
  background relation prewarm, so a completed prewarm never falls back to a
  synchronous dependency AST scan on the first `implementations` query.
- Keep dependency parsing at background priority while allowing an explicit
  foreground query to promote the same in-flight external package work.

## [1.2.10] - 2026-08-18

### Added

- Build the complete workspace `interface -> implementation` map during the
  existing background relation prewarm, including empty results and method
  navigation contexts.

### Changed

- Serve prewarmed workspace implementation queries without AST cache reads,
  while continuing to append dependency implementations on demand.

## [1.2.9] - 2026-08-18

### Fixed

- Reserve an initialized AST worker for foreground navigation while reverse
  prewarming is active, and bound background cache-file fan-out so a first
  `implementations` query is not delayed by workspace-wide prewarm work.

## [1.2.8] - 2026-08-18

### Added

- Precompute every workspace `implementation -> interface` relationship in a
  low-priority, multi-worker Tree-sitter background pass after startup.
- Reuse the complete reverse relation map without additional AST reads, and
  invalidate plus rebuild it after workspace edits become idle.

### Changed

- Promote queued background AST work to foreground priority when an explicit
  navigation query needs the same file, while retaining in-flight deduplication.

## [1.2.7] - 2026-08-18

### Added

- Search `go.mod`-locked dependency packages for concrete interface
  implementations, including method-level navigation and promoted methods from
  embedded dependency types.
- Preserve dependency search for projects without a `go.mod` when a dependency
  root is explicitly configured, without scanning an auto-detected global cache.

### Changed

- Always merge matching dependency interfaces into explicit `goto interface`
  results, even when matching workspace interfaces also exist.

### Fixed

- Resolve cross-package alias chains symmetrically when reverse navigation
  compares a workspace receiver with an interface declared in a dependency.

## [1.2.6] - 2026-08-18

### Fixed

- Require a receiver's complete method set to satisfy an interface before
  showing it in reverse `goto interface` results.
- Keep unexported method identities package-scoped while preserving valid
  cross-package implementations contributed through embedding.
- Resolve promoted methods using Go selector depth and ambiguity rules,
  including named-field shadowing, and navigate to the actual contributing
  declaration.

## [1.2.5] - 2026-08-06

### Added

- Show interface-level and method-level CodeLens for generic runtime interfaces.
- Infer one consistent set of type arguments across the complete interface
  method set, including multiple parameters, nested composite types, generic
  receivers, and generic interface or struct embeddings.
- Validate inferred concrete type arguments against resolvable interface method
  constraints, including pointer and value method-set rules.
- Validate exact and approximate type terms, unions, `comparable`, named type-set
  constraints, and constraints that depend on another inferred type parameter.

### Fixed

- Treat generic interfaces such as `SingleStepTask[P AsyncTaskPayload]` as
  navigable interfaces instead of silently suppressing their CodeLens.

## [1.2.4] - 2026-08-05

### Performance

- Persist the lightweight workspace candidate index and validate unchanged Go
  files with metadata only, so extension restarts read source text only for
  files that changed.
- Keep the configured AST concurrency as a hard limit while choosing a
  CPU-aware worker limit, and retire burst workers back to the warm baseline
  after they become idle.
- Replace the monolithic AST cache with lazy per-file shards, bounded by an
  in-memory LRU and a 256 MB / 4096-entry disk limit.
- Write only changed AST shards in the background instead of serializing the
  complete cache on every update or synchronously during extension shutdown.

### Fixed

- Reparse only the affected Go file when a persisted AST shard is missing or
  corrupt, without failing the implementation query.

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
