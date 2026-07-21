'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const {
    parseFile,
    resolveInterfaceMethods,
    satisfies,
    looseSignatureEqual,
    splitNormalizedSignature,
    BUILTIN_INTERFACES,
} = require('./parser');
const { listGoFiles, resolveGoModCache, grepInterfaceFilesForMethod } = require('./search');
const { findGoMod, resolveLockedModuleDirs, resolveModuleImportDirectory } = require('./gomod');
const { currentBuildContext, shouldIncludeGoFile } = require('./build');
const { AstWorkerPool } = require('./ast-cache');

const NON_METHOD_CALLS = new Set([
    'if',
    'for',
    'switch',
    'select',
    'func',
    'go',
    'defer',
    'return',
    'append',
    'cap',
    'clear',
    'close',
    'complex',
    'copy',
    'delete',
    'imag',
    'len',
    'make',
    'max',
    'min',
    'new',
    'panic',
    'print',
    'println',
    'real',
    'recover',
]);

function scanCandidateMethodNames(text) {
    const names = new Set();
    const matcher = /\b([A-Z_a-z]\w*)\s*\(/g;
    let match;
    while ((match = matcher.exec(text))) {
        if (!NON_METHOD_CALLS.has(match[1])) names.add(match[1]);
    }
    return names;
}

// A Go package is identified by its directory plus declared package name. The
// package name component keeps an external test package (`foo_test`) distinct
// from the production package (`foo`) even though both live in the same folder.
// Symbols are then keyed by package identity + bare declaration name, preventing
// unrelated `Service` / `Handler` declarations in different packages from being
// merged into one synthetic method set.
function packageKeyFor(file, packageName) {
    return `${path.dirname(path.normalize(file))}\0${packageName || ''}`;
}

function symbolKeyFor(packageKey, name) {
    return `${packageKey}\0${name}`;
}

function locationKeyFor(file, name) {
    return `${path.normalize(file)}\0${name}`;
}

function importedReferenceIdentity(reference) {
    const match = reference && reference.match(/^@\{([^}]+)\}\.([A-Z_a-z]\w*)$/);
    return match ? { importPath: match[1], name: match[2] } : null;
}

function importedSignatureReferences(signature) {
    return [...signature.matchAll(/@\{([^}]+)\}\.([A-Z_a-z]\w*)/g)].map((match) => ({
        importPath: match[1],
        name: match[2],
    }));
}

function potentialAliasImports(signatures) {
    const imports = new Set();
    const groups = new Map();
    for (const signature of new Set(signatures)) {
        const slots = splitNormalizedSignature(signature);
        if (!slots) continue;
        const key = `${slots.params.length}\0${slots.results.length}`;
        if (!groups.has(key)) {
            groups.set(key, {
                params: slots.params.map(() => new Map()),
                results: slots.results.map(() => new Map()),
            });
        }
        const group = groups.get(key);
        for (const section of ['params', 'results']) {
            for (let i = 0; i < slots[section].length; i++) {
                const slot = slots[section][i];
                if (!group[section][i].has(slot)) {
                    group[section][i].set(slot, importedSignatureReferences(slot));
                }
            }
        }
    }
    for (const group of groups.values()) {
        for (const section of ['params', 'results']) {
            for (const slotValues of group[section]) {
                if (slotValues.size < 2) continue;
                for (const references of slotValues.values()) {
                    for (const reference of references) imports.add(reference.importPath);
                }
            }
        }
    }
    return imports;
}

/**
 * Replace package-local aliases in a normalized signature. This is computed
 * once while building the merged view, so query-time matching remains a direct
 * Map/string comparison.
 */
function canonicalizeAliases(signature, aliases) {
    if (!aliases || aliases.size === 0) return signature;
    let result = signature;

    const resolveTarget = (name, seen) => {
        const target = aliases.get(name);
        if (!target || (seen && seen.has(name))) return target || name;
        if (!/^[A-Z_a-z]\w*$/.test(target) || !aliases.has(target)) return target;
        const nextSeen = new Set(seen || []);
        nextSeen.add(name);
        return resolveTarget(target, nextSeen);
    };

    // Alias chains are normally one or two entries. A bounded repeat also
    // handles aliases used inside composite targets without risking cycles.
    for (let round = 0; round <= aliases.size; round++) {
        let changed = false;
        result = result.replace(/[A-Z_a-z]\w*/g, (token, offset, whole) => {
            if (!aliases.has(token)) return token;
            const previous = offset > 0 ? whole[offset - 1] : '';
            const next = whole[offset + token.length] || '';
            if (previous === '.' || next === '.') return token;
            // Do not rewrite identifiers inside the canonical import-path marker.
            if (whole.lastIndexOf('@{', offset) > whole.lastIndexOf('}', offset)) return token;
            const target = resolveTarget(token);
            if (!target || target === token) return token;
            changed = true;
            return target;
        });
        if (!changed) break;
    }
    return result;
}

function canonicalizeLocalTypes(signature, localNames, importPath) {
    if (!importPath || !localNames || localNames.size === 0) return signature;
    return signature.replace(/[A-Z_a-z]\w*/g, (token, offset, whole) => {
        if (!localNames.has(token)) return token;
        const previous = offset > 0 ? whole[offset - 1] : '';
        const next = whole[offset + token.length] || '';
        if (previous === '.' || next === '.') return token;
        if (whole.lastIndexOf('@{', offset) > whole.lastIndexOf('}', offset)) return token;
        return `@{${importPath}}.${token}`;
    });
}

const PREDECLARED_TYPE_ALIASES = new Map([
    ['byte', 'uint8'],
    ['rune', 'int32'],
    ['any', 'interface{}'],
]);

function canonicalizePredeclaredAliases(signature, localNames) {
    return signature.replace(/[A-Z_a-z]\w*/g, (token, offset, whole) => {
        const target = PREDECLARED_TYPE_ALIASES.get(token);
        if (!target || (localNames && localNames.has(token))) return token;
        const previous = offset > 0 ? whole[offset - 1] : '';
        const next = whole[offset + token.length] || '';
        if (previous === '.' || next === '.') return token;
        if (whole.lastIndexOf('@{', offset) > whole.lastIndexOf('}', offset)) return token;
        return target;
    });
}

function canonicalizeQualifiedAliases(signature, resolveAlias, seen) {
    return signature.replace(/@\{([^}]+)\}\.([A-Z_a-z]\w*)/g, (reference, importPath, name) => {
        const key = `${importPath}\0${name}`;
        if (seen && seen.has(key)) return reference;
        const nextSeen = new Set(seen || []);
        nextSeen.add(key);
        return resolveAlias(importPath, name, nextSeen) || reference;
    });
}

const CANONICAL_BUILTIN_INTERFACES = new Map(
    [...BUILTIN_INTERFACES].map(([name, methods]) => [
        name,
        new Map(
            [...methods].map(([methodName, signature]) => [
                methodName,
                canonicalizePredeclaredAliases(signature),
            ])
        ),
    ])
);

/**
 * Workspace-wide, incrementally maintained index of Go interfaces and types.
 *
 * The original extension re-ran grep across the whole tree on every click.
 * This index is built once (lazily, per root) and then kept fresh with a
 * FileSystemWatcher, so lookups become in-memory map operations. For large
 * repositories this is what makes navigation feel instant compared to gopls,
 * while signature-aware matching keeps it accurate.
 */
class WorkspaceIndex {
    /**
     * @param {() => {excludedFolders:string[], excludedFilePatterns:string[], excludedTypePatterns:string[]}} getConfig
     * @param {(msg:string)=>void} log
     */
    constructor(getConfig, log, options) {
        this.getConfig = getConfig;
        this.log = log || (() => {});
        this.options = options || {};

        // Per-file parse results: absPath -> { packageName, interfaces, types }
        this.files = new Map();
        // Unsaved editor buffers override the corresponding on-disk parse result
        // in merged views without forcing a workspace rebuild.
        this.overlays = new Map();
        this.overlayTexts = new Map();
        this._buildContext = currentBuildContext();
        // Merged views, rebuilt on demand from per-file results.
        this._mergedInterfaces = null; // package+name key -> interface summary
        this._mergedTypes = null; // package+name key -> concrete type summary
        this._resolvedTypeCache = null; // package+name key -> resolved method Map
        this._resolvedTypeSetCache = null; // package+name key -> {value,pointer} method Maps
        this._resolvedInterfaceCache = null; // package+name key -> resolved interface method set
        this._interfacesByMethod = null; // method name -> package-qualified interface keys
        this._methodLocationCache = null;

        // Root -> Promise<void> guarding the initial build.
        this._builds = new Map();
        // Roots whose initial build has COMPLETED (for a synchronous fast path).
        this._builtRoots = new Set();
        this._watcher = null;
        // Debounce timer coalescing bursts of watcher events into one invalidation.
        this._invalidateTimer = null;
        // Listeners notified after the merged view is invalidated (e.g. so
        // CodeLens providers can recompute). Plain callbacks; no vscode types.
        this._changeListeners = new Set();

        // The startup scan records broad method-name candidates only. Exact Go
        // declarations are parsed lazily, in workers, for candidate packages.
        this._candidateFilesByMethod = new Map();
        this._candidateMethodsByFile = new Map();
        this._packageFiles = new Map();
        this._packageKeyByFile = new Map();
        this._packageKeysByDirectory = new Map();
        this._embeddedFiles = new Set();
        this._astQueryCache = new Map();
        this._astInflight = new Map();
        this._astGeneration = 1;
        this._importPathByDirectory = new Map();
        this._packageKeyByImportPath = new Map();
        this._externalImportDirectoryCache = new Map();
        this._externalPackageCache = new Map();
        this._goRootPromise = null;
        const cfg = this.getConfig();
        this.astPool = this.options.disableAst
            ? null
            : new AstWorkerPool({
                  concurrency: cfg.astConcurrency || 2,
                  cacheDir: this.options.cacheDir || '',
                  log: this.log,
              });
    }

