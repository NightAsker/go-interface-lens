'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const {
    findRipgrep,
    resolveGoModCache,
    splitSearchTargets,
    resolveRipgrepProcessConcurrency,
} = require('./search');
const { resolveLockedModuleDirs } = require('./gomod');

const DEFAULT_MAX_RESULTS = 2000;
const DEFAULT_MAX_FILES = 1000;
const DEFAULT_SEARCH_CONCURRENCY = Math.min(8, resolveRipgrepProcessConcurrency());
const DEFAULT_GLOBS = ['*.go', 'go.mod', 'go.sum', 'go.work', 'go.work.sum'];
let goRootPromise;

function normalizeAbsolute(value) {
    if (!value || typeof value !== 'string') return null;
    try {
        return path.normalize(path.resolve(value));
    } catch (_) {
        return null;
    }
}

function isWithin(file, root) {
    const relative = path.relative(root, file);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createMatcher(query, options) {
    if (!query) return null;
    options = options || {};
    const flags = options.caseSensitive ? 'g' : 'gi';
    let source = options.regex ? query : escapeRegExp(query);
    if (options.wholeWord) source = `\\b(?:${source})\\b`;
    try {
        return new RegExp(source, flags);
    } catch (error) {
        const wrapped = new Error(`Invalid regular expression: ${error.message}`);
        wrapped.code = 'INVALID_REGEX';
        throw wrapped;
    }
}

function matchTextLines(text, matcher) {
    const lines = text.split(/\r?\n/);
    const matches = [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        matcher.lastIndex = 0;
        const submatches = [];
        let match;
        while ((match = matcher.exec(line))) {
            submatches.push({
                start: match.index,
                end: match.index + match[0].length,
                text: match[0],
            });
            if (match[0] === '') matcher.lastIndex += 1;
        }
        if (submatches.length > 0) {
            matches.push({
                line: lineIndex + 1,
                column: submatches[0].start + 1,
                text: line,
                ranges: submatches,
            });
        }
    }
    return matches;
}

function pathPatternsFromConfig(config) {
    const excludedFiles = Array.isArray(config.sourceSearchExcludedFilePatterns)
        ? config.sourceSearchExcludedFilePatterns.filter((value) => typeof value === 'string' && value)
        : [];
    const excludedFolders = Array.isArray(config.sourceSearchExcludedFolders)
        ? config.sourceSearchExcludedFolders.filter((value) => typeof value === 'string' && value)
        : [];
    return { excludedFiles, excludedFolders };
}

function fileMatchesConfig(file, config) {
    const { excludedFiles } = pathPatternsFromConfig(config);
    const base = path.basename(file);
    return !excludedFiles.some((pattern) => base.includes(pattern));
}

function folderMatchesConfig(file, config) {
    const { excludedFolders } = pathPatternsFromConfig(config);
    let current = path.dirname(file);
    while (current && current !== path.dirname(current)) {
        const name = path.basename(current);
        if (excludedFolders.some((pattern) => {
            const source = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
            const normalizedPath = current.split(path.sep).join('/');
            return new RegExp(`^${source}$`).test(name) || new RegExp(source).test(normalizedPath);
        })) return true;
        current = path.dirname(current);
    }
    return false;
}

function scopeLabel(scope) {
    if (scope === 'dependency') return 'Dependencies';
    if (scope === 'stdlib') return 'Standard library';
    return 'Workspace';
}

function dependencyLabel(directory) {
    const base = path.basename(directory);
    return base || directory;
}

function byteOffsetToColumn(text, offset) {
    const target = Math.max(0, Number(offset) || 0);
    let bytes = 0;
    let codeUnits = 0;
    for (const character of text || '') {
        if (bytes >= target) return codeUnits + 1;
        const characterBytes = Buffer.byteLength(character, 'utf8');
        if (bytes + characterBytes > target) return codeUnits + 1;
        bytes += characterBytes;
        codeUnits += character.length;
    }
    return codeUnits + 1;
}

function defaultWorkspaceRoots() {
    try {
        // Kept lazy so the search engine remains usable in headless tests.
        // eslint-disable-next-line global-require
        const vscode = require('vscode');
        return (vscode.workspace.workspaceFolders || [])
            .map((folder) => folder && folder.uri && folder.uri.fsPath)
            .filter(Boolean);
    } catch (_) {
        return [];
    }
}

function resolveSourceRoots(options = {}) {
    const config = options.config || {};
    const scope = options.scope === 'dependencies' ? 'dependency' : (options.scope || 'all');
    const workspaceRoots = (options.workspaceRoots || defaultWorkspaceRoots())
        .map(normalizeAbsolute)
        .filter(Boolean);
    const roots = [];
    const seen = new Set();
    const add = (root) => {
        const normalized = normalizeAbsolute(root.root || root);
        if (!normalized || seen.has(normalized)) return;
        try {
            if (!fs.statSync(normalized).isDirectory()) return;
        } catch (_) {
            return;
        }
        seen.add(normalized);
        roots.push({
            root: normalized,
            scope: root.scope || 'workspace',
            label: root.label || path.basename(normalized) || normalized,
            module: root.module || null,
            version: root.version || null,
        });
    };

    if (scope === 'all' || scope === 'workspace') {
        for (const root of workspaceRoots) add({ root, scope: 'workspace', label: path.basename(root) });
    }

    const includeDependencies = scope === 'all' || scope === 'dependency';
    if (includeDependencies && config.searchDependencies !== false) {
        const modCache = resolveGoModCache(config.goModCache);
        for (const workspaceRoot of workspaceRoots) {
            let resolved;
            try {
                resolved = resolveLockedModuleDirs(workspaceRoot, modCache);
            } catch (_) {
                resolved = { dirs: [] };
            }
            for (const directory of resolved.dirs || []) {
                add({
                    root: directory,
                    scope: 'dependency',
                    label: dependencyLabel(directory),
                });
            }
            if ((!resolved.goModPath || resolved.goModPath === null) && resolved.dirs.length === 0 && modCache) {
                add({ root: modCache, scope: 'dependency', label: 'Go module cache' });
            }
        }
    }

    if (scope === 'stdlib' && options.stdlibRoot) {
        add({ root: options.stdlibRoot, scope: 'stdlib', label: 'GOROOT' });
    }
    return roots;
}

function resolveGoRoot() {
    if (process.env.GOROOT) return Promise.resolve(normalizeAbsolute(process.env.GOROOT));
    if (goRootPromise) return goRootPromise;
    goRootPromise = new Promise((resolve) => {
        execFile('go', ['env', 'GOROOT'], { timeout: 3000 }, (error, stdout) => {
            if (error) return resolve(null);
            resolve(normalizeAbsolute(String(stdout || '').trim()));
        });
    });
    return goRootPromise;
}

function parseMatchRecord(record, rootInfo) {
    if (!record || record.type !== 'match' || !record.data) return null;
    const data = record.data;
    const file = normalizeAbsolute(data.path && data.path.text);
    if (!file) return null;
    const line = data.lines && typeof data.lines.text === 'string' ? data.lines.text.replace(/\r?\n$/, '') : '';
    const sourceLine = line;
    return {
        file,
        line: Number.isInteger(data.line_number) ? data.line_number : 1,
        column: Number.isInteger(data.submatches && data.submatches[0] && data.submatches[0].start)
            ? byteOffsetToColumn(sourceLine, data.submatches[0].start)
            : 1,
        text: line,
        ranges: (data.submatches || []).map((submatch) => ({
            start: Number(submatch.start) || 0,
            end: Number(submatch.end) || Number(submatch.start) || 0,
            text: submatch.match && submatch.match.text ? submatch.match.text : '',
        })),
        root: rootInfo,
    };
}

function createCancellationError() {
    const error = new Error('Search cancelled');
    error.code = 'SEARCH_CANCELLED';
    return error;
}

function runRipgrepJson(command, args, rootInfo, handlers = {}) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let buffer = '';
        let child;
        const signal = handlers.signal;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            if (signal && signal.removeEventListener) signal.removeEventListener('abort', abort);
            if (error) reject(error);
            else resolve(value);
        };
        const abort = () => {
            if (child && !child.killed) child.kill();
            finish(createCancellationError());
        };
        if (signal && signal.aborted) return abort();
        try {
            child = spawn(command, args, { cwd: rootInfo.root, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
            return finish(error);
        }
        if (signal && signal.addEventListener) signal.addEventListener('abort', abort, { once: true });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            buffer += chunk;
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                if (!line) continue;
                try {
                    const record = parseMatchRecord(JSON.parse(line), rootInfo);
                    if (record && handlers.onMatch) handlers.onMatch(record);
                } catch (_) {
                    // ripgrep output is line-delimited JSON; ignore incomplete or
                    // unsupported records while preserving the rest of the search.
                }
            }
        });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('error', (error) => finish(error));
        child.on('close', (code, signalName) => {
            if (buffer.trim()) {
                try {
                    const record = parseMatchRecord(JSON.parse(buffer.trim()), rootInfo);
                    if (record && handlers.onMatch) handlers.onMatch(record);
                } catch (_) {
                    // Ignore a trailing incomplete record.
                }
            }
            if (settled) return;
            if (signalName && signal && signal.aborted) return finish(createCancellationError());
            if (code === 0 || code === 1) return finish(null, { code, stderr });
            const error = new Error(stderr.trim() || `ripgrep exited with code ${code}`);
            error.code = 'RIPGREP_FAILED';
            finish(error);
        });
    });
}

