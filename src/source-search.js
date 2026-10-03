'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const {
    findRipgrep,
    resolveGoModCache,
    resolveRipgrepProcessConcurrency,
} = require('./search');
const { resolveLockedModuleDirs } = require('./gomod');
const { collectSearchFiles, planSearchJobs, rootBatches } = require('./source-search-plan');

const DEFAULT_MAX_RESULTS = 2000;
const DEFAULT_MAX_FILES = 1000;
const MAX_SEARCH_PROCESSES = 4;
const RESULT_BATCH_DELAY = 50;
const RESULT_BATCH_SIZE = 100;
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

function matchTextLines(text, matcher, maxMatches = Infinity) {
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
            if (matches.length >= maxMatches) break;
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

function scopeRank(scope) {
    if (scope === 'workspace') return 0;
    if (scope === 'dependency') return 1;
    if (scope === 'stdlib') return 2;
    return 3;
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
            start: byteOffsetToColumn(sourceLine, Number(submatch.start) || 0) - 1,
            end: byteOffsetToColumn(sourceLine, Number(submatch.end) || Number(submatch.start) || 0) - 1,
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
        const signal = handlers.signal;
        if (signal && signal.aborted) return reject(createCancellationError());
        let buffer = '';
        let stderr = '';
        let failure;
        let stats;
        const child = spawn(command, args, { cwd: rootInfo.root, stdio: ['ignore', 'pipe', 'pipe'] });
        const abort = () => {
            if (!child.killed) child.kill();
        };
        // Wait for close even on cancellation, so completion means the child
        // has actually exited and cannot deliver late results.
        if (signal) signal.addEventListener('abort', abort, { once: true });
        const consume = (line) => {
            if (!line || failure || (signal && signal.aborted)) return;
            let json;
            try { json = JSON.parse(line); } catch (_) { return; }
            try {
                const record = parseMatchRecord(json, rootInfo);
                if (record && handlers.onMatch) handlers.onMatch(record);
                if (json.type === 'summary') stats = json.data && json.data.stats;
            } catch (error) {
                failure = error;
                abort();
            }
        };
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            if (failure || (signal && signal.aborted)) return;
            buffer += chunk;
            let start = 0;
            let newline;
            while ((newline = buffer.indexOf('\n', start)) >= 0) {
                consume(buffer.slice(start, newline));
                start = newline + 1;
                if (failure || (signal && signal.aborted)) { buffer = ''; return; }
            }
            buffer = buffer.slice(start);
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-65536); });
        child.on('error', (error) => { failure = error; });
        child.on('close', (code) => {
            if (signal) signal.removeEventListener('abort', abort);
            consume(buffer);
            if (failure) return reject(failure);
            if (signal && signal.aborted) return reject(createCancellationError());
            if (code === 0 || code === 1) return resolve({ code, stderr, stats });
            const error = new Error(stderr.trim() || `ripgrep exited with code ${code}`);
            error.code = 'RIPGREP_FAILED';
            reject(error);
        });
    });
}

async function runSearchJobs(jobs, parallelism, controller, task) {
    const slots = Math.min(MAX_SEARCH_PROCESSES, parallelism, jobs.length);
    let next = 0;
    let failure;
    let freeThreads = parallelism;
    let active = 0;
    await Promise.all(Array.from({ length: slots }, async () => {
        while (next < jobs.length && !controller.signal.aborted) {
            const job = jobs[next++];
            const threads = Math.max(1, Math.floor(freeThreads / Math.min(slots - active, jobs.length - next + 1)));
            freeThreads -= threads;
            active++;
            try { await task(job, threads); }
            catch (error) {
                if (!controller.signal.aborted) { failure = error; controller.abort(); }
            } finally { freeThreads += threads; active--; }
        }
    }));
    if (failure) throw failure;
}