    /**
     * Register a callback invoked whenever the index's merged view is
     * invalidated (a Go file was created/changed/deleted, or the cache cleared).
     * Returns a disposer that removes the listener.
     * @param {() => void} listener
     * @returns {{ dispose: () => void }}
     */
    onDidChange(listener) {
        this._changeListeners.add(listener);
        return {
            dispose: () => {
                this._changeListeners.delete(listener);
            },
        };
    }

    _emitChange() {
        for (const listener of this._changeListeners) {
            try {
                listener();
            } catch (_) {
                // A misbehaving listener must not break indexing.
            }
        }
    }

    /** Ensure the index is built for the workspace containing `root`. */
    async ensureBuilt(root) {
        if (this._builds.has(root)) return this._builds.get(root);
        const p = this._build(root).then(() => {
            this._builtRoots.add(root);
            // A freshly-completed build makes new results available; notify
            // listeners so conditional lenses that returned nothing while the
            // build was pending get re-evaluated.
            this._emitChange();
        });
        this._builds.set(root, p);
        return p;
    }

    /**
     * True only if every given root has FINISHED indexing. Lets callers (the
     * conditional CodeLens) choose a synchronous fast path instead of awaiting.
     * @param {string[]} roots
     * @returns {boolean}
     */
    areRootsBuilt(roots) {
        for (const r of roots) {
            if (!this._builtRoots.has(r)) return false;
        }
        return roots.length > 0;
    }

    async _build(root) {
        const cfg = this.getConfig();
        const t0 = Date.now();
        const discovered = await listGoFiles(root, cfg.excludedFolders);
        const goFiles = discovered.filter(
            (file) => !this._isExcluded(file) && shouldIncludeGoFile(file, '', this._buildContext)
        );
        this.log(`Indexing ${goFiles.length} Go files under ${root}`);

        await this._indexFilesInChunks(goFiles);
        this._invalidateMerged();
        this.log(`Index built in ${Date.now() - t0}ms`);
        this._installWatcher();
    }

    /**
     * Read and parse the initial file set without monopolising the extension-host
     * event loop. Reads are issued in small parallel batches; parsing remains
     * synchronous (the parser is CPU-only), but is split into short time slices
     * with a setImmediate yield between slices. This keeps editor input,
     * CodeLens requests, and cancellation/close events responsive while a large
     * workspace is being indexed.
     *
     * @param {string[]} goFiles absolute file paths
     */
    async _indexFilesInChunks(goFiles) {
        const concurrency = Math.max(1, WorkspaceIndex.INDEX_READ_CONCURRENCY);
        const timeSliceMs = Math.max(0, WorkspaceIndex.INDEX_TIME_SLICE_MS);
        let sliceStarted = Date.now();

        for (let start = 0; start < goFiles.length; start += concurrency) {
            const batch = goFiles.slice(start, start + concurrency);
            const sources = await Promise.all(
                batch.map(async (file) => {
                    try {
                        const text = await fs.promises.readFile(file, 'utf8');
                        if (!shouldIncludeGoFile(file, text, this._buildContext)) return null;
                        return { file, text };
                    } catch (err) {
                        this.log(`Failed to read ${file}: ${err.message}`);
                        return null;
                    }
                })
            );

            for (const source of sources) {
                if (!source) continue;
                this._indexText(source.file, source.text);

                if (Date.now() - sliceStarted >= timeSliceMs) {
                    await this._yieldToEventLoop();
                    sliceStarted = Date.now();
                }
            }
        }
    }

    _yieldToEventLoop() {
        return new Promise((resolve) => setImmediate(resolve));
    }

    _removeCandidateFile(absPath) {
        const normalized = path.normalize(absPath);
        const names = this._candidateMethodsByFile.get(normalized);
        if (names) {
            for (const name of names) {
                const files = this._candidateFilesByMethod.get(name);
                if (!files) continue;
                files.delete(normalized);
                if (files.size === 0) this._candidateFilesByMethod.delete(name);
            }
        }
        this._candidateMethodsByFile.delete(normalized);

        const packageKey = this._packageKeyByFile.get(normalized);
        if (packageKey) {
            const files = this._packageFiles.get(packageKey);
            let packageRemoved = false;
            if (files) {
                files.delete(normalized);
                if (files.size === 0) {
                    this._packageFiles.delete(packageKey);
                    packageRemoved = true;
                }
            }
            if (packageRemoved) {
                const directory = path.dirname(normalized);
                const packageKeys = this._packageKeysByDirectory.get(directory);
                if (packageKeys) {
                    packageKeys.delete(packageKey);
                    if (packageKeys.size === 0) this._packageKeysByDirectory.delete(directory);
                }
            }
        }
        this._packageKeyByFile.delete(normalized);
        this._embeddedFiles.delete(normalized);
    }

    _recordCandidateFile(absPath, text, parsed) {
        const normalized = path.normalize(absPath);
        this._removeCandidateFile(normalized);
        const names = scanCandidateMethodNames(text);
        this._candidateMethodsByFile.set(normalized, names);
        for (const name of names) {
            if (!this._candidateFilesByMethod.has(name)) this._candidateFilesByMethod.set(name, new Set());
            this._candidateFilesByMethod.get(name).add(normalized);
        }
        const packageKey = packageKeyFor(normalized, parsed.packageName);
        this._packageKeyByImportPath.clear();
        this._packageKeyByFile.set(normalized, packageKey);
        const directory = path.dirname(normalized);
        if (!this._packageKeysByDirectory.has(directory)) {
            this._packageKeysByDirectory.set(directory, new Set());
        }
        this._packageKeysByDirectory.get(directory).add(packageKey);
        if (!this._packageFiles.has(packageKey)) this._packageFiles.set(packageKey, new Set());
        this._packageFiles.get(packageKey).add(normalized);
        const hasEmbeds =
            [...parsed.interfaces.values()].some((info) => info.embeds && info.embeds.length > 0) ||
            [...parsed.types.values()].some((info) => info.embeds && info.embeds.length > 0);
        if (hasEmbeds) this._embeddedFiles.add(normalized);
    }

    _indexText(absPath, text, invalidateAst) {
        try {
            if (this._isExcluded(absPath) || !shouldIncludeGoFile(absPath, text, this._buildContext)) {
                this.files.delete(absPath);
                this._removeCandidateFile(absPath);
                if (invalidateAst && this.astPool) this.astPool.invalidate(absPath);
                return;
            }
            const parsed = parseFile(text);
            this.files.set(absPath, parsed);
            this._recordCandidateFile(absPath, text, parsed);
            if (invalidateAst && this.astPool) this.astPool.invalidate(absPath);
        } catch (err) {
            this.log(`Failed to parse ${absPath}: ${err.message}`);
        }
    }

    _indexFile(absPath) {
        try {
            const text = fs.readFileSync(absPath, 'utf8');
            this._indexText(absPath, text, true);
        } catch (err) {
            this.log(`Failed to index ${absPath}: ${err.message}`);
        }
    }

    _removeFile(absPath) {
        this.files.delete(absPath);
        this.overlays.delete(absPath);
        this.overlayTexts.delete(absPath);
        this._removeCandidateFile(absPath);
        if (this.astPool) this.astPool.invalidate(absPath);
    }

    updateOverlay(absPath, text, notify) {
        if (this._isExcluded(absPath) || !shouldIncludeGoFile(absPath, text, this._buildContext)) {
            this.overlays.delete(absPath);
            this.overlayTexts.delete(absPath);
            this._invalidateMerged();
            if (notify !== false) this._emitChange();
            return;
        }
        this.overlays.set(absPath, parseFile(text));
        this.overlayTexts.set(absPath, text);
        this._recordCandidateFile(absPath, text, this.overlays.get(absPath));
        this._invalidateMerged();
        if (notify !== false) this._emitChange();
    }

    clearOverlay(absPath) {
        if (!this.overlays.delete(absPath)) return;
        this.overlayTexts.delete(absPath);
        if (this.astPool) this.astPool.clearOverlay(absPath);
        try {
            const text = fs.readFileSync(absPath, 'utf8');
            const parsed = this.files.get(absPath) || parseFile(text);
            this._recordCandidateFile(absPath, text, parsed);
        } catch (_) {
            this._removeCandidateFile(absPath);
        }
        this._invalidateMerged();
        this._emitChange();
    }

    updateFileText(absPath, text) {
        this.overlays.delete(absPath);
        this.overlayTexts.delete(absPath);
        this._indexText(absPath, text, true);
        this._invalidateMerged();
        this._emitChange();
    }

    _invalidateMerged() {
        this._mergedInterfaces = null;
        this._mergedTypes = null;
        // Resolved-method sets are derived from the merged view; drop them too.
        this._resolvedTypeCache = null;
        this._resolvedTypeSetCache = null;
        this._resolvedInterfaceCache = null;
        this._interfacesByMethod = null;
        this._methodLocationCache = null;
        // "receiver\u0000method -> hasLocalInterface" memo is also view-derived.
        this._hasInterfaceCache = null;
        this._astGeneration += 1;
        this._astQueryCache.clear();
        this._astInflight.clear();
    }

    /**
     * Cheap, synchronous, memoized check used by the conditional "goto
     * interface" CodeLens: does any interface already indexed in the workspace
     * declare a method matching `receiverType.methodName`? This never touches the
     * module cache (that expensive search is reserved for an actual click), so it
     * is fast enough to call for every method of every opened file. The result is
     * cached per merged view and reset on invalidation.
     * @param {string} receiverType
     * @param {string} methodName
     * @param {string} [receiverFile] source file that identifies the package
     * @returns {boolean}
     */
    hasLocalInterface(receiverType, methodName, receiverFile) {
        if (!this._hasInterfaceCache) this._hasInterfaceCache = new Map();
        const key = `${receiverFile || ''}\u0000${receiverType}\u0000${methodName}`;
        const hit = this._hasInterfaceCache.get(key);
        if (hit !== undefined) return hit;
        const value =
            this._collectLocalInterfaces(receiverType, methodName, {
                stopAfterFirst: true,
                receiverFile,
            }).results.length > 0;
        this._hasInterfaceCache.set(key, value);
        return value;
    }

