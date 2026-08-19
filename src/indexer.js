'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const {
    resolveInterfaceMethods,
    satisfies,
    looseSignatureEqual,
    inferTypeParameterBindings,
    substituteTypeParameters,
    splitNormalizedSignature,
    splitTopLevel,
    BUILTIN_INTERFACES,
} = require('./signatures');
const {
    resolveGoModCache,
    grepInterfaceFilesForMethod,
    grepImplementationFilesForMethod,
    grepGoFilesForTypeNames,
} = require('./search');
const { findGoMod, resolveLockedModuleDirs, resolveModuleImportDirectory } = require('./gomod');
const { currentBuildContext, shouldIncludeGoFile } = require('./build');
const { maskGoFunctionBodies } = require('./go-source');
const {
    normalizeWildcardPatterns,
    compileWildcardPattern,
    createFolderMatcher,
} = require('./path-filter');
const {
    AstWorkerPool,
    DEFAULT_AST_CONCURRENCY,
} = require('./ast-cache');

const WORKSPACE_PACKAGE_LOAD_CONCURRENCY = 8;
const PACKAGE_READ_CONCURRENCY = 16;

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

const PREDECLARED_CONCRETE_TYPES = new Set([
    'bool',
    'byte',
    'complex64',
    'complex128',
    'float32',
    'float64',
    'int',
    'int8',
    'int16',
    'int32',
    'int64',
    'rune',
    'string',
    'uint',
    'uint8',
    'uint16',
    'uint32',
    'uint64',
    'uintptr',
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

function scanPackageName(text) {
    const match = text.match(/^\s*package\s+([A-Z_a-z]\w*)/m);
    return match ? match[1] : null;
}

function scanTouchedDeclaration(text) {
    const declarationText = maskGoFunctionBodies(text).text;
    return {
        declarationText,
        metadata: {
            syntax: 'touched-file-metadata-v1',
            packageName: scanPackageName(declarationText),
            interfaces: new Map(),
            types: new Map(),
        },
    };
}

async function mapWithConcurrency(values, concurrency, iteratee) {
    const items = [...values];
    if (items.length === 0) return [];
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from(
        { length: Math.min(items.length, Math.max(1, concurrency)) },
        async () => {
            while (next < items.length) {
                const index = next++;
                results[index] = await iteratee(items[index], index);
            }
        }
    );
    await Promise.all(workers);
    return results;
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

function isExportedIdentifier(name) {
    return /^\p{Lu}/u.test(name || '');
}

function methodKeyFor(name, packageKey) {
    return isExportedIdentifier(name) || !packageKey ? name : `\0${packageKey}\0${name}`;
}

function bareMethodName(methodKey) {
    const separator = (methodKey || '').lastIndexOf('\0');
    return separator === -1 ? methodKey : methodKey.slice(separator + 1);
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

function normalizedNamedTypeReference(value) {
    let source = (value || '').trim();
    let pointer = false;
    while (source.startsWith('*')) {
        pointer = true;
        source = source.slice(1);
    }
    const match = source.match(
        /^(@\{([^}]+)\}\.([A-Z_a-z]\w*)|([A-Z_a-z]\w*))(?:\[(.*)\])?$/
    );
    if (!match) return null;
    return {
        name: match[3] || match[4],
        importPath: match[2] || null,
        pointer,
        arguments: match[5]
            ? splitTopLevel(match[5], ',').map((argument) => argument.trim())
            : [],
    };
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

function instantiateMethods(methods, typeParameters, typeArguments) {
    const parameters = typeParameters || [];
    const argumentsList = typeArguments || [];
    if (parameters.length === 0) return new Map(methods);
    if (parameters.length !== argumentsList.length) return null;
    const bindings = new Map(
        parameters.map((parameter, index) => [parameter.marker, argumentsList[index]])
    );
    return new Map(
        [...methods].map(([name, signature]) => [
            name,
            substituteTypeParameters(signature, bindings),
        ])
    );
}

function instantiateSelectors(selectors, typeParameters, typeArguments) {
    const parameters = typeParameters || [];
    const argumentsList = typeArguments || [];
    if (parameters.length === 0) return new Map(selectors);
    if (parameters.length !== argumentsList.length) return null;
    const bindings = new Map(
        parameters.map((parameter, index) => [parameter.marker, argumentsList[index]])
    );
    return new Map(
        [...selectors].map(([name, selector]) => [
            name,
            selector.signature
                ? {
                      ...selector,
                      signature: substituteTypeParameters(selector.signature, bindings),
                  }
                : { ...selector },
        ])
    );
}

/**
 * Query-driven workspace declaration resolver.
 *
 * Startup registers roots only. Each navigation query uses ripgrep to locate
 * declaration candidates, loads complete matching packages, and asks
 * Tree-sitter for the exact method-set view. Watcher events invalidate query
 * and package caches without requiring a full-workspace source index.
 */
class WorkspaceIndex {
    /**
     * @param {() => {excludedFolders:string[], excludedFilePatterns:string[], excludedTypePatterns:string[], excludedPackagePatterns?:string[]}} getConfig
     * @param {(msg:string)=>void} log
     */
    constructor(getConfig, log, options) {
        this.getConfig = getConfig;
        this.log = log || (() => {});
        this.options = options || {};

        // Parsed declarations and watcher/overlay metadata for files touched by
        // queries or edits. Root registration leaves this map empty.
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
        this._watcher = null;
        // Debounce timer coalescing bursts of watcher events into one invalidation.
        this._invalidateTimer = null;
        // Listeners notified after the merged view is invalidated (e.g. so
        // CodeLens providers can recompute). Plain callbacks; no vscode types.
        this._changeListeners = new Set();

        // On-demand package loads and unsaved overlays retain broad method-name
        // metadata. Exact declarations are parsed lazily for query candidates.
        this._candidateFilesByMethod = new Map();
        this._candidateMethodsByFile = new Map();
        this._packageFiles = new Map();
        this._packageKeyByFile = new Map();
        this._packageKeysByDirectory = new Map();
        this._astQueryCache = new Map();
        this._astInflight = new Map();
        this._astGeneration = 1;
        this._pendingInvalidationFiles = new Set();
        this._disposed = false;
        this._importPathByDirectory = new Map();
        this._folderPatternCacheKey = null;
        this._folderMatcher = () => false;
        this._packagePatternCacheKey = null;
        this._packagePatternMatchers = [];
        this._packageKeyByImportPath = new Map();
        this._externalImportDirectoryCache = new Map();
        this._externalPackageCache = new Map();
        this._workspacePackageCache = new Map();
        this._workspaceCandidateCache = new Map();
        this._dependencyCandidateCache = new Map();
        this._dependencyImplementationCandidateCache = new Map();
        this._dependencyTypeReferenceCandidateCache = new Map();
        this._goRootPromise = null;
        this._storageDir = this.options.cacheDir || '';
        this._clearObsoleteCacheFiles();
        const cfg = this.getConfig();
        this.astPool = this.options.disableAst
            ? null
            : new AstWorkerPool({
                  concurrency: cfg.astConcurrency ?? DEFAULT_AST_CONCURRENCY,
                  cacheDir: this.options.cacheDir || '',
                  log: this.log,
              });
    }

    _clearObsoleteCacheFiles() {
        if (!this._storageDir) return;
        try {
            for (const name of fs.readdirSync(this._storageDir)) {
                if (
                    !name.startsWith('interface-relations-') &&
                    !name.startsWith('dependency-candidates-') &&
                    !name.startsWith('candidate-index-')
                ) {
                    continue;
                }
                fs.unlinkSync(path.join(this._storageDir, name));
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                this.log(`Obsolete cache cleanup failed: ${error.message}`);
            }
        }
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
            // A freshly-completed build makes new results available; notify
            // listeners so conditional lenses that returned nothing while the
            // build was pending get re-evaluated.
            this._emitChange();
        });
        this._builds.set(root, p);
        return p;
    }

    async _build(root) {
        this.log(`Registered on-demand workspace root ${path.normalize(root)}`);
        this._installWatcher();
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
    }

    _recordCandidateFile(absPath, text, parsed, candidateNames) {
        const normalized = path.normalize(absPath);
        this._removeCandidateFile(normalized);
        const names = candidateNames === undefined ? scanCandidateMethodNames(text) : candidateNames;
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
    }

    _indexText(absPath, text, invalidateAst) {
        try {
            if (this._isExcluded(absPath) || !shouldIncludeGoFile(absPath, text, this._buildContext)) {
                this.files.delete(absPath);
                this._removeCandidateFile(absPath);
                if (invalidateAst && this.astPool) this.astPool.invalidate(absPath);
                return;
            }
            const touched = scanTouchedDeclaration(text);
            const parsed = touched.metadata;
            this.files.set(absPath, parsed);
            this._recordCandidateFile(absPath, touched.declarationText, parsed);
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
            this._invalidateMerged([absPath]);
            if (notify !== false) this._emitChange();
            return;
        }
        const touched = scanTouchedDeclaration(text);
        this.overlays.set(absPath, touched.metadata);
        this.overlayTexts.set(absPath, text);
        this._recordCandidateFile(
            absPath,
            touched.declarationText,
            this.overlays.get(absPath)
        );
        this._invalidateMerged([absPath]);
        if (notify !== false) this._emitChange();
    }

    clearOverlay(absPath) {
        if (!this.overlays.delete(absPath)) return;
        this.overlayTexts.delete(absPath);
        if (this.astPool) this.astPool.clearOverlay(absPath);
        try {
            const text = fs.readFileSync(absPath, 'utf8');
            const touched = scanTouchedDeclaration(text);
            const parsed = this.files.get(absPath) || touched.metadata;
            this._recordCandidateFile(absPath, touched.declarationText, parsed);
        } catch (_) {
            this._removeCandidateFile(absPath);
        }
        this._invalidateMerged([absPath]);
        this._emitChange();
    }

    updateFileText(absPath, text) {
        this.overlays.delete(absPath);
        this.overlayTexts.delete(absPath);
        this._indexText(absPath, text, true);
        this._invalidateMerged([absPath]);
        this._emitChange();
    }

    _invalidateMerged(changedFiles) {
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
        this._workspaceCandidateCache.clear();
        if (Array.isArray(changedFiles) && changedFiles.length > 0) {
            const directories = new Set(changedFiles.map((file) => path.dirname(path.normalize(file))));
            for (const key of [...this._workspacePackageCache.keys()]) {
                const separator = key.indexOf('\0');
                const directory = separator === -1 ? key : key.slice(0, separator);
                if (directories.has(directory)) this._workspacePackageCache.delete(key);
            }
        } else {
            this._workspacePackageCache.clear();
        }
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
        let constraint = !!info.constraint;
        for (const embed of info.embeds || []) {
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
            constraint = constraint || !!nested.constraint;
            let nestedMethods = nested.methods;
            if (info.genericEmbeds && info.genericEmbeds.has(embed)) {
                nestedMethods = instantiateMethods(
                    nested.methods,
                    nested.typeParameters,
                    info.embedArguments && info.embedArguments.get(embed)
                );
                if (!nestedMethods) {
                    unresolved.push(embed);
                    continue;
                }
            }
            for (const [name, signature] of nestedMethods) {
                if (!methods.has(name)) methods.set(name, signature);
            }
            unresolved.push(...nested.unresolved);
        }
        const resolved = {
            methods,
            unresolved,
            typeParameters: info.typeParameters || [],
            packageKey: info.packageKey,
            constraint,
        };
        this._resolvedInterfaceCache.set(interfaceName, resolved);
        return resolved;
    }

    _constraintMethodSet(parameter, ownerPackageKey, interfaces) {
        if (parameter.constraintMethods && parameter.constraintMethods.size > 0) {
            return { methods: parameter.constraintMethods, unresolved: [] };
        }
        const reference = normalizedNamedTypeReference(parameter.constraint);
        if (!reference) return null;
        let interfaceKey = null;
        if (reference.importPath && this._interfaceKeyByImportIdentity) {
            interfaceKey = this._interfaceKeyByImportIdentity.get(
                `${reference.importPath}\0${reference.name}`
            );
        } else if (!reference.importPath && ownerPackageKey) {
            interfaceKey = symbolKeyFor(ownerPackageKey, reference.name);
        }
        if (!interfaceKey || !interfaces.has(interfaceKey)) return null;
        const resolved = this._resolveInterfaceMethodsCached(interfaceKey, interfaces);
        if (reference.arguments.length === 0) return resolved;
        const methods = instantiateMethods(
            resolved.methods,
            resolved.typeParameters,
            reference.arguments
        );
        return methods ? { ...resolved, methods, typeParameters: [] } : null;
    }

    _interfaceTypeSetRequirements(interfaceKey, interfaces, seen) {
        const visiting = seen || new Set();
        if (!interfaceKey || visiting.has(interfaceKey)) {
            return { groups: [], comparable: false, unresolved: true };
        }
        const info = interfaces.get(interfaceKey);
        if (!info) return { groups: [], comparable: false, unresolved: true };
        visiting.add(interfaceKey);
        const result = { groups: [], comparable: false, unresolved: false };
        for (const element of info.typeElements || []) {
            const nested = this._typeElementRequirements(
                element,
                info.packageKey,
                interfaces,
                new Set(visiting)
            );
            result.groups.push(...nested.groups);
            result.comparable = result.comparable || nested.comparable;
            result.unresolved = result.unresolved || nested.unresolved;
        }
        return result;
    }

    _typeElementRequirements(expression, ownerPackageKey, interfaces, seen) {
        const source = (expression || '').trim();
        if (!source || source === 'any' || source === 'interface{}') {
            return { groups: [], comparable: false, unresolved: false };
        }
        if (source === 'comparable') {
            return { groups: [], comparable: true, unresolved: false };
        }
        const alternatives = splitTopLevel(source, '|').map((term) => term.trim());
        if (alternatives.length > 1 || source.startsWith('~')) {
            return {
                groups: [
                    alternatives.map((term) => ({ value: term, ownerPackageKey })),
                ],
                comparable: false,
                unresolved: false,
            };
        }
        const reference = normalizedNamedTypeReference(source);
        if (reference && !reference.pointer) {
            let interfaceKey = null;
            if (reference.importPath && this._interfaceKeyByImportIdentity) {
                interfaceKey = this._interfaceKeyByImportIdentity.get(
                    `${reference.importPath}\0${reference.name}`
                );
            } else if (!reference.importPath && ownerPackageKey) {
                const localKey = symbolKeyFor(ownerPackageKey, reference.name);
                if (interfaces.has(localKey)) interfaceKey = localKey;
            }
            if (interfaceKey) {
                let nested = this._interfaceTypeSetRequirements(
                    interfaceKey,
                    interfaces,
                    seen
                );
                if (reference.arguments.length > 0) {
                    const target = interfaces.get(interfaceKey);
                    const parameters = (target && target.typeParameters) || [];
                    if (parameters.length !== reference.arguments.length) {
                        return { groups: [], comparable: false, unresolved: true };
                    }
                    const bindings = new Map(
                        parameters.map((parameter, index) => [
                            parameter.marker,
                            reference.arguments[index],
                        ])
                    );
                    nested = {
                        ...nested,
                        groups: nested.groups.map((group) =>
                            group.map((term) => ({
                                ...term,
                                value: substituteTypeParameters(term.value, bindings),
                            }))
                        ),
                    };
                }
                return nested;
            }
        }
        return {
            groups: [[{ value: source, ownerPackageKey }]],
            comparable: false,
            unresolved: false,
        };
    }

    _typeParameterRequirements(parameter, ownerPackageKey, interfaces) {
        const elements = parameter.constraintTypeElements || [];
        if (elements.length > 0) {
            const result = { groups: [], comparable: false, unresolved: false };
            for (const element of elements) {
                const nested = this._typeElementRequirements(
                    element,
                    ownerPackageKey,
                    interfaces
                );
                result.groups.push(...nested.groups);
                result.comparable = result.comparable || nested.comparable;
                result.unresolved = result.unresolved || nested.unresolved;
            }
            return result;
        }
        return this._typeElementRequirements(
            parameter.constraint,
            ownerPackageKey,
            interfaces
        );
    }

    _typeKeyForReference(reference, ownerPackageKey, types) {
        if (reference.importPath && this._typeKeyByImportIdentity) {
            return this._typeKeyByImportIdentity.get(
                `${reference.importPath}\0${reference.name}`
            );
        }
        if (!reference.importPath && ownerPackageKey) {
            const localKey = symbolKeyFor(ownerPackageKey, reference.name);
            if (types.has(localKey)) return localKey;
        }
        return null;
    }

    _underlyingType(value, ownerPackageKey, types, seen) {
        const source = (value || '').trim();
        if (!source || /^\$\d+$/.test(source)) return null;
        const reference = normalizedNamedTypeReference(source);
        if (!reference || reference.pointer) return source;
        const typeKey = this._typeKeyForReference(reference, ownerPackageKey, types);
        if (!reference.importPath && PREDECLARED_CONCRETE_TYPES.has(reference.name)) {
            if (!typeKey) return PREDECLARED_TYPE_ALIASES.get(reference.name) || reference.name;
        }
        if (!typeKey) return source;
        const visiting = seen || new Set();
        if (visiting.has(typeKey)) return null;
        visiting.add(typeKey);
        const info = types.get(typeKey);
        let underlying = info && info.underlying;
        if (!underlying) return null;
        if (reference.arguments.length > 0) {
            const parameters = info.typeParameters || [];
            if (parameters.length !== reference.arguments.length) return null;
            underlying = substituteTypeParameters(
                underlying,
                new Map(
                    parameters.map((parameter, index) => [
                        parameter.marker,
                        reference.arguments[index],
                    ])
                )
            );
        }
        const nestedReference = normalizedNamedTypeReference(underlying);
        if (nestedReference && !nestedReference.pointer) {
            return this._underlyingType(
                underlying,
                info.packageKey,
                types,
                visiting
            );
        }
        return underlying;
    }

    _isComparableType(value, ownerPackageKey, types, seen) {
        const source = (value || '').trim();
        if (!source || /^\$\d+$/.test(source)) return null;
        const reference = normalizedNamedTypeReference(source);
        if (reference) {
            if (reference.pointer) return true;
            const typeKey = this._typeKeyForReference(reference, ownerPackageKey, types);
            if (!reference.importPath && PREDECLARED_CONCRETE_TYPES.has(reference.name)) {
                if (!typeKey) return true;
            }
            if (!reference.importPath && BUILTIN_INTERFACES.has(reference.name) && !typeKey) {
                return true;
            }
            if (typeKey) {
                const visiting = seen || new Set();
                if (visiting.has(typeKey)) return null;
                visiting.add(typeKey);
                const underlying = this._underlyingType(
                    source,
                    ownerPackageKey,
                    types
                );
                return underlying
                    ? this._isComparableType(
                          underlying,
                          types.get(typeKey).packageKey,
                          types,
                          visiting
                      )
                    : null;
            }
            return null;
        }
        if (
            source.startsWith('[]') ||
            source.startsWith('map[') ||
            source.startsWith('func(')
        ) {
            return false;
        }
        if (
            source.startsWith('*') ||
            source.startsWith('chan(') ||
            source.startsWith('<-chan(') ||
            source.startsWith('chan<-(') ||
            source.startsWith('interface{')
        ) {
            return true;
        }
        if (source.startsWith('[')) {
            const close = source.indexOf(']');
            if (close === -1 || close === 1) return false;
            return this._isComparableType(
                source.slice(close + 1),
                ownerPackageKey,
                types,
                seen
            );
        }
        if (source.startsWith('struct{') && source.endsWith('}')) {
            const fields = splitTopLevel(source.slice(7, -1), ';').filter(Boolean);
            for (const fieldValue of fields) {
                const colon = fieldValue.indexOf(':');
                let fieldType = colon === -1 ? fieldValue : fieldValue.slice(colon + 1);
                fieldType = fieldType.replace(/(?:`[^`]*`|"(?:\\.|[^"])*")$/, '');
                const comparable = this._isComparableType(
                    fieldType,
                    ownerPackageKey,
                    types,
                    seen
                );
                if (comparable !== true) return comparable;
            }
            return true;
        }
        return null;
    }

    _bindingSatisfiesTypeSet(binding, requirements, candidateType, types) {
        if (!binding || /^\$\d+$/.test(binding)) return true;
        const ownerPackageKey = candidateType && candidateType.packageKey;
        if (requirements.comparable) {
            const comparable = this._isComparableType(
                binding,
                ownerPackageKey,
                types
            );
            if (comparable === false) return false;
        }
        for (const group of requirements.groups) {
            let matched = false;
            let unresolved = false;
            for (const term of group) {
                const approximate = term.value.startsWith('~');
                const wanted = approximate ? term.value.slice(1) : term.value;
                if (approximate) {
                    const actualUnderlying = this._underlyingType(
                        binding,
                        ownerPackageKey,
                        types
                    );
                    const wantedUnderlying = this._underlyingType(
                        wanted,
                        term.ownerPackageKey,
                        types
                    );
                    if (!actualUnderlying || !wantedUnderlying) {
                        unresolved = true;
                    } else if (actualUnderlying === wantedUnderlying) {
                        matched = true;
                    }
                } else if (binding === wanted) {
                    matched = true;
                }
                if (matched) break;
            }
            if (!matched && !unresolved) return false;
        }
        return true;
    }

    _boundTypeMethodSet(binding, candidateType, types, interfaces) {
        if (!binding || /^\$\d+$/.test(binding)) return null;
        const reference = normalizedNamedTypeReference(binding);
        if (!reference) {
            if (!binding.startsWith('interface{')) return new Map();
            return null;
        }
        let typeKey = null;
        let interfaceKey = null;
        if (reference.importPath) {
            const identity = `${reference.importPath}\0${reference.name}`;
            typeKey = this._typeKeyByImportIdentity && this._typeKeyByImportIdentity.get(identity);
            interfaceKey =
                this._interfaceKeyByImportIdentity &&
                this._interfaceKeyByImportIdentity.get(identity);
        } else if (candidateType && candidateType.packageKey) {
            const localKey = symbolKeyFor(candidateType.packageKey, reference.name);
            if (types.has(localKey)) typeKey = localKey;
            if (interfaces.has(localKey)) interfaceKey = localKey;
        }
        if (!typeKey && !interfaceKey && !reference.importPath && BUILTIN_INTERFACES.has(reference.name)) {
            return reference.pointer
                ? new Map()
                : CANONICAL_BUILTIN_INTERFACES.get(reference.name);
        }
        if (!typeKey && !reference.importPath && PREDECLARED_CONCRETE_TYPES.has(reference.name)) {
            return new Map();
        }
        if (typeKey) {
            const methodSets = this._resolveTypeMethodSetsCached(typeKey, types);
            let methods = reference.pointer ? methodSets.pointer : methodSets.value;
            if (reference.arguments.length > 0) {
                methods = instantiateMethods(
                    methods,
                    types.get(typeKey).typeParameters,
                    reference.arguments
                );
            }
            return methods;
        }
        if (interfaceKey) {
            const resolved = this._resolveInterfaceMethodsCached(interfaceKey, interfaces);
            if (reference.arguments.length === 0) return resolved.methods;
            return instantiateMethods(
                resolved.methods,
                resolved.typeParameters,
                reference.arguments
            );
        }
        return null;
    }

    _genericBindingsSatisfyConstraints(
        bindings,
        resolved,
        candidateType,
        types,
        interfaces,
        loose
    ) {
        for (const parameter of resolved.typeParameters || []) {
            const required = this._constraintMethodSet(
                parameter,
                resolved.packageKey,
                interfaces
            );
            const binding = bindings.get(parameter.marker);
            if (required && required.methods.size > 0) {
                const actual = this._boundTypeMethodSet(
                    binding,
                    candidateType,
                    types,
                    interfaces
                );
                // Imported argument packages can be unavailable in an incomplete
                // workspace. Keep the result rather than introducing a false
                // negative; when the declaration is present, enforce the constraint.
                if (actual) {
                    const wanted = new Map(
                        [...required.methods].map(([name, signature]) => [
                            name,
                            substituteTypeParameters(signature, bindings),
                        ])
                    );
                    if (
                        !satisfies(wanted, actual, {
                            unresolved: required.unresolved,
                            allowUnresolved: true,
                            loose,
                        })
                    ) {
                        return false;
                    }
                }
            }

            const requirements = this._typeParameterRequirements(
                parameter,
                resolved.packageKey,
                interfaces
            );
            const instantiatedRequirements = {
                ...requirements,
                groups: requirements.groups.map((group) =>
                    group.map((term) => ({
                        ...term,
                        value: substituteTypeParameters(term.value, bindings),
                    }))
                ),
            };
            if (
                !this._bindingSatisfiesTypeSet(
                    binding,
                    instantiatedRequirements,
                    candidateType,
                    types
                )
            ) {
                return false;
            }
        }
        return true;
    }

    _interfaceSatisfiedBy(resolved, methods, candidateType, types, interfaces, options) {
        const settings = options || {};
        if (!resolved.typeParameters || resolved.typeParameters.length === 0) {
            return satisfies(resolved.methods, methods, settings);
        }
        if (
            resolved.unresolved.length > 0 &&
            !settings.allowUnresolved
        ) {
            return false;
        }
        const bindings = inferTypeParameterBindings(
            resolved.methods,
            methods,
            resolved.typeParameters,
            settings
        );
        return !!(
            bindings &&
            this._genericBindingsSatisfyConstraints(
                bindings,
                resolved,
                candidateType,
                types,
                interfaces,
                !!settings.loose
            )
        );
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
        const empty = () => ({
            value: new Map(),
            pointer: new Map(),
            valueSelectors: new Map(),
            pointerSelectors: new Map(),
        });
        const visiting = seen || new Set();
        if (visiting.has(typeKey)) return empty();
        visiting.add(typeKey);

        const type = types.get(typeKey);
        if (!type) return empty();

        const mergeSelector = (target, name, selector, depthOffset) => {
            const candidate = {
                ...selector,
                depth: selector.depth + depthOffset,
            };
            const current = target.get(name);
            if (!current || candidate.depth < current.depth) {
                target.set(name, candidate);
                return;
            }
            if (candidate.depth !== current.depth) return;
            target.set(name, {
                depth: current.depth,
                count: current.count + candidate.count,
                kind: 'ambiguous',
            });
        };

        const directSelectors = (mode) => {
            const selectors = new Map();
            for (const [name, signature] of type.methods) {
                const pointerOnly = type.pointerOnlyMethods && type.pointerOnlyMethods.has(name);
                selectors.set(name, {
                    depth: 0,
                    count: 1,
                    kind: mode === 'pointer' || !pointerOnly ? 'method' : 'blocked',
                    signature,
                    origin: { kind: 'type', key: typeKey },
                });
            }
            for (const name of type.fieldNames || []) {
                mergeSelector(
                    selectors,
                    name,
                    { depth: 0, count: 1, kind: 'field' },
                    0
                );
            }
            return selectors;
        };

        const promote = (mode) => {
            const selectors = directSelectors(mode);
            for (const embed of type.embeds) {
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
                let sourceSelectors;
                if (embeddedKey) {
                    const methodSets = this._resolveTypeMethodSetsCached(
                        embeddedKey,
                        types,
                        new Set(visiting)
                    );
                    const pointerEmbed = type.pointerEmbeds && type.pointerEmbeds.has(embed);
                    sourceSelectors =
                        pointerEmbed || mode === 'pointer'
                            ? methodSets.pointerSelectors
                            : methodSets.valueSelectors;
                } else if (embeddedInterfaceKey) {
                    const embeddedInterface = this._mergedInterfaces.get(embeddedInterfaceKey);
                    if (
                        !embeddedInterface ||
                        embeddedInterface.constraint
                    ) {
                        continue;
                    }
                    const methods = this._resolveInterfaceMethodsCached(
                        embeddedInterfaceKey,
                        this._mergedInterfaces
                    ).methods;
                    sourceSelectors = new Map(
                        [...methods].map(([name, signature]) => [
                            name,
                            {
                                depth: 0,
                                count: 1,
                                kind: 'method',
                                signature,
                                origin: { kind: 'interface', key: embeddedInterfaceKey },
                            },
                        ])
                    );
                } else if (canPromoteInterface && BUILTIN_INTERFACES.has(embed)) {
                    sourceSelectors = new Map(
                        [...CANONICAL_BUILTIN_INTERFACES.get(embed)].map(
                            ([name, signature]) => [
                                name,
                                {
                                    depth: 0,
                                    count: 1,
                                    kind: 'method',
                                    signature,
                                    origin: { kind: 'builtin', name: embed },
                                },
                            ]
                        )
                    );
                } else {
                    continue;
                }
                if (type.genericEmbeds && type.genericEmbeds.has(embed)) {
                    const embeddedDeclaration = embeddedKey
                        ? types.get(embeddedKey)
                        : this._mergedInterfaces.get(embeddedInterfaceKey);
                    sourceSelectors = instantiateSelectors(
                        sourceSelectors,
                        embeddedDeclaration && embeddedDeclaration.typeParameters,
                        type.embedArguments && type.embedArguments.get(embed)
                    );
                    if (!sourceSelectors) continue;
                }
                const depthOffset = type.aliasTarget ? 0 : 1;
                for (const [name, selector] of sourceSelectors) {
                    mergeSelector(selectors, name, selector, depthOffset);
                }
            }
            const methods = new Map();
            for (const [name, selector] of selectors) {
                if (selector.count === 1 && selector.kind === 'method') {
                    methods.set(name, selector.signature);
                }
            }
            return { methods, selectors };
        };

        const value = promote('value');
        const pointer = promote('pointer');
        const resolved = {
            value: value.methods,
            pointer: pointer.methods,
            valueSelectors: value.selectors,
            pointerSelectors: pointer.selectors,
        };
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
            this._scheduleInvalidate(p);
        };
        this._watcher.onDidCreate(onChange);
        this._watcher.onDidChange(onChange);
        this._watcher.onDidDelete((uri) => {
            this._removeFile(uri.fsPath);
            this._scheduleInvalidate(uri.fsPath);
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
    _scheduleInvalidate(file) {
        if (file) this._pendingInvalidationFiles.add(path.normalize(file));
        if (this._invalidateTimer) return;
        this._invalidateTimer = setTimeout(() => {
            this._invalidateTimer = null;
            const changedFiles = [...this._pendingInvalidationFiles];
            this._pendingInvalidationFiles.clear();
            this._invalidateMerged(changedFiles);
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
        const folderKey = JSON.stringify(normalizeWildcardPatterns(cfg.excludedFolders));
        if (this._folderPatternCacheKey !== folderKey) {
            this._folderPatternCacheKey = folderKey;
            this._folderMatcher = createFolderMatcher(JSON.parse(folderKey));
        }
        if (this._folderMatcher(path.dirname(filePath))) return true;
        const fileName = path.basename(filePath);
        for (const pattern of cfg.excludedFilePatterns || []) {
            if (fileName.includes(pattern)) return true;
        }
        return this._isPackageExcluded(this._importPathForFile(filePath));
    }

    _normalizedPackagePatterns(cfg) {
        return normalizeWildcardPatterns(cfg.excludedPackagePatterns);
    }

    _packagePatternKey() {
        return JSON.stringify(this._normalizedPackagePatterns(this.getConfig()));
    }

    _isPackageExcluded(importPath) {
        if (!importPath) return false;
        const key = this._packagePatternKey();
        if (this._packagePatternCacheKey !== key) {
            this._packagePatternCacheKey = key;
            this._packagePatternMatchers = JSON.parse(key)
                .map(compileWildcardPattern)
                .filter(Boolean);
        }
        return this._packagePatternMatchers.some((matcher) => matcher.test(importPath));
    }

    _importPathForDirectory(directory) {
        directory = path.normalize(directory);
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

    _importPathForFile(file) {
        return this._importPathForDirectory(path.dirname(file));
    }

    _filterDependencyFiles(files) {
        return [...(files || [])].filter(
            (file) => !this._isPackageExcluded(this._importPathForFile(file))
        );
    }

    _workspaceRoots() {
        return [...this._builds.keys()].map(path.normalize);
    }

    _isWorkspaceDirectory(directory) {
        const normalized = path.normalize(directory);
        return this._workspaceRoots().some((root) => {
            const relative = path.relative(root, normalized);
            return (
                relative === '' ||
                (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
            );
        });
    }

    _selectAnchorMethod(methodKeys) {
        return [...methodKeys]
            .map(bareMethodName)
            .sort((left, right) => right.length - left.length || left.localeCompare(right))[0];
    }

    _workspaceCandidateFiles(kind, methodName) {
        const roots = this._workspaceRoots();
        const key = [
            kind,
            methodName,
            this._packagePatternKey(),
            JSON.stringify(normalizeWildcardPatterns(this.getConfig().excludedFolders)),
            ...roots,
        ].join('\0');
        if (this._workspaceCandidateCache.has(key)) {
            return this._workspaceCandidateCache.get(key);
        }
        const search =
            kind === 'implementation'
                ? grepImplementationFilesForMethod
                : grepInterfaceFilesForMethod;
        const request = Promise.all(
            roots.map((root) => search(root, methodName, Number.MAX_SAFE_INTEGER))
        ).then((groups) => {
            const files = new Set(groups.flat().map(path.normalize));
            for (const file of this._candidateFilesByMethod.get(methodName) || []) {
                files.add(path.normalize(file));
            }
            return [...files].filter(
                (file) =>
                    !this._isExcluded(file) &&
                    shouldIncludeGoFile(file, '', this._buildContext)
            );
        });
        this._workspaceCandidateCache.set(key, request);
        return request;
    }

    _workspaceTypeReferenceCandidates(typeNames) {
        const names = [...new Set(typeNames)].sort();
        if (names.length === 0) return Promise.resolve([]);
        const roots = this._workspaceRoots();
        const key = [
            'type-reference',
            names.join(','),
            this._packagePatternKey(),
            JSON.stringify(normalizeWildcardPatterns(this.getConfig().excludedFolders)),
            ...roots,
        ].join('\0');
        if (this._workspaceCandidateCache.has(key)) {
            return this._workspaceCandidateCache.get(key);
        }
        const request = Promise.all(
            roots.map((root) =>
                grepGoFilesForTypeNames(root, names, Number.MAX_SAFE_INTEGER)
            )
        ).then((groups) =>
            [...new Set(groups.flat().map(path.normalize))].filter(
                (file) =>
                    !this._isExcluded(file) &&
                    shouldIncludeGoFile(file, '', this._buildContext)
            )
        );
        this._workspaceCandidateCache.set(key, request);
        return request;
    }

    _registerParsedWorkspacePackage(files, importPath) {
        for (const [file, info] of files) {
            const normalized = path.normalize(file);
            const packageKey = packageKeyFor(normalized, info.packageName);
            this._packageKeyByFile.set(normalized, packageKey);
            const directory = path.dirname(normalized);
            if (!this._packageKeysByDirectory.has(directory)) {
                this._packageKeysByDirectory.set(directory, new Set());
            }
            this._packageKeysByDirectory.get(directory).add(packageKey);
            if (!this._packageFiles.has(packageKey)) this._packageFiles.set(packageKey, new Set());
            this._packageFiles.get(packageKey).add(normalized);
            if (importPath) this._packageKeyByImportPath.set(importPath, packageKey);
        }
    }

    async _loadWorkspaceDirectory(directory, priority) {
        if (!this.astPool) return null;
        const normalizedDirectory = path.normalize(directory);
        const importPath = this._importPathForDirectory(normalizedDirectory);
        if (this._isPackageExcluded(importPath)) return null;
        const cacheKey = `${normalizedDirectory}\0${importPath || ''}`;
        const requestedPriority = Number.isFinite(priority) ? priority : 200;
        const cached = this._workspacePackageCache.get(cacheKey);
        if (cached) {
            if (requestedPriority > cached.priority) {
                cached.priority = requestedPriority;
                if (cached.sources) {
                    void this._parseAstFiles(cached.sources, requestedPriority).catch(() => {});
                }
            }
            return cached.promise;
        }

        const entry = { priority: requestedPriority, sources: null, promise: null };
        entry.promise = (async () => {
            let entries;
            try {
                entries = await fs.promises.readdir(normalizedDirectory, { withFileTypes: true });
            } catch (_) {
                return null;
            }
            const files = new Set(
                entries
                    .filter(
                        (item) =>
                            item.isFile() &&
                            item.name.endsWith('.go') &&
                            !item.name.endsWith('_test.go')
                    )
                    .map((item) => path.join(normalizedDirectory, item.name))
            );
            for (const file of this.overlayTexts.keys()) {
                if (path.dirname(file) === normalizedDirectory && file.endsWith('.go')) files.add(file);
            }
            const sources = await mapWithConcurrency(
                [...files].filter(
                    (file) =>
                        !this._isExcluded(file) &&
                        shouldIncludeGoFile(file, '', this._buildContext)
                ),
                PACKAGE_READ_CONCURRENCY,
                async (file) => {
                    try {
                        const overlay = this.overlayTexts.get(file);
                        const text = overlay === undefined
                            ? await fs.promises.readFile(file, 'utf8')
                            : overlay;
                        if (!shouldIncludeGoFile(file, text, this._buildContext)) return null;
                        return overlay === undefined
                            ? { file, diskText: text, declarationOnly: true }
                            : { file, text, declarationOnly: true };
                    } catch (_) {
                        return null;
                    }
                }
            );
            entry.sources = sources.filter(Boolean);
            const parsed = await this._parseAstFiles(entry.sources, entry.priority);
            const parsedFiles = new Map(
                [...parsed].map(([file, info]) => [
                    file,
                    { ...info, importPath: importPath || null, externalSource: false },
                ])
            );
            this._registerParsedWorkspacePackage(parsedFiles, importPath);
            return { directory: normalizedDirectory, files: parsedFiles };
        })()
            .catch((error) => {
                this.log(`Workspace package parse failed for ${normalizedDirectory}: ${error.message}`);
                return null;
            })
            .finally(() => {
                entry.sources = null;
            });
        this._workspacePackageCache.set(cacheKey, entry);
        return entry.promise;
    }

    async _loadWorkspaceCandidatePackages(files, priority, astFiles) {
        const loadedDirectories = new Set([...astFiles.keys()].map((file) => path.dirname(file)));
        const directories = new Set();
        for (const file of files || []) {
            const directory = path.dirname(file);
            if (!loadedDirectories.has(directory)) directories.add(directory);
        }
        const packages = await mapWithConcurrency(
            directories,
            WORKSPACE_PACKAGE_LOAD_CONCURRENCY,
            (directory) => this._loadWorkspaceDirectory(directory, priority)
        );
        for (const packageInfo of packages) {
            if (!packageInfo) continue;
            for (const [file, info] of packageInfo.files) astFiles.set(file, info);
        }
        return directories;
    }

    _matchingBuiltinTypeNames(methods) {
        const names = new Set();
        for (const [identity, builtinMethods] of BUILTIN_INTERFACES) {
            if (identity.startsWith('@{') || !satisfies(methods, builtinMethods)) continue;
            const dot = identity.lastIndexOf('.');
            names.add(dot === -1 ? identity : identity.slice(dot + 1));
        }
        return names;
    }

    _typeNamesWithMethod(view, methodName, externalOnly) {
        const names = new Set();
        const { types } = view._merged();
        for (const [typeKey, info] of types) {
            if (info.interfaceAlias || (!!externalOnly !== !!info.externalSource)) continue;
            const methodSets = view._resolveTypeMethodSetsCached(typeKey, types);
            if (
                [...methodSets.pointer.keys()].some(
                    (name) => bareMethodName(name) === methodName
                )
            ) {
                names.add(info.name);
            }
        }
        return names;
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
            const canonicalMethods = (methods) =>
                new Map(
                    [...(methods || new Map())].map(([methodName, signature]) => [
                        methodKeyFor(methodName, packageKey),
                        canonicalSignature(signature),
                    ])
                );
            const canonicalMethodMap = (values) =>
                new Map(
                    [...(values || new Map())].map(([methodName, value]) => [
                        methodKeyFor(methodName, packageKey),
                        value,
                    ])
                );
            const canonicalMethodSet = (values) =>
                new Set(
                    [...(values || new Set())].map((methodName) =>
                        methodKeyFor(methodName, packageKey)
                    )
                );
            const canonicalTypeParameters = (parameters) =>
                (parameters || []).map((parameter) => ({
                    ...parameter,
                    constraint: canonicalSignature(parameter.constraint || 'any'),
                    constraintMethods: canonicalMethods(parameter.constraintMethods),
                    constraintTypeElements: (
                        parameter.constraintTypeElements || []
                    ).map(canonicalSignature),
                }));
            const canonicalEmbedArguments = (argumentsByEmbed) =>
                new Map(
                    [...(argumentsByEmbed || new Map())].map(([embed, argumentsList]) => [
                        embed,
                        argumentsList.map(canonicalSignature),
                    ])
                );
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
                        methods: canonicalMethods(info.methods),
                        embeds: info.embeds,
                        methodLines: canonicalMethodMap(info.methodLines),
                        constraint: !!info.constraint,
                        generic: !!info.generic,
                        typeParameters: canonicalTypeParameters(info.typeParameters),
                        embedArguments: canonicalEmbedArguments(info.embedArguments),
                        typeElements: (info.typeElements || []).map(canonicalSignature),
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
                        embedArguments: new Map(),
                        typeParameters: [],
                        typeElements: [],
                        externalSource: false,
                        importPath: importPathsByPackage.get(packageKey) || null,
                    });
                }
                const flat = interfacesFlat.get(symbolKey);
                for (const [m, s] of canonicalMethods(info.methods)) flat.methods.set(m, s);
                flat.embeds.push(...info.embeds);
                flat.constraint = flat.constraint || !!info.constraint;
                flat.generic = flat.generic || !!info.generic;
                flat.externalSource = flat.externalSource || !!parsed.externalSource;
                for (const embed of info.genericEmbeds || []) flat.genericEmbeds.add(embed);
                for (const [embed, argumentsList] of canonicalEmbedArguments(info.embedArguments)) {
                    flat.embedArguments.set(embed, argumentsList);
                }
                if (flat.typeParameters.length === 0 && (info.typeParameters || []).length > 0) {
                    flat.typeParameters = canonicalTypeParameters(info.typeParameters);
                }
                flat.typeElements.push(...(info.typeElements || []).map(canonicalSignature));
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
                    methods: canonicalMethods(info.methods),
                    embeds: info.embeds,
                    methodLines: canonicalMethodMap(info.methodLines),
                    methodCharacters: canonicalMethodMap(info.methodCharacters),
                    pointerMethods: canonicalMethodSet(info.pointerMethods),
                    fieldNames: canonicalMethodSet(info.fieldNames),
                    pointerEmbeds: info.pointerEmbeds || new Set(),
                    genericEmbeds: info.genericEmbeds || new Set(),
                    embedArguments: canonicalEmbedArguments(info.embedArguments),
                    typeParameters: canonicalTypeParameters(info.typeParameters),
                    underlying: info.underlying
                        ? canonicalSignature(info.underlying)
                        : null,
                    declared: info.declared !== false,
                    externalSource: !!parsed.externalSource,
                });

                if (!typesFlat.has(symbolKey)) {
                    typesFlat.set(symbolKey, {
                        name,
                        packageKey,
                        methods: new Map(),
                        fieldNames: new Set(),
                        embeds: [],
                        pointerOnlyMethods: new Set(),
                        pointerEmbeds: new Set(),
                        genericEmbeds: new Set(),
                        embedArguments: new Map(),
                        typeParameters: [],
                        underlying: null,
                        struct: false,
                        aliasTarget: null,
                        interfaceAlias: false,
                        externalSource: false,
                        importPath: importPathsByPackage.get(packageKey) || null,
                    });
                }
                const flat = typesFlat.get(symbolKey);
                for (const [m, s] of canonicalMethods(info.methods)) {
                    flat.methods.set(m, s);
                    const bareName = bareMethodName(m);
                    if (info.pointerMethods && info.pointerMethods.has(bareName)) {
                        flat.pointerOnlyMethods.add(m);
                    } else {
                        flat.pointerOnlyMethods.delete(m);
                    }
                }
                for (const fieldName of info.fieldNames || []) {
                    flat.fieldNames.add(methodKeyFor(fieldName, packageKey));
                }
                flat.embeds.push(...info.embeds);
                for (const embed of info.pointerEmbeds || []) flat.pointerEmbeds.add(embed);
                for (const embed of info.genericEmbeds || []) flat.genericEmbeds.add(embed);
                for (const [embed, argumentsList] of canonicalEmbedArguments(info.embedArguments)) {
                    flat.embedArguments.set(embed, argumentsList);
                }
                if (flat.typeParameters.length === 0 && (info.typeParameters || []).length > 0) {
                    flat.typeParameters = canonicalTypeParameters(info.typeParameters);
                }
                if (!flat.underlying && info.underlying) {
                    flat.underlying = canonicalSignature(info.underlying);
                }
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
            const reference = normalizedNamedTypeReference(target);
            let interfaceKey = null;
            let targetTypeKey = null;
            if (reference && reference.importPath) {
                const identity = `${reference.importPath}\0${reference.name}`;
                interfaceKey = interfaceKeyByImportIdentity.get(identity);
                targetTypeKey = typeKeyByImportIdentity.get(identity);
            } else if (reference) {
                interfaceKey = symbolKeyFor(type.packageKey, reference.name);
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

    async _parseAstPackages(packageKeys, priority) {
        if (!this.astPool) throw new Error('lazy AST index is disabled');
        const requests = [];
        const seen = new Set();
        for (const packageKey of packageKeys) {
            for (const file of this._packageFiles.get(packageKey) || []) {
                if (seen.has(file)) continue;
                seen.add(file);
                requests.push({
                    file,
                    text: this.overlayTexts.get(file),
                    declarationOnly: true,
                });
            }
        }
        if (requests.length === 0) return new Map();
        return this._parseAstFiles(requests, priority === undefined ? 100 : priority);
    }

    _parseAstFiles(requests, priority) {
        if (!this.astPool) throw new Error('lazy AST index is disabled');
        const included = (requests || []).filter(
            (request) => request && request.file && !this._isExcluded(request.file)
        );
        if (included.length === 0) return Promise.resolve(new Map());
        return this.astPool.parseFiles(included, priority);
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

    _resolveWorkspaceImportDirectory(importPath) {
        for (const root of this._workspaceRoots()) {
            try {
                const goModPath = findGoMod(root);
                if (!goModPath) continue;
                const source = fs.readFileSync(goModPath, 'utf8');
                const moduleMatch = source.match(/^\s*module\s+(\S+)/m);
                if (!moduleMatch) continue;
                const modulePath = moduleMatch[1];
                if (importPath !== modulePath && !importPath.startsWith(`${modulePath}/`)) {
                    continue;
                }
                const suffix = importPath === modulePath
                    ? []
                    : importPath.slice(modulePath.length + 1).split('/').filter(Boolean);
                const directory = path.join(path.dirname(goModPath), ...suffix);
                if (fs.existsSync(directory) && fs.statSync(directory).isDirectory()) {
                    return directory;
                }
            } catch (_) {
                // Try the next registered root.
            }
        }
        return null;
    }

    async _resolveExternalImportDirectory(importPath) {
        if (this._isPackageExcluded(importPath)) return null;
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
            const workspaceDirectory = this._resolveWorkspaceImportDirectory(importPath);
            if (workspaceDirectory) return workspaceDirectory;
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

    async _loadExternalPackage(importPath, priority) {
        if (!this.astPool || this._isPackageExcluded(importPath)) return null;
        const directory = await this._resolveExternalImportDirectory(importPath);
        if (!directory) return null;
        if (this._isWorkspaceDirectory(directory)) {
            return this._loadWorkspaceDirectory(directory, priority);
        }
        return this._loadExternalDirectory(directory, importPath, priority);
    }

    async _loadExternalDirectory(directory, importPath, priority) {
        if (!this.astPool) return null;
        const normalizedDirectory = path.normalize(directory);
        const resolvedImportPath = importPath || this._importPathForDirectory(normalizedDirectory);
        if (this._isPackageExcluded(resolvedImportPath)) return null;
        const cacheKey = `${normalizedDirectory}\0${resolvedImportPath || ''}`;
        const requestedPriority = Number.isFinite(priority) ? priority : 150;
        const cached = this._externalPackageCache.get(cacheKey);
        if (cached) {
            if (requestedPriority > cached.priority) {
                cached.priority = requestedPriority;
                if (cached.sources) {
                    void this._parseAstFiles(cached.sources, requestedPriority).catch(() => {});
                }
            }
            return cached.promise;
        }
        const entry = { priority: requestedPriority, sources: null, promise: null };
        entry.promise = (async () => {
            let entries;
            try {
                entries = await fs.promises.readdir(normalizedDirectory, { withFileTypes: true });
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
                .map((entry) => path.join(normalizedDirectory, entry.name))
                .filter(
                    (file) =>
                        !this._isExcluded(file) &&
                        shouldIncludeGoFile(file, '', this._buildContext)
                );
            const sources = await Promise.all(
                files.map(async (file) => {
                    try {
                        const text = await fs.promises.readFile(file, 'utf8');
                        if (!shouldIncludeGoFile(file, text, this._buildContext)) return null;
                        return { file, diskText: text, declarationOnly: true };
                    } catch (_) {
                        return null;
                    }
                })
            );
            entry.sources = sources.filter(Boolean);
            const parsed = await this._parseAstFiles(entry.sources, entry.priority);
            return {
                directory: normalizedDirectory,
                files: new Map(
                    [...parsed].map(([file, info]) => [
                        file,
                        { ...info, importPath: resolvedImportPath || null, externalSource: true },
                    ])
                ),
            };
        })()
            .catch((error) => {
                this.log(
                    `External package parse failed for ${resolvedImportPath || normalizedDirectory}: ${error.message}`
                );
                return null;
            })
            .finally(() => {
                // Priority promotion only needs source text while parsing is in
                // flight. Keeping every dependency source after that doubles
                // the long-lived package-cache footprint.
                entry.sources = null;
            });
        this._externalPackageCache.set(cacheKey, entry);
        return entry.promise;
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
                    for (const parameter of declaration.typeParameters || []) {
                        for (const reference of importedSignatureReferences(
                            parameter.constraint || ''
                        )) {
                            const packageKey = this._packageForImportPath(reference.importPath);
                            if (packageKey && !packages.has(packageKey)) additions.add(packageKey);
                            else if (!packageKey && !externalImports.has(reference.importPath)) {
                                externalAdditions.add(reference.importPath);
                            }
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
                [...externalAdditions].map((importPath) =>
                    this._loadExternalPackage(importPath, priority)
                )
            );
            for (const externalPackage of externalPackages) {
                if (!externalPackage) continue;
                for (const [file, info] of externalPackage.files) parsed.set(file, info);
            }
        }
        return { packages, astFiles: parsed };
    }

    _potentialSignatureAliasImports(astFiles, methodNames) {
        const wanted = new Set([...methodNames].map(bareMethodName));
        const aliasesByPackage = new Map();
        const localNamesByPackage = new Map();
        const importPathsByPackage = new Map();
        for (const [file, parsed] of astFiles) {
            const packageKey = packageKeyFor(file, parsed.packageName);
            if (!aliasesByPackage.has(packageKey)) aliasesByPackage.set(packageKey, new Map());
            const aliases = aliasesByPackage.get(packageKey);
            for (const [name, target] of parsed.aliases || []) aliases.set(name, target);
            if (!localNamesByPackage.has(packageKey)) {
                localNamesByPackage.set(packageKey, new Set());
            }
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
            const resolved = canonicalizeQualifiedAliases(
                canonicalizeWithinPackage(target, targetPackage),
                resolveQualifiedAlias,
                seen
            );
            qualifiedAliasCache.set(identity, resolved);
            return resolved;
        };

        const signaturesByMethod = new Map();
        const collect = (methods, packageKey) => {
            for (const [name, signature] of methods) {
                if (!wanted.has(bareMethodName(name))) continue;
                if (!signaturesByMethod.has(name)) signaturesByMethod.set(name, []);
                signaturesByMethod.get(name).push(
                    canonicalizeQualifiedAliases(
                        canonicalizeWithinPackage(signature, packageKey),
                        resolveQualifiedAlias
                    ).replace(/\s+/g, '')
                );
            }
        };
        for (const [file, parsed] of astFiles) {
            const packageKey = packageKeyFor(file, parsed.packageName);
            for (const info of parsed.interfaces.values()) collect(info.methods, packageKey);
            for (const info of parsed.types.values()) collect(info.methods, packageKey);
        }
        const imports = new Set();
        for (const signatures of signaturesByMethod.values()) {
            for (const importPath of potentialAliasImports(signatures)) imports.add(importPath);
        }
        return { imports };
    }

    async _expandSignatureAliasPackages(astFiles, methodNames, priority) {
        let parsed = new Map(astFiles);
        for (let round = 0; round < 10; round++) {
            const analysis = this._potentialSignatureAliasImports(parsed, methodNames);
            const requested = analysis.imports;
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
                [...externalAdditions].map((importPath) =>
                    this._loadExternalPackage(importPath, priority)
                )
            );
            let added = workspaceFiles.size > 0;
            for (const externalPackage of externalPackages) {
                if (!externalPackage) continue;
                for (const [file, info] of externalPackage.files) parsed.set(file, info);
                if (externalPackage.files.size > 0) added = true;
            }
            if (!added) break;

            const allPackages = new Set([...representedPackages, ...workspaceAdditions]);
            const closure = await this._expandEmbeddedAstPackages(allPackages, parsed, priority);
            parsed = closure.astFiles;
        }
        return { astFiles: parsed, view: this._createAstView(parsed) };
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
        if (!declaration || declaration.constraint) return null;
        const resolved = view._resolveInterfaceMethodsCached(interfaceKey, interfaces);
        if (resolved.constraint || resolved.methods.size === 0) return null;
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

    _implementationAstContext(interfaceName, interfaceFile) {
        const key = `context\0${interfaceFile}\0${interfaceName}`;
        return this._cachedAstQuery(key, () =>
            this._buildImplementationAstContext(interfaceName, interfaceFile)
        );
    }

    async _buildImplementationAstContext(interfaceName, interfaceFile) {
        const interfacePackageInfo = await this._loadWorkspaceDirectory(
            path.dirname(interfaceFile),
            200
        );
        if (!interfacePackageInfo) return null;
        const interfaceFiles = new Map(interfacePackageInfo.files);
        const interfacePackage = this._packageForFile(interfaceFile);
        const interfaceClosure = await this._expandEmbeddedAstPackages(
            new Set(interfacePackage ? [interfacePackage] : []),
            interfaceFiles,
            200
        );
        const interfaceView = this._createAstView(interfaceClosure.astFiles);
        const descriptor = this._interfaceDescriptor(interfaceView, interfaceName, interfaceFile);
        if (!descriptor) return null;

        const anchorMethod = this._selectAnchorMethod(descriptor.resolved.methods.keys());
        if (!anchorMethod) return null;
        const [implementationCandidates, interfaceCandidates] = await Promise.all([
            this._workspaceCandidateFiles('implementation', anchorMethod),
            this._workspaceCandidateFiles('interface', anchorMethod),
        ]);
        const candidateFiles = new Set([
            ...implementationCandidates,
            ...interfaceCandidates,
        ]);
        const astFiles = new Map(interfaceClosure.astFiles);
        const loadedDirectories = await this._loadWorkspaceCandidatePackages(
            candidateFiles,
            200,
            astFiles
        );

        let aliasExpansion = null;
        const searchedTypeNames = new Set();
        const builtinNames = this._matchingBuiltinTypeNames(descriptor.resolved.methods);
        for (let round = 0; round < 10; round++) {
            const packages = new Set(
                [...astFiles.keys()].map((file) => this._packageForFile(file)).filter(Boolean)
            );
            const closure = await this._expandEmbeddedAstPackages(packages, astFiles, 200);
            aliasExpansion = await this._expandSignatureAliasPackages(
                closure.astFiles,
                descriptor.resolved.methods.keys(),
                200
            );
            astFiles.clear();
            for (const [file, info] of aliasExpansion.astFiles) astFiles.set(file, info);

            const view = aliasExpansion.view;
            const names = new Set(builtinNames);
            for (const name of this._typeNamesWithMethod(view, anchorMethod, false)) {
                names.add(name);
            }
            for (const result of view.findImplementations(interfaceName, interfaceFile, {
                includeExternal: true,
            })) {
                names.add(result.name.replace(/^\*/, ''));
            }
            const { interfaces } = view._merged();
            const target = view._interfaceDescriptor(view, interfaceName, interfaceFile);
            if (target) {
                for (const [interfaceKey, info] of interfaces) {
                    if (info.constraint) continue;
                    const resolved = view._resolveInterfaceMethodsCached(interfaceKey, interfaces);
                    if (satisfies(target.resolved.methods, resolved.methods)) names.add(info.name);
                }
            }
            for (const name of searchedTypeNames) names.delete(name);
            if (names.size === 0) break;
            for (const name of names) searchedTypeNames.add(name);

            const references = await this._workspaceTypeReferenceCandidates(names);
            for (const file of references) candidateFiles.add(file);
            const before = astFiles.size;
            const additions = await this._loadWorkspaceCandidatePackages(
                references,
                200,
                astFiles
            );
            for (const directory of additions) loadedDirectories.add(directory);
            if (astFiles.size === before) break;
        }
        if (!aliasExpansion) return null;
        const candidates = new Set(
            [...astFiles.keys()].map((file) => this._packageForFile(file)).filter(Boolean)
        );
        return {
            astFiles: aliasExpansion.astFiles,
            view: aliasExpansion.view,
            candidatePackages: candidates,
            descriptor,
            workspaceCandidateFiles: [...candidateFiles],
            workspaceCandidateDirectories: [...loadedDirectories],
            workspaceAnchorMethod: anchorMethod,
        };
    }

    _dependencyImplementationAstContext(interfaceName, interfaceFile) {
        const key = `dependency-context\0${interfaceFile}\0${interfaceName}`;
        return this._cachedAstQuery(key, async () => {
            const context = await this._implementationAstContext(interfaceName, interfaceFile);
            if (!context || !context.descriptor) return context;
            return this._buildDependencyImplementationAstContext(
                interfaceName,
                interfaceFile,
                context,
                200
            );
        });
    }

    async _buildDependencyImplementationAstContext(
        interfaceName,
        interfaceFile,
        context,
        priority
    ) {
            const cfg = this.getConfig();
            if (cfg.searchDependencies === false) return context;
            const cacheRoot = resolveGoModCache(cfg.goModCache);
            if (!cacheRoot) return context;
            const requestPriority = Number.isFinite(priority) ? priority : 200;

            const anchorMethod = this._selectAnchorMethod(
                context.descriptor.resolved.methods.keys()
            );
            if (!anchorMethod) return context;
            const dependencyDirs = this._dependencySearchDirs(cacheRoot);
            if (dependencyDirs === null) return context;
            const [implementationCandidates, interfaceCandidates] = await Promise.all([
                this._dependencyImplementationCandidates(cacheRoot, anchorMethod, dependencyDirs),
                this._dependencyInterfaceCandidates(cacheRoot, anchorMethod, dependencyDirs),
            ]);
            const candidateFiles = new Set([
                ...implementationCandidates,
                ...interfaceCandidates,
            ]);
            const loadedDirectories = new Set();
            const discoveredImports = new Set();
            let astFiles = new Map(context.astFiles);
            const rememberLoadedDirectories = () => {
                for (const file of astFiles.keys()) loadedDirectories.add(path.dirname(file));
            };
            const loadCandidatePackages = async (files) => {
                rememberLoadedDirectories();
                const additions = new Map();
                for (const file of files) {
                    const directory = path.dirname(file);
                    if (loadedDirectories.has(directory)) continue;
                    const importPath = this._importPathForFile(file);
                    additions.set(directory, importPath);
                }
                const externalPackages = await Promise.all(
                    [...additions].map(([directory, importPath]) =>
                        this._loadExternalDirectory(directory, importPath, requestPriority)
                    )
                );
                for (const externalPackage of externalPackages) {
                    if (!externalPackage) continue;
                    for (const [file, info] of externalPackage.files) astFiles.set(file, info);
                }
                for (const [directory, importPath] of additions) {
                    loadedDirectories.add(directory);
                    discoveredImports.add(importPath || directory);
                }
            };
            await loadCandidatePackages(candidateFiles);
            if (astFiles.size === context.astFiles.size) {
                if (!Array.isArray(context.implementationResults)) return context;
                const externalResults = context.view
                    .findImplementations(interfaceName, interfaceFile, {
                        includeExternal: true,
                    })
                    .filter((result) => result.external);
                return {
                    ...context,
                    implementationResults: dedupeResults([
                        ...context.implementationResults,
                        ...externalResults,
                    ]),
                    includeExternalImplementations: true,
                };
            }

            let aliasExpansion = null;
            const searchedTypeNames = new Set();
            for (let round = 0; round < 10; round++) {
                const closure = await this._expandEmbeddedAstPackages(
                    context.candidatePackages,
                    astFiles,
                    requestPriority
                );
                aliasExpansion = await this._expandSignatureAliasPackages(
                    closure.astFiles,
                    context.descriptor.resolved.methods.keys(),
                    requestPriority
                );
                astFiles = aliasExpansion.astFiles;

                const view = aliasExpansion.view;
                const names = new Set(
                    view
                        .findImplementations(interfaceName, interfaceFile, {
                            includeExternal: true,
                        })
                        .filter((result) => result.external)
                        .map((result) => result.name.replace(/^\*/, ''))
                );
                for (const name of this._typeNamesWithMethod(view, anchorMethod, true)) {
                    names.add(name);
                }
                const { interfaces } = view._merged();
                const target = view._interfaceDescriptor(view, interfaceName, interfaceFile);
                if (target) {
                    for (const [interfaceKey, info] of interfaces) {
                        if (!info.externalSource || info.constraint) continue;
                        const resolved = view._resolveInterfaceMethodsCached(interfaceKey, interfaces);
                        if (satisfies(target.resolved.methods, resolved.methods)) names.add(info.name);
                    }
                }
                for (const name of searchedTypeNames) names.delete(name);
                if (names.size === 0) break;
                for (const name of names) searchedTypeNames.add(name);

                const references = await this._dependencyTypeReferenceCandidates(
                    cacheRoot,
                    names,
                    dependencyDirs
                );
                for (const file of references) candidateFiles.add(file);
                const before = astFiles.size;
                await loadCandidatePackages(references);
                if (astFiles.size === before) break;
            }
            if (!aliasExpansion) return context;
            const externalResults = aliasExpansion.view
                .findImplementations(interfaceName, interfaceFile, {
                    includeExternal: true,
                })
                .filter((result) => result.external);
            this.log(
                `AST dependency implementation context ${interfaceName}: ${candidateFiles.size} ` +
                    `candidate file(s), ${discoveredImports.size} package(s), anchor ${anchorMethod}`
            );
            return {
                ...context,
                astFiles: aliasExpansion.astFiles,
                view: aliasExpansion.view,
                dependencyCandidateFiles: [...candidateFiles],
                implementationResults: Array.isArray(context.implementationResults)
                    ? dedupeResults([...context.implementationResults, ...externalResults])
                    : undefined,
                includeExternalImplementations: true,
            };
    }

    findImplementationsAst(interfaceName, interfaceFile) {
        const key = `implementations\0${interfaceFile}\0${interfaceName}`;
        return this._cachedAstQuery(key, async () => {
            const started = Date.now();
            const cfg = this.getConfig();
            const context =
                cfg.searchDependencies === false
                    ? await this._implementationAstContext(interfaceName, interfaceFile)
                    : await this._dependencyImplementationAstContext(interfaceName, interfaceFile);
            if (!context) return [];
            const results = Array.isArray(context.implementationResults)
                ? context.implementationResults
                : context.view.findImplementations(interfaceName, interfaceFile, {
                      includeExternal: cfg.searchDependencies !== false,
                  });
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
            const cfg = this.getConfig();
            const context =
                cfg.searchDependencies === false
                    ? await this._implementationAstContext(interfaceName, interfaceFile)
                    : await this._dependencyImplementationAstContext(interfaceName, interfaceFile);
            if (!context) return [];
            const contextPrecomputed = context.methodImplementationResults;
            const results =
                contextPrecomputed && contextPrecomputed.has(methodName)
                    ? contextPrecomputed.get(methodName)
                    : context.view.findMethodImplementations(
                          interfaceName,
                          methodName,
                          interfaceFile,
                          {
                              includeExternal:
                                  context.includeExternalImplementations === undefined
                                      ? cfg.searchDependencies !== false
                                      : context.includeExternalImplementations,
                          }
                      );
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
            if (!receiverFile) return [];
            const started = Date.now();
            const receiverPackageInfo = await this._loadWorkspaceDirectory(
                path.dirname(receiverFile),
                200
            );
            if (!receiverPackageInfo) return [];
            const interfaceCandidates = await this._workspaceCandidateFiles(
                'interface',
                methodName
            );
            const astFiles = new Map(receiverPackageInfo.files);
            const loadedDirectories = await this._loadWorkspaceCandidatePackages(
                interfaceCandidates,
                200,
                astFiles
            );

            const builtinNames = new Set();
            for (const [identity, methods] of BUILTIN_INTERFACES) {
                if (identity.startsWith('@{')) continue;
                if (![...methods.keys()].some((name) => bareMethodName(name) === methodName)) continue;
                const dot = identity.lastIndexOf('.');
                builtinNames.add(dot === -1 ? identity : identity.slice(dot + 1));
            }
            const searchedTypeNames = new Set();
            let aliasExpansion = null;
            let results = [];
            for (let round = 0; round < 10; round++) {
                const packages = new Set(
                    [...astFiles.keys()].map((file) => this._packageForFile(file)).filter(Boolean)
                );
                const closure = await this._expandEmbeddedAstPackages(packages, astFiles, 200);
                aliasExpansion = await this._expandSignatureAliasPackages(
                    closure.astFiles,
                    [methodName],
                    200
                );
                astFiles.clear();
                for (const [file, info] of aliasExpansion.astFiles) astFiles.set(file, info);

                const view = aliasExpansion.view;
                results = view._collectLocalInterfaces(receiverType, methodName, {
                    receiverFile,
                }).results;
                const names = new Set([...builtinNames, ...results.map((result) => result.name)]);
                const { interfaces } = view._merged();
                for (const [interfaceKey, info] of interfaces) {
                    if (info.constraint) continue;
                    const resolved = view._resolveInterfaceMethodsCached(interfaceKey, interfaces);
                    if ([...resolved.methods.keys()].some(
                        (name) => bareMethodName(name) === methodName
                    )) {
                        names.add(info.name);
                    }
                }
                for (const name of searchedTypeNames) names.delete(name);
                if (names.size === 0) break;
                for (const name of names) searchedTypeNames.add(name);

                const references = await this._workspaceTypeReferenceCandidates(names);
                const before = astFiles.size;
                const additions = await this._loadWorkspaceCandidatePackages(
                    references,
                    200,
                    astFiles
                );
                for (const directory of additions) loadedDirectories.add(directory);
                if (astFiles.size === before) break;
            }
            if (!aliasExpansion) return [];
            let receiverAstFiles = aliasExpansion.astFiles;
            const cfg = this.getConfig();
            if (cfg.searchDependencies !== false) {
                const cacheRoot = resolveGoModCache(cfg.goModCache);
                if (cacheRoot) {
                    results.push(
                        ...(await this._searchDependencyInterfacesAst(cacheRoot, methodName, {
                            receiverType,
                            receiverFile,
                            astFiles: receiverAstFiles,
                        }))
                    );
                }
            }
            this.log(
                `AST reverse query ${receiverType}.${methodName}: ${loadedDirectories.size + 1} package(s), ` +
                    `${receiverAstFiles.size} file(s), ${Date.now() - started}ms`
            );
            return dedupeResults(results);
        });
    }

    async _searchDependencyInterfacesAst(cacheRoot, methodName, receiver) {
        const dependencyDirs = this._dependencySearchDirs(cacheRoot);
        if (dependencyDirs === null) return [];
        let candidates;
        try {
            candidates = await this._dependencyInterfaceCandidates(
                cacheRoot,
                methodName,
                dependencyDirs
            );
        } catch (err) {
            this.log(`AST dependency candidate search failed: ${err.message}`);
            return [];
        }
        const sources = await Promise.all(
            candidates.map(async (file) => {
                try {
                    if (this._isExcluded(file)) return null;
                    if (!shouldIncludeGoFile(file, '', this._buildContext)) return null;
                    const text = await fs.promises.readFile(file, 'utf8');
                    if (!shouldIncludeGoFile(file, text, this._buildContext)) return null;
                    return { file, diskText: text, declarationOnly: true };
                } catch (_) {
                    return null;
                }
            })
        );
        const requests = sources.filter(Boolean);
        if (requests.length === 0) return [];
        let parsed;
        try {
            const candidateFiles = await this._parseAstFiles(requests, 200);
            parsed = new Map(
                [...candidateFiles].map(([file, info]) => [
                    file,
                    {
                        ...info,
                        importPath: this._importPathForFile(file),
                        externalSource: true,
                    },
                ])
            );
        } catch (err) {
            this.log(`AST dependency parsing failed: ${err.message}`);
            return [];
        }
        const combined = new Map(receiver.astFiles);
        for (const [file, info] of parsed) combined.set(file, info);
        const closure = await this._expandEmbeddedAstPackages(new Set(), combined, 200);
        const aliasExpansion = await this._expandSignatureAliasPackages(
            closure.astFiles,
            [methodName],
            200
        );
        const view = aliasExpansion.view;
        const results = view._collectLocalInterfaces(receiver.receiverType, methodName, {
            receiverFile: receiver.receiverFile,
        }).results;
        this.log(
            `AST dependency query ${methodName}: ${candidates.length} candidate file(s), ` +
                `${parsed.size} parsed file(s)`
        );
        return results;
    }

    _dependencyInterfaceCandidates(cacheRoot, methodName, lockedDirs) {
        const normalizedDirs = [...(lockedDirs || [])].map(path.normalize).sort();
        const key = `${this._packagePatternKey()}\0${path.normalize(cacheRoot)}\0${methodName}\0${normalizedDirs.join('\0')}`;
        if (this._dependencyCandidateCache.has(key)) {
            return this._dependencyCandidateCache.get(key);
        }
        let request;
        request = grepInterfaceFilesForMethod(
            cacheRoot,
            methodName,
            normalizedDirs.length > 0 ? Number.MAX_SAFE_INTEGER : undefined,
            normalizedDirs
        ).then((files) => this._filterDependencyFiles(files)).catch((error) => {
            if (this._dependencyCandidateCache.get(key) === request) {
                this._dependencyCandidateCache.delete(key);
            }
            throw error;
        });
        this._dependencyCandidateCache.set(key, request);
        return request;
    }

    _dependencyImplementationCandidates(cacheRoot, methodName, lockedDirs) {
        const normalizedDirs = [...(lockedDirs || [])].map(path.normalize).sort();
        const key = `${this._packagePatternKey()}\0${path.normalize(cacheRoot)}\0${methodName}\0${normalizedDirs.join('\0')}`;
        if (this._dependencyImplementationCandidateCache.has(key)) {
            return this._dependencyImplementationCandidateCache.get(key);
        }
        let request;
        request = grepImplementationFilesForMethod(
            cacheRoot,
            methodName,
            normalizedDirs.length > 0 ? Number.MAX_SAFE_INTEGER : undefined,
            normalizedDirs
        ).then((files) => this._filterDependencyFiles(files)).catch((error) => {
            if (this._dependencyImplementationCandidateCache.get(key) === request) {
                this._dependencyImplementationCandidateCache.delete(key);
            }
            throw error;
        });
        this._dependencyImplementationCandidateCache.set(key, request);
        return request;
    }


    _dependencyTypeReferenceCandidates(cacheRoot, typeNames, lockedDirs) {
        const normalizedDirs = [...(lockedDirs || [])].map(path.normalize).sort();
        const names = [...new Set(typeNames)].sort();
        const key = `${this._packagePatternKey()}\0${path.normalize(cacheRoot)}\0${names.join(',')}\0${normalizedDirs.join('\0')}`;
        if (this._dependencyTypeReferenceCandidateCache.has(key)) {
            return this._dependencyTypeReferenceCandidateCache.get(key);
        }
        let request;
        request = grepGoFilesForTypeNames(
            cacheRoot,
            names,
            normalizedDirs.length > 0 ? Number.MAX_SAFE_INTEGER : undefined,
            normalizedDirs
        ).then((files) => this._filterDependencyFiles(files)).catch((error) => {
            if (this._dependencyTypeReferenceCandidateCache.get(key) === request) {
                this._dependencyTypeReferenceCandidateCache.delete(key);
            }
            throw error;
        });
        this._dependencyTypeReferenceCandidateCache.set(key, request);
        return request;
    }

    getAstStats() {
        return this.astPool ? { ...this.astPool.stats } : null;
    }

    /**
     * Find all concrete types that implement the given interface (by signature).
     * @param {string} interfaceName
     * @param {string} [interfaceFile] source file that identifies the package
     * @param {{includeExternal?:boolean}} [opts]
     * @returns {{name:string, file:string, line:number}[]}
     */
    findImplementations(interfaceName, interfaceFile, opts) {
        const { interfaces, types } = this._merged();
        const interfaceKey = this._findInterfaceKey(interfaceName, interfaceFile);
        if (!interfaceKey) return [];
        const resolved = this._resolveInterfaceMethodsCached(interfaceKey, interfaces);
        if (resolved.constraint || resolved.methods.size === 0) return [];

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
        const includeExternal = !!(opts && opts.includeExternal);
        const strict = this._collectImplementations(
            resolved,
            types,
            interfaces,
            false,
            includeExternal
        );
        const loose = this._collectImplementations(
            resolved,
            types,
            interfaces,
            true,
            includeExternal
        );
        return dedupeResults([...strict, ...loose]);
    }

    _collectImplementations(resolved, types, interfaces, loose, includeExternal) {
        const results = [];
        for (const [typeKey, typeInfo] of types) {
            if (typeInfo.interfaceAlias || (typeInfo.externalSource && !includeExternal)) continue;
            const methodSets = this._resolveTypeMethodSetsCached(typeKey, types);
            const valueImplements = this._interfaceSatisfiedBy(
                resolved,
                methodSets.value,
                typeInfo,
                types,
                interfaces,
                {
                    unresolved: resolved.unresolved,
                    loose,
                }
            );
            const pointerImplements =
                valueImplements ||
                this._interfaceSatisfiedBy(
                    resolved,
                    methodSets.pointer,
                    typeInfo,
                    types,
                    interfaces,
                    {
                        unresolved: resolved.unresolved,
                        loose,
                    }
                );
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
                        external: !!typeInfo.externalSource,
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
     * @param {{includeExternal?:boolean}} [opts]
     * @returns {{name:string, file:string, line:number, signature:string}[]}
     */
    findMethodImplementations(interfaceName, methodName, interfaceFile, opts) {
        const { interfaces, types } = this._merged();
        const interfaceKey = this._findInterfaceKey(interfaceName, interfaceFile);
        if (!interfaceKey) return [];
        const resolved = this._resolveInterfaceMethodsCached(interfaceKey, interfaces);
        if (resolved.constraint) return [];
        const methodKey = methodKeyFor(methodName, resolved.packageKey);
        const wantSig = resolved.methods.get(methodKey);

        // Run both strict and loose passes and merge (deduped). A cross-package
        // implementation qualifies the interface's types while the interface
        // uses its bare package-local names, so it only matches under the loose
        // pass; skipping loose whenever strict found anything dropped those
        // implementations. Package-aware loose matching (looseSignatureEqual)
        // keeps this from reintroducing cross-package false positives.
        const includeExternal = !!(opts && opts.includeExternal);
        const strict = this._collectMethodImplementations(
            resolved,
            wantSig,
            methodKey,
            types,
            interfaces,
            false,
            includeExternal
        );
        const loose = this._collectMethodImplementations(
            resolved,
            wantSig,
            methodKey,
            types,
            interfaces,
            true,
            includeExternal
        );
        return dedupeResults([...strict, ...loose]);
    }

    _collectMethodImplementations(
        resolved,
        wantSig,
        methodKey,
        types,
        interfaces,
        loose,
        includeExternal
    ) {
        const results = [];
        const sigMatches = (a, b) => {
            if (a === b) return true;
            // Loose matching still requires identical shape and rejects two
            // different packages' same-named types (see looseSignatureEqual).
            return loose && looseSignatureEqual(a, b);
        };
        for (const [typeKey, typeInfo] of types) {
            if (typeInfo.interfaceAlias || (typeInfo.externalSource && !includeExternal)) continue;
            const methodSets = this._resolveTypeMethodSetsCached(typeKey, types);
            const implementsWith = (methods) => {
                const sig = methods.get(methodKey);
                if (sig === undefined) return false;
                if (
                    (!resolved.typeParameters || resolved.typeParameters.length === 0) &&
                    wantSig !== undefined &&
                    !sigMatches(sig, wantSig)
                ) {
                    return false;
                }
                return this._interfaceSatisfiedBy(
                    resolved,
                    methods,
                    typeInfo,
                    types,
                    interfaces,
                    {
                        unresolved: resolved.unresolved,
                        allowUnresolved: true,
                        loose,
                    }
                );
            };
            const valueImplements = implementsWith(methodSets.value);
            const pointerImplements = valueImplements || implementsWith(methodSets.pointer);
            if (!pointerImplements) continue;
            const mode = valueImplements ? 'value' : 'pointer';
            const sig = methodSets[mode].get(methodKey);

            // Locations are already package-scoped by typeKey. Emit the direct
            // declaration(s) for this method and dedupe the strict/loose passes.
            for (const loc of this._findMethodLocations(typeKey, methodKey, mode)) {
                results.push({
                    name: valueImplements ? typeInfo.name : `*${typeInfo.name}`,
                    ...loc,
                    signature: sig,
                    external: !!typeInfo.externalSource,
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
        const typeInfo = typeKey && types.get(typeKey);
        const typeMethods = typeKey ? this._resolveTypeMethodsCached(typeKey, types) : new Map();
        const methodKey = methodKeyFor(methodName, typeInfo && typeInfo.packageKey);
        const mySig = typeMethods.get(methodKey);

        const results = [];
        const seenInterfaces = new Set();

        const consider = (interfaceKey, resolved, decl, external) => {
            if (resolved.constraint) return false;
            const sig = resolved.methods.get(methodKey);
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
            if (mySig === undefined) return false;
            if (resolved.typeParameters && resolved.typeParameters.length > 0) {
                const wantedMethod = new Map([[methodKey, sig]]);
                const actualMethod = new Map([[methodKey, mySig]]);
                sigEqual = !!inferTypeParameterBindings(
                    wantedMethod,
                    actualMethod,
                    resolved.typeParameters
                );
                if (!sigEqual) {
                    sigEqual = !!inferTypeParameterBindings(
                        wantedMethod,
                        actualMethod,
                        resolved.typeParameters,
                        { loose: true }
                    );
                    matchedLoose = sigEqual;
                }
            } else if (sig === mySig) {
                sigEqual = true;
            } else if (looseSignatureEqual(sig, mySig)) {
                sigEqual = true;
                matchedLoose = true;
            }
            if (!sigEqual) return false;
            // Whole-interface satisfaction check. Use loose matching whenever the
            // anchoring method matched loosely (or the interface is external), so
            // the other methods' cross-package qualifiers do not veto a genuine
            // implementation.
            if (
                !this._interfaceSatisfiedBy(
                    resolved,
                    typeMethods,
                    typeKey && types.get(typeKey),
                    types,
                    interfaces,
                    {
                        unresolved: resolved.unresolved,
                        allowUnresolved: true,
                        loose: external || matchedLoose,
                    }
                )
            ) {
                return false;
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

        const candidates = this._interfacesByMethod.get(methodKey) || [];
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
     * versions of the same module are never returned. If the user explicitly
     * configured a dependency root, that root remains searchable for projects
     * without a go.mod; an auto-detected global cache is never scanned without
     * a resolvable lock set.
     */
    async _searchDependencyInterfaces(cacheRoot, receiverType, methodName, mySig, typeMethods, consider) {
        const dependencyDirs = this._dependencySearchDirs(cacheRoot);
        if (dependencyDirs === null) return;

        let candidates;
        try {
            candidates = await this._dependencyInterfaceCandidates(
                cacheRoot,
                methodName,
                dependencyDirs
            );
        } catch (err) {
            this.log(`Dependency search failed: ${err.message}`);
            return;
        }
        this.log(
            `Dependency search: ${candidates.length} candidate file(s)` +
                (dependencyDirs.length > 0
                    ? ` in ${dependencyDirs.length} locked module dir(s)`
                    : ` below explicitly configured root ${cacheRoot}`)
        );

        for (const file of candidates) {
            let parsed;
            try {
                if (this._isExcluded(file)) continue;
                if (!shouldIncludeGoFile(file, '', this._buildContext)) continue;
                const source = fs.readFileSync(file, 'utf8');
                if (!shouldIncludeGoFile(file, source, this._buildContext)) continue;
                parsed = await this.astPool.parseFile(file, source, 200, true);
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
     * (callers then skip dependency search).
     * @param {string} cacheRoot
     * @returns {string[]}
     */
    _resolveLockedDirState(cacheRoot) {
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
        const allDirs = [...dirs];
        return {
            lockedCount: allDirs.length,
            dirs: allDirs.filter(
                (directory) =>
                    !this._isPackageExcluded(this._importPathForDirectory(directory))
            ),
        };
    }

    _resolveLockedDirs(cacheRoot) {
        return this._resolveLockedDirState(cacheRoot).dirs;
    }

    /**
     * Return exact locked module directories, or [] to search a dependency root
     * the user explicitly configured. null means there is no safe search bound.
     * @param {string} cacheRoot
     * @returns {string[]|null}
     */
    _dependencySearchDirs(cacheRoot) {
        const resolved = this._resolveLockedDirState(cacheRoot);
        const lockedDirs = resolved.dirs;
        if (lockedDirs.length > 0) return lockedDirs;
        if (resolved.lockedCount > 0) return null;

        const configured = this.getConfig().goModCache;
        if (!configured || !configured.trim()) return null;
        try {
            return path.resolve(configured.trim()) === path.resolve(cacheRoot) ? [] : null;
        } catch (_) {
            return null;
        }
    }

    _findMethodLocation(typeKey, methodKey, mode) {
        const all = this._findMethodLocations(typeKey, methodKey, mode);
        return all.length > 0 ? all[0] : null;
    }

    /**
     * All declaration locations of `methodKey` on one package-qualified type.
     * @param {string} typeKey
     * @param {string} methodKey
     * @param {'value'|'pointer'} [mode]
     * @returns {{file:string, line:number}[]}
     */
    _findMethodLocations(typeKey, methodKey, mode) {
        if (!this._methodLocationCache) this._methodLocationCache = new Map();
        const methodMode = mode || 'pointer';
        const cacheKey = `${typeKey}\0${methodKey}\0${methodMode}`;
        const cached = this._methodLocationCache.get(cacheKey);
        if (cached) return cached;
        const methodSets = this._resolveTypeMethodSetsCached(typeKey, this._mergedTypes);
        const selectors =
            methodMode === 'value' ? methodSets.valueSelectors : methodSets.pointerSelectors;
        const selector = selectors.get(methodKey);
        let found = [];
        if (selector && selector.count === 1 && selector.kind === 'method' && selector.origin) {
            if (selector.origin.kind === 'type') {
                for (const location of this._typesByLocation.get(selector.origin.key) || []) {
                    if (!location.methods.has(methodKey)) continue;
                    const recorded = location.methodLines && location.methodLines.get(methodKey);
                    found.push({
                        file: location.file,
                        line: typeof recorded === 'number' ? recorded : location.line,
                    });
                }
            } else if (selector.origin.kind === 'interface') {
                const declaration = this._interfaceDecls.get(selector.origin.key);
                if (declaration) {
                    const recorded = declaration.methodLines && declaration.methodLines.get(methodKey);
                    found = [{
                        file: declaration.file,
                        line: typeof recorded === 'number' ? recorded : declaration.line,
                    }];
                }
            } else if (selector.origin.kind === 'builtin') {
                const declarations = (this._typesByLocation.get(typeKey) || []).filter(
                    (location) => location.declared !== false
                );
                if (declarations.length > 0) {
                    found = [{ file: declarations[0].file, line: declarations[0].line }];
                }
            }
        }
        this._methodLocationCache.set(cacheKey, found);
        return found;
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
        this._packageKeyByImportPath.clear();
        this._externalImportDirectoryCache.clear();
        this._externalPackageCache.clear();
        this._workspacePackageCache.clear();
        this._workspaceCandidateCache.clear();
        this._dependencyCandidateCache.clear();
        this._dependencyImplementationCandidateCache.clear();
        this._dependencyTypeReferenceCandidateCache.clear();
        if (this.astPool) this.astPool.clear();
        this._invalidateMerged();
        this._builds.clear();
    }

    dispose() {
        this._disposed = true;
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
        this._packageKeyByImportPath.clear();
        this._externalImportDirectoryCache.clear();
        this._externalPackageCache.clear();
        this._workspacePackageCache.clear();
        this._workspaceCandidateCache.clear();
        this._dependencyCandidateCache.clear();
        this._dependencyImplementationCandidateCache.clear();
        this._dependencyTypeReferenceCandidateCache.clear();
        this._builds.clear();
    }
}

// Window over which bursts of watcher events are coalesced into a single merged
// view invalidation.
WorkspaceIndex.INVALIDATE_DEBOUNCE_MS = 150;

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