class SourceSearchService {
    constructor(options = {}) {
        this.getConfig = options.getConfig || (() => ({}));
        this.getWorkspaceRoots = options.getWorkspaceRoots || defaultWorkspaceRoots;
        this.getOpenDocuments = options.getOpenDocuments || (() => []);
        this.log = options.log || (() => {});
        this.rg = options.rg || findRipgrep() || 'rg';
        this.parallelism = Math.min(8, resolveRipgrepProcessConcurrency(options.parallelism));
        this.runRipgrep = options.runRipgrep || runRipgrepJson;
        this.collectFiles = options.collectFiles || collectSearchFiles;
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
        if (progress.signal && progress.signal.aborted) throw createCancellationError();
        const started = Date.now();
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
        const { excludedFolders } = pathPatternsFromConfig(config);
        const includeGlobs = Array.isArray(options.includeGlobs) && options.includeGlobs.length > 0
            ? options.includeGlobs
            : DEFAULT_GLOBS;
        const args = ['--json', '--line-buffered', '--color', 'never', '--line-number', '--column'];
        if (!normalizedOptions.regex) args.push('--fixed-strings');
        if (!normalizedOptions.caseSensitive) args.push('--ignore-case');
        if (normalizedOptions.wholeWord) args.push('--word-regexp');
        const fileArgs = [];
        for (const glob of includeGlobs) fileArgs.push('--glob', glob);
        for (const folder of excludedFolders) {
            if (/^[A-Za-z0-9_.*?@+-]+$/.test(folder)) fileArgs.push('--glob', `!**/${folder}/**`);
        }
        args.push('-e', query);

        const controller = new AbortController();
        const cancel = () => controller.abort();
        if (progress.signal) {
            progress.signal.addEventListener('abort', cancel, { once: true });
            if (progress.signal.aborted) cancel();
        }
        const byFile = new Map();
        const seen = new Map();
        const pending = new Map();
        const dirtyFiles = new Map();
        let totalMatches = 0;
        let truncated = false;
        let timer;
        let pendingCount = 0;
        let delivery = Promise.resolve();
        let deliveryError;
        let firstResultMs;
        const prioritizedRoots = [...roots].sort((left, right) => scopeRank(left.scope) - scopeRank(right.scope) || right.root.length - left.root.length);
        const rootsByDirectory = new Map();
        const findRoot = (file) => {
            const directory = path.dirname(file);
            if (!rootsByDirectory.has(directory)) rootsByDirectory.set(directory, prioritizedRoots.find((root) => isWithin(file, root.root)));
            return rootsByDirectory.get(directory);
        };
        const flush = () => {
            clearTimeout(timer);
            timer = undefined;
            if (!pendingCount) return;
            const batch = [...pending.values()].sort((left, right) => scopeRank(left.scope) - scopeRank(right.scope) || left.file.localeCompare(right.file));
            const info = { totalMatches, totalFiles: byFile.size, truncated };
            pending.clear();
            pendingCount = 0;
            delivery = delivery.then(async () => {
                if (deliveryError || (progress.signal && progress.signal.aborted)) return;
                if (firstResultMs === undefined) firstResultMs = Date.now() - started;
                if (progress.onBatch) await progress.onBatch(batch);
                if (progress.onProgress) await progress.onProgress(info);
            }).catch((error) => { deliveryError = error; controller.abort(); });
        };
        const onMatch = (record, unsaved = false) => {
            if (controller.signal.aborted) return;
            if (!unsaved && dirtyFiles.has(record.file)) return;
            let entry = byFile.get(record.file);
            if (!entry && (!fileMatchesConfig(record.file, config) || folderMatchesConfig(record.file, config))) return;
            if (!entry && byFile.size >= maxFiles) {
                truncated = true;
                controller.abort();
                return;
            }
            if (!entry) {
                const root = record.root;
                entry = {
                    file: record.file, relativePath: path.relative(root.root, record.file) || path.basename(record.file),
                    scope: root.scope, scopeLabel: scopeLabel(root.scope), root: root.root,
                    rootLabel: root.label, module: root.module, version: root.version,
                    ...(unsaved ? { unsaved: true } : {}), matches: [],
                };
                byFile.set(record.file, entry);
                seen.set(record.file, new Set());
            }
            const key = `${record.line}:${record.column}`;
            if (seen.get(record.file).has(key)) return;
            seen.get(record.file).add(key);
            const match = { line: record.line, column: record.column, text: record.text, ranges: record.ranges };
            entry.matches.push(match);
            totalMatches++;
            let delta = pending.get(record.file);
            if (!delta) { delta = { ...entry, matches: [] }; pending.set(record.file, delta); }
            delta.matches.push(match);
            pendingCount++;
            if (totalMatches >= maxResults) { truncated = true; controller.abort(); }
            if (pendingCount >= RESULT_BATCH_SIZE) flush();
            else if (!timer) timer = setTimeout(flush, RESULT_BATCH_DELAY);
        };
        try {
            // Snapshot dirty documents first so disk results are never shown and
            // later retracted. Apply overlays within their scope's priority.
            for (const document of this.getOpenDocuments() || []) {
                if (controller.signal.aborted) break;
                const file = normalizeAbsolute(document && document.uri && document.uri.fsPath);
                if (!file || !document.isDirty || typeof document.getText !== 'function') continue;
                const root = findRoot(file);
                if (root) dirtyFiles.set(file, { root, text: document.getText() });
            }
            const listedFiles = new Set();
            let jobCount = 0;
            let metadataMs = 0;
            // Finish workspace work before admitting dependencies to the global
            // result budget; fast dependency matches cannot crowd out the project.
            for (const scope of ['workspace', 'dependency', 'stdlib']) {
                if (controller.signal.aborted) break;
                for (const [file, overlay] of dirtyFiles) {
                    if (overlay.root.scope !== scope || controller.signal.aborted) continue;
                    for (const match of matchTextLines(overlay.text, overlayMatcher, maxResults - totalMatches)) {
                        onMatch({ ...match, file, root: overlay.root }, true);
                        if (controller.signal.aborted) break;
                    }
                }
                if (controller.signal.aborted) break;
                const scopedRoots = roots.filter((root) => root.scope === scope);
                const metadataStarted = Date.now();
                const inventory = [];
                await runSearchJobs(rootBatches(scopedRoots), this.parallelism, controller, async (batch, threads) => {
                    const files = await this.collectFiles(this.rg, ['--files', '--null', '--threads', String(threads), ...fileArgs, '--', ...batch.roots.map((root) => root.root)], batch.roots[0], {
                        signal: controller.signal,
                        includeFile: (file) => {
                            if (listedFiles.has(file) || dirtyFiles.has(file)) return false;
                            if (!fileMatchesConfig(file, config) || folderMatchesConfig(file, config)) return false;
                            listedFiles.add(file);
                            return true;
                        },
                    });
                    for (const file of files) {
                        const root = findRoot(file.file);
                        if (root) inventory.push({ ...file, root });
                    }
                });
                const elapsed = Date.now() - metadataStarted;
                metadataMs += elapsed;
                if (controller.signal.aborted) break;
                const jobs = planSearchJobs(inventory, this.parallelism);
                const packageCount = new Set(inventory.map((file) => path.dirname(file.file))).size;
                const totalBytes = inventory.reduce((sum, file) => sum + file.size, 0);
                this.log(`source search ${scope}: ${inventory.length} files, ${packageCount} packages, ${totalBytes} bytes, metadata ${elapsed} ms, ${jobs.length} tasks`);
                jobCount += jobs.length;
                // These exact files already passed rg's ignore/glob rules and
                // exclusions. Avoid re-enumerating directories for every shard.
                await runSearchJobs(jobs, this.parallelism, controller, async (job, threads) => {
                    await this.runRipgrep(this.rg, [...args, '--threads', String(threads), '--', ...job.files.map((file) => file.file)], job.files[0].root, {
                        signal: controller.signal,
                        onMatch: (record) => {
                            const root = findRoot(record.file);
                            if (root) onMatch({ ...record, root });
                        },
                    });
                });
                flush();
                await delivery;
            }
            flush();
            await delivery;
            if (deliveryError) throw deliveryError;
            if (progress.signal && progress.signal.aborted) throw createCancellationError();
            const results = [...byFile.values()].sort((left, right) => scopeRank(left.scope) - scopeRank(right.scope) || left.file.localeCompare(right.file));
            for (const entry of results) entry.matches.sort((left, right) => left.line - right.line || left.column - right.column);
            if (progress.onProgress) await progress.onProgress({ totalMatches, totalFiles: results.length, truncated });
            this.log(`source search: ${jobCount} tasks, up to ${this.parallelism} scan threads, metadata ${metadataMs} ms, first batch ${firstResultMs ?? '-'} ms, total ${Date.now() - started} ms`);
            return { query, results, totalMatches, totalFiles: results.length, truncated, roots };
        } finally {
            clearTimeout(timer);
            if (progress.signal) progress.signal.removeEventListener('abort', cancel);
            controller.abort();
            await delivery;
        }
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
    planSearchJobs,
};