    /** Resolve and memoize one interface's expanded method set. */
    _resolveInterfaceMethodsCached(interfaceName, interfaces, seen) {
        if (!this._resolvedInterfaceCache) this._resolvedInterfaceCache = new Map();
        const hit = this._resolvedInterfaceCache.get(interfaceName);
        if (hit) return hit;
        const visiting = seen || new Set();
        if (visiting.has(interfaceName)) return { methods: new Map(), unresolved: [] };
        visiting.add(interfaceName);
        const info = interfaces.get(interfaceName);
        if (!info) return { methods: new Map(), unresolved: [interfaceName] };
        const methods = new Map(info.methods);
        const unresolved = [];
        for (const embed of info.embeds || []) {
            if (info.genericEmbeds && info.genericEmbeds.has(embed)) {
                unresolved.push(embed);
                continue;
            }
            if (BUILTIN_INTERFACES.has(embed)) {
                for (const [name, signature] of CANONICAL_BUILTIN_INTERFACES.get(embed)) {
                    if (!methods.has(name)) methods.set(name, signature);
                }
                continue;
            }
            const imported = importedReferenceIdentity(embed);
            let embeddedKey = null;
            if (imported && this._interfaceKeyByImportIdentity) {
                embeddedKey = this._interfaceKeyByImportIdentity.get(
                    `${imported.importPath}\0${imported.name}`
                );
            } else if (!embed.includes('.')) {
                embeddedKey = symbolKeyFor(info.packageKey, embed);
            }
            if (!embeddedKey || !interfaces.has(embeddedKey)) {
                unresolved.push(embed);
                continue;
            }
            const nested = this._resolveInterfaceMethodsCached(
                embeddedKey,
                interfaces,
                new Set(visiting)
            );
            for (const [name, signature] of nested.methods) {
                if (!methods.has(name)) methods.set(name, signature);
            }
            unresolved.push(...nested.unresolved);
        }
        const resolved = { methods, unresolved };
        this._resolvedInterfaceCache.set(interfaceName, resolved);
        return resolved;
    }

    /**
     * Resolve (and memoize for the life of the current merged view) a concrete
     * type's full method set. `_collectImplementations` / `_collectMethodImplementations`
     * iterate every type and previously recomputed this recursively on each
     * pass — including the strict AND loose passes — which is O(types × embed
     * depth) per click on large repos. Caching by package-qualified type key collapses that
     * to a single computation per type per merged build.
     * @param {string} typeKey
     * @param {Map<string,any>} types merged flat types view
     * @returns {Map<string,string>}
     */
    _resolveTypeMethodsCached(typeKey, types) {
        if (!this._resolvedTypeCache) this._resolvedTypeCache = new Map();
        const hit = this._resolvedTypeCache.get(typeKey);
        if (hit) return hit;
        const resolved = this._resolveTypeMethodSetsCached(typeKey, types).pointer;
        this._resolvedTypeCache.set(typeKey, resolved);
        return resolved;
    }

    _resolveTypeMethodSetsCached(typeKey, types, seen) {
        if (!this._resolvedTypeSetCache) this._resolvedTypeSetCache = new Map();
        const cached = this._resolvedTypeSetCache.get(typeKey);
        if (cached) return cached;
        const visiting = seen || new Set();
        if (visiting.has(typeKey)) return { value: new Map(), pointer: new Map() };
        visiting.add(typeKey);

        const type = types.get(typeKey);
        if (!type) return { value: new Map(), pointer: new Map() };
        const value = new Map();
        const pointer = new Map(type.methods);
        for (const [name, signature] of type.methods) {
            if (!type.pointerOnlyMethods || !type.pointerOnlyMethods.has(name)) value.set(name, signature);
        }

        const promote = (target, mode) => {
            const candidates = new Map();
            for (const embed of type.embeds) {
                if (type.genericEmbeds && type.genericEmbeds.has(embed)) continue;
                const canPromoteInterface = type.struct || type.interfaceAlias;
                const imported = importedReferenceIdentity(embed);
                let embeddedKey = null;
                let embeddedInterfaceKey = null;
                if (imported && this._typeKeyByImportIdentity) {
                    embeddedKey = this._typeKeyByImportIdentity.get(
                        `${imported.importPath}\0${imported.name}`
                    );
                    if (!embeddedKey && canPromoteInterface && this._interfaceKeyByImportIdentity) {
                        embeddedInterfaceKey = this._interfaceKeyByImportIdentity.get(
                            `${imported.importPath}\0${imported.name}`
                        );
                    }
                } else if (!embed.includes('.')) {
                    const localKey = symbolKeyFor(type.packageKey, embed);
                    if (types.has(localKey)) embeddedKey = localKey;
                    else if (
                        canPromoteInterface &&
                        this._mergedInterfaces &&
                        this._mergedInterfaces.has(localKey)
                    ) {
                        embeddedInterfaceKey = localKey;
                    }
                }
                let source;
                if (embeddedKey) {
                    const methods = this._resolveTypeMethodSetsCached(
                        embeddedKey,
                        types,
                        new Set(visiting)
                    );
                    const pointerEmbed = type.pointerEmbeds && type.pointerEmbeds.has(embed);
                    source = pointerEmbed || mode === 'pointer' ? methods.pointer : methods.value;
                } else if (embeddedInterfaceKey) {
                    const embeddedInterface = this._mergedInterfaces.get(embeddedInterfaceKey);
                    if (
                        !embeddedInterface ||
                        embeddedInterface.constraint ||
                        embeddedInterface.generic
                    ) {
                        continue;
                    }
                    source = this._resolveInterfaceMethodsCached(
                        embeddedInterfaceKey,
                        this._mergedInterfaces
                    ).methods;
                } else if (canPromoteInterface && BUILTIN_INTERFACES.has(embed)) {
                    source = CANONICAL_BUILTIN_INTERFACES.get(embed);
                } else {
                    continue;
                }
                for (const [name, signature] of source) {
                    const candidate = candidates.get(name);
                    if (candidate) candidate.count += 1;
                    else candidates.set(name, { signature, count: 1 });
                }
            }
            for (const [name, candidate] of candidates) {
                // A method declared directly on T or *T shadows every promoted
                // method with the same name. A pointer-only method is absent
                // from T's value method set, but it still blocks an embedded
                // interface method from being promoted into that set.
                if (candidate.count === 1 && !type.methods.has(name) && !target.has(name)) {
                    target.set(name, candidate.signature);
                }
            }
        };

        promote(value, 'value');
        promote(pointer, 'pointer');
        const resolved = { value, pointer };
        this._resolvedTypeSetCache.set(typeKey, resolved);
        return resolved;
    }

    _installWatcher() {
        if (this._watcher) return;
        this._watcher = vscode.workspace.createFileSystemWatcher('**/*.go');
        const onChange = (uri) => {
            const p = uri.fsPath;
            if (this._isExcluded(p)) return;
            this._indexFile(p);
            this._scheduleInvalidate();
        };
        this._watcher.onDidCreate(onChange);
        this._watcher.onDidChange(onChange);
        this._watcher.onDidDelete((uri) => {
            this._removeFile(uri.fsPath);
            this._scheduleInvalidate();
        });
    }

    /**
     * Coalesce watcher-driven invalidations. Bulk `.go` activity (a build,
     * `go generate`, gofmt-on-save, branch switch) can fire the watcher for many
     * files in quick succession; invalidating synchronously on each one meant
     * the next navigation rebuilt the whole merged view repeatedly. Per-file
     * parse results in `this.files` are always updated immediately (so no data
     * is lost); only the derived merged view is invalidated once per burst.
     */
    _scheduleInvalidate() {
        if (this._invalidateTimer) return;
        this._invalidateTimer = setTimeout(() => {
            this._invalidateTimer = null;
            this._invalidateMerged();
            // Notify listeners (e.g. CodeLens providers) that results may have
            // changed, so lenses like "goto interface" re-evaluate whether they
            // still have a matching interface.
            this._emitChange();
        }, WorkspaceIndex.INVALIDATE_DEBOUNCE_MS);
        // Do not keep the event loop alive solely for this timer.
        if (this._invalidateTimer && typeof this._invalidateTimer.unref === 'function') {
            this._invalidateTimer.unref();
        }
    }

    _isExcluded(filePath) {
        const cfg = this.getConfig();
        const parts = filePath.split(path.sep);
        for (const folder of cfg.excludedFolders) {
            if (parts.includes(folder)) return true;
        }
        return false;
    }

    _importPathForFile(file) {
        const directory = path.dirname(file);
        if (this._importPathByDirectory.has(directory)) {
            return this._importPathByDirectory.get(directory);
        }
        let importPath = null;
        try {
            const goModPath = findGoMod(directory);
            if (goModPath) {
                const source = fs.readFileSync(goModPath, 'utf8');
                const moduleMatch = source.match(/^\s*module\s+(\S+)/m);
                if (moduleMatch) {
                    const relative = path.relative(path.dirname(goModPath), directory);
                    importPath = moduleMatch[1];
                    if (relative && relative !== '.') {
                        importPath += `/${relative.split(path.sep).join('/')}`;
                    }
                }
            }
        } catch (_) {
            importPath = null;
        }
        this._importPathByDirectory.set(directory, importPath);
        return importPath;
    }