function runWithConcurrency(values, concurrency, task) {
    const items = [...values];
    if (items.length === 0) return Promise.resolve([]);
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await task(items[index], index);
        }
    });
    return Promise.all(workers).then(() => results);
}

class SourceSearchService {
    constructor(options = {}) {
        this.getConfig = options.getConfig || (() => ({}));
        this.getWorkspaceRoots = options.getWorkspaceRoots || defaultWorkspaceRoots;
        this.getOpenDocuments = options.getOpenDocuments || (() => []);
        this.log = options.log || (() => {});
        this.rg = options.rg || findRipgrep() || 'rg';
    }

    resolveRoots(options = {}) {
        const config = { ...this.getConfig(), ...(options.config || {}) };
        return resolveSourceRoots({
            ...options,
            config,
            workspaceRoots: options.workspaceRoots || this.getWorkspaceRoots(),
        });
    }

    async search(options = {}, progress = {}) {
        const query = typeof options.query === 'string' ? options.query : '';
        if (!query.trim()) return { query, results: [], totalMatches: 0, totalFiles: 0, truncated: false, roots: [] };
        const config = { ...this.getConfig(), ...(options.config || {}) };
        const normalizedOptions = {
            regex: !!options.regex,
            caseSensitive: !!options.caseSensitive,
            wholeWord: !!options.wholeWord,
        };
        // Validate before spawning any process so the UI gets a direct error.
        const overlayMatcher = createMatcher(query, normalizedOptions);
        let stdlibRoot = options.stdlibRoot;
        if ((options.scope || 'all') === 'stdlib' && !stdlibRoot) stdlibRoot = await resolveGoRoot();
        const roots = this.resolveRoots({ ...options, config, stdlibRoot });
        const maxResults = Math.max(
            1,
            Number(options.maxResults) || Number(config.sourceSearchMaxResults) || DEFAULT_MAX_RESULTS
        );
        const maxFiles = Math.max(
            1,
            Number(options.maxFiles) || Number(config.sourceSearchMaxFiles) || DEFAULT_MAX_FILES
        );
        const { excludedFiles, excludedFolders } = pathPatternsFromConfig(config);
        const includeGlobs = Array.isArray(options.includeGlobs) && options.includeGlobs.length > 0
            ? options.includeGlobs
            : DEFAULT_GLOBS;
        const args = ['--json', '--color', 'never', '--line-number', '--column'];
        if (!normalizedOptions.regex) args.push('--fixed-strings');
        if (!normalizedOptions.caseSensitive) args.push('--ignore-case');
        if (normalizedOptions.wholeWord) args.push('--word-regexp');
        for (const glob of includeGlobs) args.push('--glob', glob);
        for (const folder of excludedFolders) {
            if (/^[A-Za-z0-9_.*?@+-]+$/.test(folder)) args.push('--glob', `!**/${folder}/**`);
        }
        args.push('-e', query, '--');

        const byFile = new Map();
        let totalMatches = 0;
        let truncated = false;
        const onMatch = (record) => {
            if (!fileMatchesConfig(record.file, config) || folderMatchesConfig(record.file, config)) return;
            if (totalMatches >= maxResults) {
                truncated = true;
                return;
            }
            let entry = byFile.get(record.file);
            if (!entry) {
                if (byFile.size >= maxFiles) {
                    truncated = true;
                    return;
                }
                const root = record.root;
                entry = {
                    file: record.file,
                    relativePath: path.relative(root.root, record.file) || path.basename(record.file),
                    scope: root.scope,
                    scopeLabel: scopeLabel(root.scope),
                    root: root.root,
                    rootLabel: root.label,
                    module: root.module,
                    version: root.version,
                    matches: [],
                };
                byFile.set(record.file, entry);
            }
            if (entry.matches.length >= maxResults) {
                truncated = true;
                return;
            }
            entry.matches.push({
                line: record.line,
                column: record.column,
                text: record.text,
                ranges: record.ranges,
            });
            totalMatches++;
            if (totalMatches >= maxResults) truncated = true;
        };

        const groups = splitSearchTargets(roots.map((root) => root.root), Math.min(16, DEFAULT_SEARCH_CONCURRENCY));
        const rootByPath = new Map(roots.map((root) => [root.root, root]));
        const findRoot = (file) => {
            let best = null;
            for (const root of roots) {
                if (isWithin(file, root.root) && (!best || root.root.length > best.root.length)) best = root;
            }
            return best;
        };
        await runWithConcurrency(groups, DEFAULT_SEARCH_CONCURRENCY, async (group) => {
            if (progress.signal && progress.signal.aborted) throw createCancellationError();
            const targetRoot = findRoot(group[0]);
            if (!targetRoot) return;
            const scopedArgs = [...args, ...group];
            await runRipgrepJson(this.rg, scopedArgs, targetRoot, {
                signal: progress.signal,
                onMatch: (record) => {
                    const actualRoot = findRoot(record.file) || rootByPath.get(group[0]);
                    if (actualRoot) onMatch({ ...record, root: actualRoot });
                },
            });
        });

        const overlays = this.getOpenDocuments() || [];
        const dirtyFiles = new Set();
        for (const document of overlays) {
            const file = normalizeAbsolute(document && document.uri && document.uri.fsPath);
            if (!file || !document.isDirty || typeof document.getText !== 'function') continue;
            const root = findRoot(file);
            if (!root) continue;
            dirtyFiles.add(file);
            byFile.delete(file);
            const matches = matchTextLines(document.getText(), overlayMatcher);
            if (matches.length === 0) continue;
            byFile.set(file, {
                file,
                relativePath: path.relative(root.root, file) || path.basename(file),
                scope: root.scope,
                scopeLabel: scopeLabel(root.scope),
                root: root.root,
                rootLabel: root.label,
                module: root.module,
                version: root.version,
                unsaved: true,
                matches: matches.slice(0, Math.max(0, maxResults - totalMatches)),
            });
        }
        if (dirtyFiles.size > 0) {
            totalMatches = [...byFile.values()].reduce((sum, file) => sum + file.matches.length, 0);
        }

        const results = [...byFile.values()]
            .filter((entry) => entry.matches.length > 0)
            .sort((left, right) => left.file.localeCompare(right.file));
        const batches = [];
        for (let index = 0; index < results.length; index += 50) batches.push(results.slice(index, index + 50));
        if (typeof progress.onBatch === 'function') {
            for (const batch of batches) await progress.onBatch(batch);
        }
        if (typeof progress.onProgress === 'function') {
            await progress.onProgress({ totalMatches, totalFiles: results.length, truncated });
        }
        return {
            query,
            results,
            totalMatches,
            totalFiles: results.length,
            truncated,
            roots,
        };
    }
}

module.exports = {
    DEFAULT_GLOBS,
    DEFAULT_MAX_FILES,
    DEFAULT_MAX_RESULTS,
    SourceSearchService,
    createMatcher,
    matchTextLines,
    resolveSourceRoots,
    runRipgrepJson,
};
