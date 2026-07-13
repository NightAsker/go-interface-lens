'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const {
    parseFile,
    resolveInterfaceMethods,
    resolveTypeMethods,
    satisfies,
    looseSignatureEqual,
} = require('./parser');
const { listGoFiles, resolveGoModCache, grepInterfaceFilesForMethod } = require('./search');
const { resolveLockedModuleDirs } = require('./gomod');

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
    constructor(getConfig, log) {
        this.getConfig = getConfig;
        this.log = log || (() => {});

        // Per-file parse results: absPath -> { packageName, interfaces, types }
        this.files = new Map();
        // Merged views, rebuilt on demand from per-file results.
        this._mergedInterfaces = null; // package+name key -> interface summary
        this._mergedTypes = null; // package+name key -> concrete type summary
        this._resolvedTypeCache = null; // package+name key -> resolved method Map
        this._resolvedInterfaceCache = null; // package+name key -> resolved interface method set
        this._interfacesByMethod = null; // method name -> package-qualified interface keys

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
        const goFiles = await listGoFiles(root, cfg.excludedFolders);
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

    _indexText(absPath, text) {
        try {
            this.files.set(absPath, parseFile(text));
        } catch (err) {
            this.log(`Failed to parse ${absPath}: ${err.message}`);
        }
    }

    _indexFile(absPath) {
        try {
            const text = fs.readFileSync(absPath, 'utf8');
            this._indexText(absPath, text);
        } catch (err) {
            this.log(`Failed to index ${absPath}: ${err.message}`);
        }
    }

    _removeFile(absPath) {
        this.files.delete(absPath);
    }

    _invalidateMerged() {
        this._mergedInterfaces = null;
        this._mergedTypes = null;
        // Resolved-method sets are derived from the merged view; drop them too.
        this._resolvedTypeCache = null;
        this._resolvedInterfaceCache = null;
        this._interfacesByMethod = null;
        // "receiver\u0000method -> hasLocalInterface" memo is also view-derived.
        this._hasInterfaceCache = null;
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
    _resolveInterfaceMethodsCached(interfaceName, interfaces) {
        if (!this._resolvedInterfaceCache) this._resolvedInterfaceCache = new Map();
        const hit = this._resolvedInterfaceCache.get(interfaceName);
        if (hit) return hit;
        const resolved = resolveInterfaceMethods(interfaceName, interfaces, undefined, this._resolvedInterfaceCache);
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
        const resolved = resolveTypeMethods(typeKey, types);
        this._resolvedTypeCache.set(typeKey, resolved);
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

        for (const [file, parsed] of this.files) {
            const packageKey = packageKeyFor(file, parsed.packageName);
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
                    });
                }
                if (!interfacesFlat.has(symbolKey)) {
                    interfacesFlat.set(symbolKey, { name, packageKey, methods: new Map(), embeds: [] });
                }
                const flat = interfacesFlat.get(symbolKey);
                for (const [m, s] of info.methods) flat.methods.set(m, s);
                flat.embeds.push(...info.embeds);
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
                });

                if (!typesFlat.has(symbolKey)) {
                    typesFlat.set(symbolKey, { name, packageKey, methods: new Map(), embeds: [] });
                }
                const flat = typesFlat.get(symbolKey);
                for (const [m, s] of info.methods) flat.methods.set(m, s);
                flat.embeds.push(...info.embeds);
            }
        }

        this._mergedInterfaces = interfacesFlat;
        this._mergedTypes = typesFlat;
        this._typesByLocation = typesByLocation;
        this._interfaceDecls = interfaces;
        this._interfaceKeyByLocation = interfaceKeyByLocation;
        this._typeKeyByLocation = typeKeyByLocation;

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
            const typeMethods = this._resolveTypeMethodsCached(typeKey, types);
            if (satisfies(resolved.methods, typeMethods, { unresolved: resolved.unresolved, loose })) {
                // One package-qualified type can contribute declarations and
                // methods from multiple files. Preserve its recorded locations;
                // dedupeResults removes repeated location identities after the
                // strict and loose passes are merged.
                const locations = this._typesByLocation.get(typeKey) || [];
                for (const decl of locations) {
                    results.push({ name: typeInfo.name, file: decl.file, line: decl.line });
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
            const typeMethods = this._resolveTypeMethodsCached(typeKey, types);
            const sig = typeMethods.get(methodName);
            if (sig === undefined) continue;
            // If we know the interface's signature, require a (strict or loose) match.
            if (wantSig !== undefined && !sigMatches(sig, wantSig)) continue;
            // Only include types that satisfy the whole interface, to reduce
            // noise. The specific method signature above already anchors this
            // result, so imported embedded interfaces may be tolerated here.
            if (
                !satisfies(resolved.methods, typeMethods, {
                    unresolved: resolved.unresolved,
                    allowUnresolved: true,
                    loose,
                })
            ) {
                continue;
            }

            // Locations are already package-scoped by typeKey. Emit the direct
            // declaration(s) for this method and dedupe the strict/loose passes.
            for (const loc of this._findMethodLocations(typeKey, methodName)) {
                results.push({ name: typeInfo.name, ...loc, signature: sig });
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
            const matched = consider(
                interfaceKey,
                this._resolveInterfaceMethodsCached(interfaceKey, interfaces),
                this._interfaceDecls.get(interfaceKey),
                false
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
                parsed = this.files.get(file) || parseFile(fs.readFileSync(file, 'utf8'));
            } catch (_) {
                continue;
            }
            // Build a local interface map for embed resolution within this file.
            for (const [ifaceName, info] of parsed.interfaces) {
                if (!info.methods.has(methodName)) continue;
                const resolved = resolveInterfaceMethods(ifaceName, parsed.interfaces);
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
        const locations = this._typesByLocation.get(typeKey) || [];
        const out = [];
        for (const loc of locations) {
            if (loc.methods.has(methodName)) {
                const recorded = loc.methodLines && loc.methodLines.get(methodName);
                out.push({ file: loc.file, line: typeof recorded === 'number' ? recorded : loc.line });
            }
        }
        return out;
    }

    clear() {
        this.files.clear();
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
        this.clear();
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