    /** Build (and memoize) the merged interface / type views. */
    _merged() {
        if (this._mergedInterfaces && this._mergedTypes) {
            return { interfaces: this._mergedInterfaces, types: this._mergedTypes };
        }
        const interfaces = new Map(); // package+name key -> declaration location
        const typesByLocation = new Map(); // package+name key -> declaration/method locations
        // Flat maps for package-local embed resolution.
        const typesFlat = new Map();
        const interfacesFlat = new Map();
        const interfaceKeyByLocation = new Map(); // file+bare name -> package+name key
        const typeKeyByLocation = new Map(); // file+bare name -> package+name key

        const effectiveFiles = new Map(this.files);
        for (const [file, parsed] of this.overlays) effectiveFiles.set(file, parsed);

        const aliasesByPackage = new Map();
        const localNamesByPackage = new Map();
        const importPathsByPackage = new Map();
        for (const [file, parsed] of effectiveFiles) {
            const packageKey = packageKeyFor(file, parsed.packageName);
            if (!aliasesByPackage.has(packageKey)) aliasesByPackage.set(packageKey, new Map());
            const aliases = aliasesByPackage.get(packageKey);
            for (const [name, target] of parsed.aliases || []) aliases.set(name, target);
            if (parsed.syntax === 'declaration-ast-v1') {
                if (!localNamesByPackage.has(packageKey)) localNamesByPackage.set(packageKey, new Set());
                const localNames = localNamesByPackage.get(packageKey);
                for (const name of parsed.interfaces.keys()) localNames.add(name);
                for (const name of parsed.types.keys()) localNames.add(name);
                for (const name of (parsed.aliases || new Map()).keys()) localNames.add(name);
                if (!importPathsByPackage.has(packageKey)) {
                    importPathsByPackage.set(
                        packageKey,
                        parsed.importPath || this._importPathForFile(file)
                    );
                }
            }
        }

        const packageByImportPath = new Map();
        for (const [packageKey, importPath] of importPathsByPackage) {
            if (importPath && !packageByImportPath.has(importPath)) {
                packageByImportPath.set(importPath, packageKey);
            }
        }
        const canonicalizeWithinPackage = (signature, packageKey) =>
            canonicalizeLocalTypes(
                canonicalizePredeclaredAliases(
                    canonicalizeAliases(signature, aliasesByPackage.get(packageKey)),
                    localNamesByPackage.get(packageKey)
                ),
                localNamesByPackage.get(packageKey),
                importPathsByPackage.get(packageKey)
            );
        const qualifiedAliasCache = new Map();
        const resolveQualifiedAlias = (importPath, name, seen) => {
            const identity = `${importPath}\0${name}`;
            if (qualifiedAliasCache.has(identity)) return qualifiedAliasCache.get(identity);
            const targetPackage = packageByImportPath.get(importPath);
            const aliases = targetPackage && aliasesByPackage.get(targetPackage);
            const target = aliases && aliases.get(name);
            if (!target) return null;
            const canonicalTarget = canonicalizeWithinPackage(target, targetPackage);
            const resolved = canonicalizeQualifiedAliases(
                canonicalTarget,
                resolveQualifiedAlias,
                seen
            );
            qualifiedAliasCache.set(identity, resolved);
            return resolved;
        };

        for (const [file, parsed] of effectiveFiles) {
            const packageKey = packageKeyFor(file, parsed.packageName);
            const canonicalSignature = (signature) =>
                canonicalizeQualifiedAliases(
                    canonicalizeWithinPackage(signature, packageKey),
                    resolveQualifiedAlias
                ).replace(/\s+/g, '');
            const aliases = aliasesByPackage.get(packageKey);
            for (const [name, info] of parsed.interfaces) {
                const symbolKey = symbolKeyFor(packageKey, name);
                interfaceKeyByLocation.set(locationKeyFor(file, name), symbolKey);
                if (!interfaces.has(symbolKey)) {
                    interfaces.set(symbolKey, {
                        name,
                        packageKey,
                        file,
                        line: info.line,
                        methods: info.methods,
                        embeds: info.embeds,
                        methodLines: info.methodLines || new Map(),
                        constraint: !!info.constraint,
                        generic: !!info.generic,
                        externalSource: !!parsed.externalSource,
                    });
                }
                if (!interfacesFlat.has(symbolKey)) {
                    interfacesFlat.set(symbolKey, {
                        name,
                        packageKey,
                        methods: new Map(),
                        embeds: [],
                        constraint: false,
                        generic: false,
                        genericEmbeds: new Set(),
                        externalSource: false,
                        importPath: importPathsByPackage.get(packageKey) || null,
                    });
                }
                const flat = interfacesFlat.get(symbolKey);
                for (const [m, s] of info.methods) flat.methods.set(m, canonicalSignature(s));
                flat.embeds.push(...info.embeds);
                flat.constraint = flat.constraint || !!info.constraint;
                flat.generic = flat.generic || !!info.generic;
                flat.externalSource = flat.externalSource || !!parsed.externalSource;
                for (const embed of info.genericEmbeds || []) flat.genericEmbeds.add(embed);
                if (!flat.importPath) flat.importPath = importPathsByPackage.get(packageKey) || null;
            }
            for (const [name, info] of parsed.types) {
                const symbolKey = symbolKeyFor(packageKey, name);
                typeKeyByLocation.set(locationKeyFor(file, name), symbolKey);
                if (!typesByLocation.has(symbolKey)) typesByLocation.set(symbolKey, []);
                typesByLocation.get(symbolKey).push({
                    name,
                    packageKey,
                    file,
                    line: info.line,
                    methods: info.methods,
                    embeds: info.embeds,
                    methodLines: info.methodLines || new Map(),
                    methodCharacters: info.methodCharacters || new Map(),
                    pointerMethods: info.pointerMethods || new Set(),
                    pointerEmbeds: info.pointerEmbeds || new Set(),
                    genericEmbeds: info.genericEmbeds || new Set(),
                    declared: info.declared !== false,
                    externalSource: !!parsed.externalSource,
                });

                if (!typesFlat.has(symbolKey)) {
                    typesFlat.set(symbolKey, {
                        name,
                        packageKey,
                        methods: new Map(),
                        embeds: [],
                        pointerOnlyMethods: new Set(),
                        pointerEmbeds: new Set(),
                        genericEmbeds: new Set(),
                        struct: false,
                        aliasTarget: null,
                        interfaceAlias: false,
                        externalSource: false,
                        importPath: importPathsByPackage.get(packageKey) || null,
                    });
                }
                const flat = typesFlat.get(symbolKey);
                for (const [m, s] of info.methods) {
                    flat.methods.set(m, canonicalSignature(s));
                    if (info.pointerMethods && info.pointerMethods.has(m)) {
                        flat.pointerOnlyMethods.add(m);
                    } else {
                        flat.pointerOnlyMethods.delete(m);
                    }
                }
                flat.embeds.push(...info.embeds);
                for (const embed of info.pointerEmbeds || []) flat.pointerEmbeds.add(embed);
                for (const embed of info.genericEmbeds || []) flat.genericEmbeds.add(embed);
                flat.struct = flat.struct || info.struct === true;
                flat.externalSource = flat.externalSource || !!parsed.externalSource;
                if (!flat.aliasTarget && aliases && aliases.has(name)) {
                    flat.aliasTarget = aliases.get(name);
                }
                if (!flat.importPath) flat.importPath = importPathsByPackage.get(packageKey) || null;
            }
        }

        const interfaceKeyByImportIdentity = new Map();
        const typeKeyByImportIdentity = new Map();
        for (const [key, info] of interfacesFlat) {
            if (info.importPath) interfaceKeyByImportIdentity.set(`${info.importPath}\0${info.name}`, key);
        }
        for (const [key, info] of typesFlat) {
            if (info.importPath) typeKeyByImportIdentity.set(`${info.importPath}\0${info.name}`, key);
        }

        const interfaceAliasCache = new Map();
        const isInterfaceAlias = (typeKey, seen) => {
            if (interfaceAliasCache.has(typeKey)) return interfaceAliasCache.get(typeKey);
            const visiting = seen || new Set();
            if (visiting.has(typeKey)) return false;
            visiting.add(typeKey);
            const type = typesFlat.get(typeKey);
            const target = type && type.aliasTarget;
            if (!target) return false;
            if (BUILTIN_INTERFACES.has(target)) {
                interfaceAliasCache.set(typeKey, true);
                return true;
            }
            const imported = importedReferenceIdentity(target);
            let interfaceKey = null;
            let targetTypeKey = null;
            if (imported) {
                const identity = `${imported.importPath}\0${imported.name}`;
                interfaceKey = interfaceKeyByImportIdentity.get(identity);
                targetTypeKey = typeKeyByImportIdentity.get(identity);
            } else if (!target.includes('.')) {
                interfaceKey = symbolKeyFor(type.packageKey, target);
                targetTypeKey = interfaceKey;
            }
            const result =
                !!(interfaceKey && interfacesFlat.has(interfaceKey)) ||
                !!(targetTypeKey && typesFlat.has(targetTypeKey) && isInterfaceAlias(targetTypeKey, visiting));
            interfaceAliasCache.set(typeKey, result);
            return result;
        };
        for (const [typeKey, type] of typesFlat) {
            type.interfaceAlias = isInterfaceAlias(typeKey);
        }

        this._mergedInterfaces = interfacesFlat;
        this._mergedTypes = typesFlat;
        this._typesByLocation = typesByLocation;
        this._interfaceDecls = interfaces;
        this._interfaceKeyByLocation = interfaceKeyByLocation;
        this._typeKeyByLocation = typeKeyByLocation;
        this._interfaceKeyByImportIdentity = interfaceKeyByImportIdentity;
        this._typeKeyByImportIdentity = typeKeyByImportIdentity;

        // Resolve each interface once and build a method-name inverted index.
        // Conditional goto-interface lenses can now inspect only interfaces that
        // actually contain the method (including inherited embedded methods),
        // instead of scanning every interface for every receiver method.
        this._resolvedInterfaceCache = new Map();
        this._interfacesByMethod = new Map();
        for (const [interfaceKey] of interfacesFlat) {
            const resolved = this._resolveInterfaceMethodsCached(interfaceKey, interfacesFlat);
            for (const methodName of resolved.methods.keys()) {
                if (!this._interfacesByMethod.has(methodName)) this._interfacesByMethod.set(methodName, []);
                this._interfacesByMethod.get(methodName).push(interfaceKey);
            }
        }
        return { interfaces: interfacesFlat, types: typesFlat };
    }

    /** Resolve an interface declaration to its package-qualified index key. */
    _findInterfaceKey(interfaceName, interfaceFile) {
        this._merged();
        if (interfaceFile) {
            const exact = this._interfaceKeyByLocation.get(locationKeyFor(interfaceFile, interfaceName));
            return exact || null;
        }
        // Backwards-compatible fallback for programmatic/test callers that only
        // provide a bare name. Editor commands always provide the source file.
        for (const [key, decl] of this._interfaceDecls) {
            if (decl.name === interfaceName) return key;
        }
        return null;
    }

    /** Resolve a receiver type to its package-qualified index key. */
    _findTypeKey(typeName, typeFile) {
        this._merged();
        if (typeFile) {
            const exact = this._typeKeyByLocation.get(locationKeyFor(typeFile, typeName));
            return exact || null;
        }
        // Same compatibility fallback as _findInterfaceKey.
        for (const [key, info] of this._mergedTypes) {
            if (info.name === typeName) return key;
        }
        return null;
    }

    _packageForFile(file) {
        return this._packageKeyByFile.get(path.normalize(file)) || null;
    }

    _candidatePackagesForMethods(methodNames) {
        const embeddedPackages = new Set();
        for (const file of this._embeddedFiles) {
            const packageKey = this._packageKeyByFile.get(file);
            if (packageKey) embeddedPackages.add(packageKey);
        }

        const sets = [];
        for (const methodName of methodNames) {
            const packages = new Set(embeddedPackages);
            for (const file of this._candidateFilesByMethod.get(methodName) || []) {
                const packageKey = this._packageKeyByFile.get(file);
                if (packageKey) packages.add(packageKey);
            }
            sets.push(packages);
        }
        if (sets.length === 0) return new Set();
        sets.sort((a, b) => a.size - b.size);
        const candidates = new Set(sets[0]);
        for (let i = 1; i < sets.length; i++) {
            for (const packageKey of [...candidates]) {
                if (!sets[i].has(packageKey)) candidates.delete(packageKey);
            }
        }
        return candidates;
    }

    async _parseAstPackages(packageKeys, priority) {
        if (!this.astPool) throw new Error('lazy AST index is disabled');
        const requests = [];
        const seen = new Set();
        for (const packageKey of packageKeys) {
            for (const file of this._packageFiles.get(packageKey) || []) {
                if (seen.has(file)) continue;
                seen.add(file);
                requests.push({ file, text: this.overlayTexts.get(file) });
            }
        }
        if (requests.length === 0) return new Map();
        return this.astPool.parseFiles(requests, priority === undefined ? 100 : priority);
    }

    _packageForImportPath(importPath) {
        if (this._packageKeyByImportPath.has(importPath)) {
            return this._packageKeyByImportPath.get(importPath);
        }
        for (const root of this._builds.keys()) {
            try {
                const goModPath = findGoMod(root);
                if (!goModPath) continue;
                const source = fs.readFileSync(goModPath, 'utf8');
                const moduleMatch = source.match(/^\s*module\s+(\S+)/m);
                if (!moduleMatch) continue;
                const modulePath = moduleMatch[1];
                if (importPath !== modulePath && !importPath.startsWith(`${modulePath}/`)) continue;
                const suffix = importPath === modulePath ? '' : importPath.slice(modulePath.length + 1);
                const directory = path.join(path.dirname(goModPath), ...suffix.split('/').filter(Boolean));
                const packageKeys = this._packageKeysByDirectory.get(path.normalize(directory));
                if (packageKeys && packageKeys.size > 0) {
                    const packageKey = packageKeys.values().next().value;
                    this._packageKeyByImportPath.set(importPath, packageKey);
                    return packageKey;
                }
            } catch (_) {
                // Fall through to the package scan for local replacements and
                // non-module workspace layouts.
            }
        }
        for (const [packageKey, files] of this._packageFiles) {
            const firstFile = files.values().next().value;
            if (!firstFile) continue;
            const candidate = this._importPathForFile(firstFile);
            if (candidate) this._packageKeyByImportPath.set(candidate, packageKey);
            if (candidate === importPath) return packageKey;
        }
        this._packageKeyByImportPath.set(importPath, null);
        return null;
    }

    _getGoRoot() {
        const configured = process.env.GOROOT;
        if (configured) return Promise.resolve(configured);
        if (this._goRootPromise) return this._goRootPromise;
        this._goRootPromise = new Promise((resolve) => {
            execFile(
                'go',
                ['env', 'GOROOT'],
                { timeout: 3000, maxBuffer: 1024 * 1024 },
                (error, stdout) => resolve(error ? null : (stdout || '').trim() || null)
            );
        });
        return this._goRootPromise;
    }

    async _resolveExternalImportDirectory(importPath) {
        const segments = importPath && importPath.split('/');
        if (
            !segments ||
            segments.some((segment) => !segment || segment === '.' || segment === '..') ||
            importPath.includes('\\') ||
            path.isAbsolute(importPath)
        ) {
            return null;
        }
        if (this._externalImportDirectoryCache.has(importPath)) {
            return this._externalImportDirectoryCache.get(importPath);
        }
        const request = (async () => {
            const cfg = this.getConfig();
            const modCache = resolveGoModCache(cfg.goModCache);
            for (const root of this._builds.keys()) {
                const directory = resolveModuleImportDirectory(root, importPath, modCache);
                if (directory) return directory;
            }

            const goRoot = await this._getGoRoot();
            if (!goRoot) return null;
            const standardDirectory = path.join(goRoot, 'src', ...importPath.split('/'));
            try {
                if (fs.existsSync(standardDirectory) && fs.statSync(standardDirectory).isDirectory()) {
                    return standardDirectory;
                }
            } catch (_) {
                // The import is not available from this GOROOT.
            }
            return null;
        })();
        this._externalImportDirectoryCache.set(importPath, request);
        return request;
    }

    async _loadExternalPackage(importPath) {
        if (!this.astPool) return null;
        const directory = await this._resolveExternalImportDirectory(importPath);
        if (!directory) return null;
        const cacheKey = `${directory}\0${importPath}`;
        if (this._externalPackageCache.has(cacheKey)) {
            return this._externalPackageCache.get(cacheKey);
        }
        const request = (async () => {
            let entries;
            try {
                entries = await fs.promises.readdir(directory, { withFileTypes: true });
            } catch (_) {
                return null;
            }
            const files = entries
                .filter(
                    (entry) =>
                        entry.isFile() &&
                        entry.name.endsWith('.go') &&
                        !entry.name.endsWith('_test.go')
                )
                .map((entry) => path.join(directory, entry.name))
                .filter((file) => shouldIncludeGoFile(file, '', this._buildContext));
            const sources = await Promise.all(
                files.map(async (file) => {
                    try {
                        const text = await fs.promises.readFile(file, 'utf8');
                        if (!shouldIncludeGoFile(file, text, this._buildContext)) return null;
                        return { file, text };
                    } catch (_) {
                        return null;
                    }
                })
            );
            const parsed = await this.astPool.parseFiles(sources.filter(Boolean), 150);
            return {
                directory,
                files: new Map(
                    [...parsed].map(([file, info]) => [
                        file,
                        { ...info, importPath, externalSource: true },
                    ])
                ),
            };
        })().catch((error) => {
            this.log(`External package parse failed for ${importPath}: ${error.message}`);
            return null;
        });
        this._externalPackageCache.set(cacheKey, request);
        return request;
    }

    async _expandEmbeddedAstPackages(packageKeys, astFiles, priority) {
        const packages = new Set(packageKeys);
        const parsed = new Map(astFiles);
        const externalImports = new Set();
        for (let round = 0; round < 20; round++) {
            const additions = new Set();
            const externalAdditions = new Set();
            for (const fileInfo of parsed.values()) {
                const declarations = [...fileInfo.interfaces.values(), ...fileInfo.types.values()];
                for (const declaration of declarations) {
                    for (const embed of declaration.embeds || []) {
                        if (BUILTIN_INTERFACES.has(embed)) continue;
                        const imported = importedReferenceIdentity(embed);
                        if (!imported) continue;
                        const packageKey = this._packageForImportPath(imported.importPath);
                        if (packageKey && !packages.has(packageKey)) additions.add(packageKey);
                        else if (!packageKey && !externalImports.has(imported.importPath)) {
                            externalAdditions.add(imported.importPath);
                        }
                    }
                }
            }
            if (additions.size === 0 && externalAdditions.size === 0) break;
            for (const packageKey of additions) packages.add(packageKey);
            const addedFiles = await this._parseAstPackages(additions, priority);
            for (const [file, info] of addedFiles) parsed.set(file, info);
            for (const importPath of externalAdditions) externalImports.add(importPath);
            const externalPackages = await Promise.all(
                [...externalAdditions].map((importPath) => this._loadExternalPackage(importPath))
            );
            for (const externalPackage of externalPackages) {
                if (!externalPackage) continue;
                for (const [file, info] of externalPackage.files) parsed.set(file, info);
            }
        }
        return { packages, astFiles: parsed };
    }

    _potentialSignatureAliasImports(astFiles, methodNames) {
        const wanted = new Set(methodNames);
        const view = this._createAstView(astFiles);
        const { interfaces, types } = view._merged();
        const signaturesByMethod = new Map();
        const collect = (methods) => {
            for (const [name, signature] of methods) {
                if (!wanted.has(name)) continue;
                if (!signaturesByMethod.has(name)) signaturesByMethod.set(name, []);
                signaturesByMethod.get(name).push(signature);
            }
        };
        for (const info of interfaces.values()) collect(info.methods);
        for (const info of types.values()) collect(info.methods);
        const imports = new Set();
        for (const signatures of signaturesByMethod.values()) {
            for (const importPath of potentialAliasImports(signatures)) imports.add(importPath);
        }
        return { imports, view };
    }

    async _expandSignatureAliasPackages(astFiles, methodNames, priority) {
        let parsed = new Map(astFiles);
        let view = null;
        let viewIsCurrent = false;
        for (let round = 0; round < 10; round++) {
            const analysis = this._potentialSignatureAliasImports(parsed, methodNames);
            const requested = analysis.imports;
            view = analysis.view;
            viewIsCurrent = true;
            const representedPackages = new Set();
            const representedImports = new Set();
            for (const [file, info] of parsed) {
                const packageKey = this._packageForFile(file);
                if (packageKey) representedPackages.add(packageKey);
                if (info.importPath) representedImports.add(info.importPath);
            }

            const workspaceAdditions = new Set();
            const externalAdditions = new Set();
            for (const importPath of requested) {
                const packageKey = this._packageForImportPath(importPath);
                if (packageKey) {
                    if (!representedPackages.has(packageKey)) workspaceAdditions.add(packageKey);
                } else if (!representedImports.has(importPath)) {
                    externalAdditions.add(importPath);
                }
            }
            if (workspaceAdditions.size === 0 && externalAdditions.size === 0) break;

            const workspaceFiles = await this._parseAstPackages(workspaceAdditions, priority);
            for (const [file, info] of workspaceFiles) parsed.set(file, info);
            const externalPackages = await Promise.all(
                [...externalAdditions].map((importPath) => this._loadExternalPackage(importPath))
            );
            let added = workspaceFiles.size > 0;
            for (const externalPackage of externalPackages) {
                if (!externalPackage) continue;
                for (const [file, info] of externalPackage.files) parsed.set(file, info);
                if (externalPackage.files.size > 0) added = true;
            }
            if (!added) break;
            viewIsCurrent = false;

            const allPackages = new Set([...representedPackages, ...workspaceAdditions]);
            const closure = await this._expandEmbeddedAstPackages(allPackages, parsed, priority);
            parsed = closure.astFiles;
        }
        if (!viewIsCurrent) view = this._createAstView(parsed);
        return { astFiles: parsed, view };
    }

    _createAstView(astFiles) {
        const view = new WorkspaceIndex(this.getConfig, this.log, { disableAst: true });
        view.files = new Map(astFiles);
        view._importPathByDirectory = this._importPathByDirectory;
        return view;
    }

    _interfaceDescriptor(view, interfaceName, interfaceFile) {
        const { interfaces } = view._merged();
        const interfaceKey = view._findInterfaceKey(interfaceName, interfaceFile);
        if (!interfaceKey) return null;
        const declaration = interfaces.get(interfaceKey);
        if (!declaration || declaration.constraint || declaration.generic) return null;
        const resolved = view._resolveInterfaceMethodsCached(interfaceKey, interfaces);
        if (resolved.methods.size === 0) return null;
        return { interfaceKey, resolved };
    }

    _cachedAstQuery(key, work) {
        if (this._astQueryCache.has(key)) return Promise.resolve(this._astQueryCache.get(key));
        if (this._astInflight.has(key)) return this._astInflight.get(key);
        const generation = this._astGeneration;
        let request;
        request = Promise.resolve()
            .then(work)
            .then((result) => {
                if (generation !== this._astGeneration) return this._cachedAstQuery(key, work);
                this._astQueryCache.set(key, result);
                return result;
            })
            .finally(() => {
                if (this._astInflight.get(key) === request) this._astInflight.delete(key);
            });
        this._astInflight.set(key, request);
        return request;
    }

    async _implementationAstContext(interfaceName, interfaceFile) {
        const interfacePackage = this._packageForFile(interfaceFile);
        if (!interfacePackage) return null;
        const interfaceFiles = await this._parseAstPackages(new Set([interfacePackage]), 200);
        const interfaceClosure = await this._expandEmbeddedAstPackages(
            new Set([interfacePackage]),
            interfaceFiles,
            200
        );
        const interfaceView = this._createAstView(interfaceClosure.astFiles);
        const descriptor = this._interfaceDescriptor(interfaceView, interfaceName, interfaceFile);
        if (!descriptor) return null;
        const candidates = this._candidatePackagesForMethods(descriptor.resolved.methods.keys());
        candidates.add(interfacePackage);
        for (const packageKey of interfaceClosure.packages) candidates.add(packageKey);
        const astFiles = await this._parseAstPackages(candidates, 200);
        const closure = await this._expandEmbeddedAstPackages(candidates, astFiles, 200);
        const aliasExpansion = await this._expandSignatureAliasPackages(
            closure.astFiles,
            descriptor.resolved.methods.keys(),
            200
        );
        return {
            astFiles: aliasExpansion.astFiles,
            view: aliasExpansion.view,
            candidatePackages: candidates,
        };
    }

    findImplementationsAst(interfaceName, interfaceFile) {
        const key = `implementations\0${interfaceFile}\0${interfaceName}`;
        return this._cachedAstQuery(key, async () => {
            const started = Date.now();
            const context = await this._implementationAstContext(interfaceName, interfaceFile);
            if (!context) return [];
            const results = context.view.findImplementations(interfaceName, interfaceFile);
            this.log(
                `AST implementation query ${interfaceName}: ${context.candidatePackages.size} package(s), ` +
                    `${context.astFiles.size} file(s), ${Date.now() - started}ms`
            );
            return results;
        });
    }

    findMethodImplementationsAst(interfaceName, methodName, interfaceFile) {
        const key = `method\0${interfaceFile}\0${interfaceName}\0${methodName}`;
        return this._cachedAstQuery(key, async () => {
            const started = Date.now();
            const context = await this._implementationAstContext(interfaceName, interfaceFile);
            if (!context) return [];
            const results = context.view.findMethodImplementations(interfaceName, methodName, interfaceFile);
            this.log(
                `AST method query ${interfaceName}.${methodName}: ${context.candidatePackages.size} package(s), ` +
                    `${context.astFiles.size} file(s), ${Date.now() - started}ms`
            );
            return results;
        });
    }

    findInterfacesAst(receiverType, methodName, opts) {
        const receiverFile = opts && opts.receiverFile;
        const key = `reverse\0${receiverFile || ''}\0${receiverType}\0${methodName}`;
        return this._cachedAstQuery(key, async () => {
            const receiverPackage = this._packageForFile(receiverFile);
            if (!receiverPackage) return [];
            const candidates = this._candidatePackagesForMethods([methodName]);
            candidates.add(receiverPackage);
            const started = Date.now();
            const astFiles = await this._parseAstPackages(candidates, 200);
            const closure = await this._expandEmbeddedAstPackages(candidates, astFiles, 200);
            const aliasExpansion = await this._expandSignatureAliasPackages(
                closure.astFiles,
                [methodName],
                200
            );
            const view = aliasExpansion.view;
            const local = view._collectLocalInterfaces(receiverType, methodName, { receiverFile });
            const results = local.results;
            const cfg = this.getConfig();
            if (results.length === 0 && cfg.searchDependencies !== false) {
                const cacheRoot = resolveGoModCache(cfg.goModCache);
                if (cacheRoot) await this._searchDependencyInterfacesAst(cacheRoot, methodName, local);
            }
            this.log(
                `AST reverse query ${receiverType}.${methodName}: ${candidates.size} package(s), ` +
                    `${aliasExpansion.astFiles.size} file(s), ${Date.now() - started}ms`
            );
            return results;
        });
    }

    async _searchDependencyInterfacesAst(cacheRoot, methodName, local) {
        const lockedDirs = this._resolveLockedDirs(cacheRoot);
        let candidates;
        try {
            candidates = await grepInterfaceFilesForMethod(
                cacheRoot,
                methodName,
                undefined,
                lockedDirs
            );
        } catch (err) {
            this.log(`AST dependency candidate search failed: ${err.message}`);
            return;
        }
        const sources = await Promise.all(
            candidates.map(async (file) => {
                try {
                    if (!shouldIncludeGoFile(file, '', this._buildContext)) return null;
                    const text = await fs.promises.readFile(file, 'utf8');
                    if (!shouldIncludeGoFile(file, text, this._buildContext)) return null;
                    return { file, text };
                } catch (_) {
                    return null;
                }
            })
        );
        const requests = sources.filter(Boolean);
        if (requests.length === 0) return;
        let parsed;
        try {
            parsed = await this.astPool.parseFiles(requests, 200);
        } catch (err) {
            this.log(`AST dependency parsing failed: ${err.message}`);
            return;
        }
        const closure = await this._expandEmbeddedAstPackages(new Set(), parsed, 200);
        const aliasExpansion = await this._expandSignatureAliasPackages(
            closure.astFiles,
            [methodName],
            200
        );
        const view = aliasExpansion.view;
        const { interfaces } = view._merged();
        for (const interfaceKey of view._interfacesByMethod.get(methodName) || []) {
            const declaration = view._interfaceDecls.get(interfaceKey);
            const info = interfaces.get(interfaceKey);
            if (!declaration || !info || info.constraint) continue;
            local.consider(
                interfaceKey,
                view._resolveInterfaceMethodsCached(interfaceKey, interfaces),
                declaration,
                true
            );
        }
        this.log(
            `AST dependency query ${methodName}: ${candidates.length} candidate file(s), ` +
                `${parsed.size} parsed file(s)`
        );
    }

    getAstStats() {
        return this.astPool ? { ...this.astPool.stats } : null;
    }

    warmAstWorkers() {
        return this.astPool ? this.astPool.warmup() : Promise.resolve(0);
    }

    /**
     * Find all concrete types that implement the given interface (by signature).
     * @param {string} interfaceName
     * @param {string} [interfaceFile] source file that identifies the package
     * @returns {{name:string, file:string, line:number}[]}
     */
    findImplementations(interfaceName, interfaceFile) {
        const { interfaces, types } = this._merged();
        const interfaceKey = this._findInterfaceKey(interfaceName, interfaceFile);
        if (!interfaceKey) return [];
        const resolved = this._resolveInterfaceMethodsCached(interfaceKey, interfaces);
        if (resolved.methods.size === 0) return [];

        // Run BOTH the strict pass (exact signatures) and the loose pass, then
        // merge. A cross-package implementation qualifies the interface's types
        // (`processengine.FlowContext`) while the interface, declared in its own
        // package, uses the bare name (`FlowContext`); such an implementation is
        // ONLY found by the loose pass. The previous "loose only if strict found
        // nothing" strategy meant that as soon as any same-package implementation
        // matched strictly, the loose pass was skipped and every cross-package
        // implementation was silently dropped. Merging both is safe now that
        // loose matching is package-aware (see looseSignatureEqual): it no longer
        // equates two different packages' same-named types, so it does not
        // reintroduce cross-package false positives.
        const strict = this._collectImplementations(resolved, types, false);
        const loose = this._collectImplementations(resolved, types, true);
        return dedupeResults([...strict, ...loose]);
    }

    _collectImplementations(resolved, types, loose) {
        const results = [];
        for (const [typeKey, typeInfo] of types) {
            if (typeInfo.interfaceAlias || typeInfo.externalSource) continue;
            const methodSets = this._resolveTypeMethodSetsCached(typeKey, types);
            const valueImplements = satisfies(resolved.methods, methodSets.value, {
                unresolved: resolved.unresolved,
                loose,
            });
            const pointerImplements =
                valueImplements ||
                satisfies(resolved.methods, methodSets.pointer, {
                    unresolved: resolved.unresolved,
                    loose,
                });
            if (pointerImplements) {
                // One package-qualified type can contribute declarations and
                // methods from multiple files. Preserve its recorded locations;
                // dedupeResults removes repeated location identities after the
                // strict and loose passes are merged.
                const allLocations = this._typesByLocation.get(typeKey) || [];
                const declarations = allLocations.filter((location) => location.declared !== false);
                const locations = declarations.length > 0 ? declarations : allLocations;
                for (const decl of locations) {
                    results.push({
                        name: valueImplements ? typeInfo.name : `*${typeInfo.name}`,
                        file: decl.file,
                        line: decl.line,
                    });
                }
            }
        }
        return results;
    }

    /**
     * Find concrete implementations of a specific interface method, returning
     * the exact method definition location.
     * @param {string} interfaceName
     * @param {string} methodName
     * @param {string} [interfaceFile] source file that identifies the package
     * @returns {{name:string, file:string, line:number, signature:string}[]}
     */
    findMethodImplementations(interfaceName, methodName, interfaceFile) {
        const { interfaces, types } = this._merged();
        const interfaceKey = this._findInterfaceKey(interfaceName, interfaceFile);
        if (!interfaceKey) return [];
        const resolved = this._resolveInterfaceMethodsCached(interfaceKey, interfaces);
        const wantSig = resolved.methods.get(methodName);

        // Run both strict and loose passes and merge (deduped). A cross-package
        // implementation qualifies the interface's types while the interface
        // uses its bare package-local names, so it only matches under the loose
        // pass; skipping loose whenever strict found anything dropped those
        // implementations. Package-aware loose matching (looseSignatureEqual)
        // keeps this from reintroducing cross-package false positives.
        const strict = this._collectMethodImplementations(resolved, wantSig, methodName, types, false);
        const loose = this._collectMethodImplementations(resolved, wantSig, methodName, types, true);
        return dedupeResults([...strict, ...loose]);
    }

    _collectMethodImplementations(resolved, wantSig, methodName, types, loose) {
        const results = [];
        const sigMatches = (a, b) => {
            if (a === b) return true;
            // Loose matching still requires identical shape and rejects two
            // different packages' same-named types (see looseSignatureEqual).
            return loose && looseSignatureEqual(a, b);
        };
        for (const [typeKey, typeInfo] of types) {
            if (typeInfo.interfaceAlias || typeInfo.externalSource) continue;
            const methodSets = this._resolveTypeMethodSetsCached(typeKey, types);
            const implementsWith = (methods) => {
                const sig = methods.get(methodName);
                if (sig === undefined) return false;
                if (wantSig !== undefined && !sigMatches(sig, wantSig)) return false;
                return satisfies(resolved.methods, methods, {
                    unresolved: resolved.unresolved,
                    allowUnresolved: true,
                    loose,
                });
            };
            const valueImplements = implementsWith(methodSets.value);
            const pointerImplements = valueImplements || implementsWith(methodSets.pointer);
            if (!pointerImplements) continue;
            const sig = (valueImplements ? methodSets.value : methodSets.pointer).get(methodName);

            // Locations are already package-scoped by typeKey. Emit the direct
            // declaration(s) for this method and dedupe the strict/loose passes.
            for (const loc of this._findMethodLocations(typeKey, methodName)) {
                results.push({
                    name: valueImplements ? typeInfo.name : `*${typeInfo.name}`,
                    ...loc,
                    signature: sig,
                });
            }
        }
        return results;
    }

    /**
     * Find all interfaces that declare a method matching the given receiver
     * type's method (signature-aware).
     *
     * If nothing is found in the locally indexed roots and dependency search is
     * enabled, this additionally performs an on-demand ripgrep of the Go module
     * cache: the interface may be declared in a dependency (outside the
     * workspace) while implemented in the project. Only files whose interface
     * actually declares a matching method are parsed and returned, so the huge
     * module cache is never fully indexed.
     *
     * @param {string} receiverType
     * @param {string} methodName
     * @param {{localOnly?:boolean,receiverFile?:string}} [opts] when `localOnly` is true, skip the
     *   on-demand module-cache grep entirely and only consider interfaces
     *   already indexed in the workspace. This is used by the conditional
     *   CodeLens (which must be cheap enough to run on every method of every
     *   opened file); the full dependency search is reserved for the explicit
     *   "goto interface" command a user actually clicks.
     * @returns {Promise<{name:string, file:string, line:number, external?:boolean}[]>}
     */
    async findInterfaces(receiverType, methodName, opts) {
        const localOnly = !!(opts && opts.localOnly);
        const { results, consider, typeMethods, mySig } = this._collectLocalInterfaces(
            receiverType,
            methodName,
            { receiverFile: opts && opts.receiverFile }
        );

        // On-demand dependency (module cache) search when the local index has no
        // match. Gated by config; skipped entirely if disabled, no cache, or the
        // caller asked for a local-only (cheap) lookup.
        const cfg = this.getConfig();
        if (!localOnly && results.length === 0 && cfg.searchDependencies !== false) {
            const cacheRoot = resolveGoModCache(cfg.goModCache);
            if (cacheRoot) {
                await this._searchDependencyInterfaces(cacheRoot, receiverType, methodName, mySig, typeMethods, consider);
            }
        }

        return results;
    }

    /**
     * Synchronous local (workspace-indexed) interface matching for
     * `receiverType.methodName`. Returns the accumulated `results` plus the
     * `consider` closure, `typeMethods`, and `mySig` so `findInterfaces` can
     * optionally extend the same result set with a dependency-cache search.
     * Contains no I/O, so it is safe to call synchronously and frequently.
     * @param {string} receiverType
     * @param {string} methodName
     * @param {{stopAfterFirst?:boolean,receiverFile?:string}} [opts]
     */
    _collectLocalInterfaces(receiverType, methodName, opts) {
        const stopAfterFirst = !!(opts && opts.stopAfterFirst);
        const { interfaces, types } = this._merged();
        const typeKey = this._findTypeKey(receiverType, opts && opts.receiverFile);
        const typeMethods = typeKey ? this._resolveTypeMethodsCached(typeKey, types) : new Map();
        const mySig = typeMethods.get(methodName);

        const results = [];
        const seenInterfaces = new Set();

        const consider = (interfaceKey, resolved, decl, external) => {
            const sig = resolved.methods.get(methodName);
            if (sig === undefined) return false;

            // An interface names types by its OWN package-local names (bare
            // `FlowContext`), while an implementation in a different package
            // qualifies them (`processengine.FlowContext`). This happens both
            // for dependency (external) interfaces AND for interfaces living in
            // another package of the same workspace. So we always try an exact
            // (strict) match first and, failing that, fall back to a
            // package-aware loose match. Because looseSignatureEqual is
            // qualifier-shape aware (it rejects two different packages'
            // same-named types), this does not reintroduce cross-package false
            // positives — it only recovers the genuine bare-vs-qualified case.
            let sigEqual = false;
            let matchedLoose = false;
            if (mySig !== undefined) {
                if (sig === mySig) {
                    sigEqual = true;
                } else if (looseSignatureEqual(sig, mySig)) {
                    sigEqual = true;
                    matchedLoose = true;
                }
                if (!sigEqual) return false;
            }
            // Whole-interface satisfaction check. Use loose matching whenever the
            // anchoring method matched loosely (or the interface is external), so
            // the other methods' cross-package qualifiers do not veto a genuine
            // implementation.
            if (
                typeMethods.size > 0 &&
                !satisfies(resolved.methods, typeMethods, {
                    unresolved: resolved.unresolved,
                    allowUnresolved: true,
                    loose: external || matchedLoose,
                })
            ) {
                if (mySig === undefined || !sigEqual) return false;
            }
            if (!decl) return false;
            const key = `${interfaceKey}:${decl.file}`;
            if (seenInterfaces.has(key)) return false;
            seenInterfaces.add(key);
            results.push({
                name: decl.name || interfaceKey,
                file: decl.file,
                line: decl.line,
                external: !!external,
            });
            return true;
        };

        const candidates = this._interfacesByMethod.get(methodName) || [];
        for (const interfaceKey of candidates) {
            const declaration = this._interfaceDecls.get(interfaceKey);
            const matched = consider(
                interfaceKey,
                this._resolveInterfaceMethodsCached(interfaceKey, interfaces),
                declaration,
                !!(declaration && declaration.externalSource)
            );
            if (matched && stopAfterFirst) break;
        }

        return { results, consider, typeMethods, mySig };
    }

    /**
     * Grep the module cache for candidate interface files declaring `methodName`,
     * parse only those files, and feed matching interfaces to `consider`.
     *
     * Search is restricted to the module versions locked by the project's
     * go.mod (resolved to their exact cache directories), so other cached
     * versions of the same module are never returned. If no go.mod / locked
     * directories can be resolved, it falls back to searching the whole cache.
     */
    async _searchDependencyInterfaces(cacheRoot, receiverType, methodName, mySig, typeMethods, consider) {
        const lockedDirs = this._resolveLockedDirs(cacheRoot);

        let candidates;
        try {
            candidates = await grepInterfaceFilesForMethod(cacheRoot, methodName, undefined, lockedDirs);
        } catch (err) {
            this.log(`Dependency search failed: ${err.message}`);
            return;
        }
        this.log(
            `Dependency search: ${candidates.length} candidate file(s)` +
                (lockedDirs.length > 0
                    ? ` in ${lockedDirs.length} locked module dir(s)`
                    : ` across ${cacheRoot} (no go.mod lock resolved)`)
        );

        for (const file of candidates) {
            let parsed;
            try {
                if (!shouldIncludeGoFile(file, '', this._buildContext)) continue;
                const source = fs.readFileSync(file, 'utf8');
                if (!shouldIncludeGoFile(file, source, this._buildContext)) continue;
                parsed = this.files.get(file) || parseFile(source);
            } catch (_) {
                continue;
            }
            // Build a local interface map for embed resolution within this file.
            for (const [ifaceName, info] of parsed.interfaces) {
                const resolved = resolveInterfaceMethods(ifaceName, parsed.interfaces);
                if (!resolved.methods.has(methodName)) continue;
                consider(ifaceName, resolved, { file, line: info.line }, true);
            }
        }
    }

    /**
     * Resolve the exact module-cache directories locked by the go.mod(s) of the
     * indexed project roots. De-duplicated. Returns [] if none can be resolved
     * (caller then falls back to searching the whole cache).
     * @param {string} cacheRoot
     * @returns {string[]}
     */
    _resolveLockedDirs(cacheRoot) {
        const dirs = new Set();
        for (const root of this._builds.keys()) {
            let resolved;
            try {
                resolved = resolveLockedModuleDirs(root, cacheRoot);
            } catch (_) {
                continue;
            }
            for (const d of resolved.dirs) dirs.add(d);
        }
        return [...dirs];
    }

    _findMethodLocation(typeKey, methodName) {
        const all = this._findMethodLocations(typeKey, methodName);
        return all.length > 0 ? all[0] : null;
    }

    /**
     * All declaration locations of `methodName` on one package-qualified type.
     * @param {string} typeKey
     * @param {string} methodName
     * @returns {{file:string, line:number}[]}
     */
    _findMethodLocations(typeKey, methodName) {
        if (!this._methodLocationCache) this._methodLocationCache = new Map();
        const cacheKey = `${typeKey}\0${methodName}`;
        const cached = this._methodLocationCache.get(cacheKey);
        if (cached) return cached;
        const found = this._findMethodLocationsRecursive(typeKey, methodName, new Set());
        this._methodLocationCache.set(cacheKey, found);
        return found;
    }

    _findMethodLocationsRecursive(typeKey, methodName, seen) {
        if (seen.has(typeKey)) return [];
        seen.add(typeKey);
        const locations = this._typesByLocation.get(typeKey) || [];
        const out = [];
        for (const loc of locations) {
            if (loc.methods.has(methodName)) {
                const recorded = loc.methodLines && loc.methodLines.get(methodName);
                out.push({ file: loc.file, line: typeof recorded === 'number' ? recorded : loc.line });
            }
        }
        if (out.length > 0) return out;

        const typeInfo = this._mergedTypes && this._mergedTypes.get(typeKey);
        if (!typeInfo) return out;
        for (const embed of typeInfo.embeds) {
            const canPromoteInterface = typeInfo.struct || typeInfo.interfaceAlias;
            const imported = importedReferenceIdentity(embed);
            let embeddedKey = null;
            let embeddedInterfaceKey = null;
            if (imported && this._typeKeyByImportIdentity) {
                embeddedKey = this._typeKeyByImportIdentity.get(
                    `${imported.importPath}\0${imported.name}`
                );
                if (!embeddedKey && canPromoteInterface && this._interfaceKeyByImportIdentity) {
                    embeddedInterfaceKey = this._interfaceKeyByImportIdentity.get(
                        `${imported.importPath}\0${imported.name}`
                    );
                }
            } else if (!embed.includes('.')) {
                const localKey = symbolKeyFor(typeInfo.packageKey, embed);
                if (this._mergedTypes.has(localKey)) embeddedKey = localKey;
                else if (
                    canPromoteInterface &&
                    this._mergedInterfaces &&
                    this._mergedInterfaces.has(localKey)
                ) {
                    embeddedInterfaceKey = localKey;
                }
            }
            if (embeddedKey) {
                const promoted = this._findMethodLocationsRecursive(
                    embeddedKey,
                    methodName,
                    new Set(seen)
                );
                // Follow the resolved promotion order so navigation points at the
                // declaration that contributed the method.
                if (promoted.length > 0) return promoted;
            } else if (embeddedInterfaceKey) {
                const info = this._mergedInterfaces.get(embeddedInterfaceKey);
                if (!info || info.constraint || info.generic) continue;
                const resolved = this._resolveInterfaceMethodsCached(
                    embeddedInterfaceKey,
                    this._mergedInterfaces
                );
                if (!resolved.methods.has(methodName)) continue;
                const declaration = this._interfaceDecls.get(embeddedInterfaceKey);
                if (!declaration) continue;
                const recorded = declaration.methodLines && declaration.methodLines.get(methodName);
                return [{
                    file: declaration.file,
                    line: typeof recorded === 'number' ? recorded : declaration.line,
                }];
            } else if (canPromoteInterface && BUILTIN_INTERFACES.has(embed)) {
                const builtinMethods = BUILTIN_INTERFACES.get(embed);
                if (!builtinMethods.has(methodName)) continue;
                const declarations = (this._typesByLocation.get(typeKey) || []).filter(
                    (location) => location.declared !== false
                );
                if (declarations.length > 0) {
                    return [{ file: declarations[0].file, line: declarations[0].line }];
                }
            }
        }
        return out;
    }

    clear() {
        this.files.clear();
        this.overlays.clear();
        this.overlayTexts.clear();
        this._candidateFilesByMethod.clear();
        this._candidateMethodsByFile.clear();
        this._packageFiles.clear();
        this._packageKeyByFile.clear();
        this._packageKeysByDirectory.clear();
        this._embeddedFiles.clear();
        this._packageKeyByImportPath.clear();
        this._externalImportDirectoryCache.clear();
        this._externalPackageCache.clear();
        if (this.astPool) this.astPool.clear();
        this._invalidateMerged();
        this._builds.clear();
        this._builtRoots.clear();
    }

    dispose() {
        if (this._invalidateTimer) {
            clearTimeout(this._invalidateTimer);
            this._invalidateTimer = null;
        }
        if (this._watcher) {
            this._watcher.dispose();
            this._watcher = null;
        }
        if (this.astPool) {
            this.astPool.dispose();
            this.astPool = null;
        }
        this.files.clear();
        this.overlays.clear();
        this.overlayTexts.clear();
        this._candidateFilesByMethod.clear();
        this._candidateMethodsByFile.clear();
        this._packageFiles.clear();
        this._packageKeyByFile.clear();
        this._packageKeysByDirectory.clear();
        this._embeddedFiles.clear();
        this._packageKeyByImportPath.clear();
        this._externalImportDirectoryCache.clear();
        this._externalPackageCache.clear();
        this._builds.clear();
        this._builtRoots.clear();
    }
}

// Window over which bursts of watcher events are coalesced into a single merged
// view invalidation.
WorkspaceIndex.INVALIDATE_DEBOUNCE_MS = 150;
// Number of file reads issued together during initial indexing. Bounded
// concurrency improves throughput without loading the whole workspace into RAM.
WorkspaceIndex.INDEX_READ_CONCURRENCY = 16;
// Maximum synchronous parse time before yielding back to the extension host.
WorkspaceIndex.INDEX_TIME_SLICE_MS = 8;

/**
 * De-duplicate result records by their location identity (name + file + line),
 * preserving first-seen order. Used to merge the strict and loose matching
 * passes without reporting the same implementation twice.
 * @template {{name:string, file:string, line:number}} T
 * @param {T[]} results
 * @returns {T[]}
 */
function dedupeResults(results) {
    const seen = new Set();
    const out = [];
    for (const r of results) {
        const key = `${r.name}\u0000${r.file}\u0000${r.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
    }
    return out;
}

module.exports = { WorkspaceIndex };
