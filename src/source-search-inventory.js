'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const STAT_CONCURRENCY = 16;
const IGNORE_FILES = new Set(['.gitignore', '.ignore', '.rgignore']);

function isWithin(file, root) {
    const relative = path.relative(root, file);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function cancelled() {
    return Object.assign(new Error('Search cancelled'), { code: 'SEARCH_CANCELLED' });
}

function waitFor(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
        const abort = () => reject(cancelled());
        signal.addEventListener('abort', abort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

/** Watch source trees, their parent ignore files, and common global ignore inputs. */
function watchSourceRoots(roots, notify) {
    if (!roots.length) return null;
    let vscode;
    try { vscode = require('vscode'); } catch (_) { return null; }
    if (!vscode.RelativePattern || !vscode.workspace?.createFileSystemWatcher) return null;
    const subscriptions = [];
    const watched = new Set();
    const probedGitConfigs = new Set();
    const dispose = () => { for (const subscription of subscriptions.splice(0)) subscription?.dispose(); };
    const add = (directory, pattern, control = false, onlyFile) => {
        const key = JSON.stringify([directory, pattern, onlyFile]);
        if (watched.has(key)) return;
        watched.add(key);
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(directory, pattern));
        subscriptions.push(watcher);
        for (const [event, type] of [['onDidCreate', 'create'], ['onDidChange', 'change'], ['onDidDelete', 'delete']]) {
            subscriptions.push(watcher[event]((uri) => {
                if (onlyFile && path.resolve(uri.fsPath) !== onlyFile) return;
                notify({ type: control === true ? 'invalidate' : control || type, file: uri.fsPath });
            }));
        }
    };
    const addFile = (file, type) => {
        // Filter exact paths in the callback so glob characters in a configured
        // filename are treated literally. This parent watcher is non-recursive.
        file = path.resolve(file);
        add(path.dirname(file), '*', type, file);
    };
    const watchGitDirectory = (directory) => {
        if (fs.existsSync(path.join(directory, 'info'))) add(path.join(directory, 'info'), 'exclude', true);
        add(directory, '{config,config.worktree,commondir,HEAD}', 'reconfigure');
    };
    try {
        for (const root of roots) {
            add(root, '**/*');
            let repository;
            for (let directory = root; ; directory = path.dirname(directory)) {
                // Exact names keep ancestor watchers non-recursive, even at /.
                add(directory, '{.gitignore,.ignore,.rgignore}', true);
                try {
                    let gitDirectory = path.join(directory, '.git');
                    const stat = fs.statSync(gitDirectory);
                    if (stat.isFile()) {
                        const match = fs.readFileSync(gitDirectory, 'utf8').match(/^gitdir:\s*(.+)/m);
                        if (match) gitDirectory = path.resolve(directory, match[1].trim());
                        addFile(path.join(directory, '.git'), 'reconfigure');
                    }
                    repository ||= directory;
                    watchGitDirectory(gitDirectory);
                    const common = path.join(gitDirectory, 'commondir');
                    if (fs.existsSync(common)) watchGitDirectory(path.resolve(gitDirectory, fs.readFileSync(common, 'utf8').trim()));
                } catch (_) { /* Most ancestors are not Git repositories. */ }
                if (directory === path.dirname(directory)) break;
            }
            const context = repository || 'global';
            if (!probedGitConfigs.has(context)) {
                probedGitConfigs.add(context);
                // Read only this setting, never the full Git configuration.
                // Git resolves include files, worktree configuration and ~ paths.
                try {
                    const args = ['config', ...(!repository ? ['--global'] : []), '--null', '--show-origin', '--path', '--get', 'core.excludesfile'];
                    const fields = execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000, windowsHide: true }).split('\0');
                    if (fields[0].startsWith('file:')) addFile(path.resolve(root, fields[0].slice(5)), 'reconfigure');
                    if (fields[1]) addFile(path.resolve(root, fields[1]), 'invalidate');
                } catch (_) { /* Git and custom global ignore files are optional. */ }
            }
        }
        const home = os.homedir();
        const gitConfigHome = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'git');
        add(home, '.gitconfig', 'reconfigure');
        add(home, '.gitignore_global', true);
        add(gitConfigHome, 'config', 'reconfigure');
        add(gitConfigHome, 'ignore', true);
        addFile(process.env.GIT_CONFIG_SYSTEM || '/etc/gitconfig', 'reconfigure');
        for (const file of [process.env.GIT_CONFIG_GLOBAL, process.env.GIT_CONFIG]) {
            if (file) addFile(file, 'reconfigure');
        }
        if (process.env.RIPGREP_CONFIG_PATH) {
            addFile(process.env.RIPGREP_CONFIG_PATH, 'invalidate');
        }
        return { dispose };
    } catch (error) {
        dispose();
        throw error;
    }
}

/** A single filter/root configuration, with independent inventories per rg batch. */
class SourceSearchInventory {
    constructor(options) {
        this.collectFiles = options.collectFiles;
        this.statFile = options.statFile || fs.promises.stat;
        this.watchRoots = options.watchRoots || watchSourceRoots;
        this.log = options.log || (() => {});
        this.state = null;
    }

    prepare(key, roots) {
        if (this.state?.key === key) return this.state;
        this.clear();
        const state = { key, live: true, entries: new Map(), roots, watchers: new Map(), failedWatches: new Set() };
        this.state = state;
        return state;
    }

    _watch(state, roots) {
        state.watchPaths ||= typeof state.roots === 'function' ? state.roots() : state.roots;
        let covered = true;
        for (const root of new Set(roots.map((root) => state.watchPaths.find((base) => isWithin(root, base))))) {
            if (!root) { covered = false; continue; }
            if (!state.watchers.has(root) && !state.failedWatches.has(root)) {
                try {
                    const watcher = this.watchRoots([root], (event) => this._notify(state, event));
                    if (typeof watcher?.dispose === 'function') state.watchers.set(root, watcher);
                    else state.failedWatches.add(root);
                } catch (error) {
                    state.failedWatches.add(root);
                    this.log(`source search inventory watcher unavailable: ${error.message || error}`);
                }
            }
            if (state.failedWatches.has(root)) covered = false;
        }
        return covered;
    }

    notify(event) {
        if (this.state) this._notify(this.state, event);
    }

    _notify(state, event) {
        if (!state.live) return;
        if (event.type === 'reconfigure') { this.clear(); return; }
        const file = event.file && path.resolve(event.file);
        const control = event.type === 'invalidate' || !file || IGNORE_FILES.has(path.basename(file))
            || file.split(path.sep).slice(-3).join('/') === '.git/info/exclude';
        for (const entry of state.entries.values()) {
            if (control) {
                entry.listVersion++;
                if (!file) entry.fullVersion++;
                continue;
            }
            if (!entry.roots.some((root) => isWithin(file, root) || isWithin(root, file))) continue;
            if (event.type === 'create') entry.listVersion++;
            // Changes to ignored/unselected files cannot affect this manifest.
            if (event.type === 'change' && !entry.files.has(file) && entry.initialized && !entry.pending) continue;
            entry.changes.set(file, { type: event.type, version: ++entry.version });
        }
    }

    async get(state, command, args, rootInfo, options) {
        if (options.signal?.aborted) throw cancelled();
        const roots = args.slice(args.indexOf('--') + 1);
        // Register coverage before enumeration, and only for admitted scopes.
        // A workspace query that hits its limit never starts a cache-tree watcher.
        if (!state.live || !this._watch(state, roots)) {
            // Headless hosts without file watching retain fresh enumeration.
            return this.collectFiles(command, args, rootInfo, { ...options, statFile: this.statFile });
        }
        const key = JSON.stringify(roots);
        let entry = state.entries.get(key);
        if (!entry) {
            entry = {
                roots, files: new Map(), directories: new Set(), changes: new Map(), version: 0,
                listVersion: 1, listedVersion: 0, fullVersion: 0, checkedFullVersion: 0,
                initialized: false, pending: null,
            };
            state.entries.set(key, entry);
        }
        while (true) {
            if (options.signal?.aborted) throw cancelled();
            if (entry.pending) {
                try { await waitFor(entry.pending, options.signal); }
                catch (error) {
                    // A newer query can retry a build cancelled by its owner.
                    if (error.code !== 'SEARCH_CANCELLED' || options.signal?.aborted) throw error;
                }
                continue;
            }
            if (entry.initialized && (!state.live || (entry.listedVersion === entry.listVersion && !entry.changes.size))) {
                return [...entry.files.values()];
            }
            const pending = this._refresh(entry, command, args, rootInfo, options)
                .finally(() => { if (entry.pending === pending) entry.pending = null; });
            entry.pending = pending;
            await waitFor(pending, options.signal);
        }
    }

    async _refresh(entry, command, args, rootInfo, options) {
        const changes = new Map(entry.changes);
        const listVersion = entry.listVersion;
        const fullVersion = entry.fullVersion;
        const files = new Map(entry.files);
        let statCount = 0;
        const statFile = (file) => { statCount++; return this.statFile(file); };
        for (const [file, change] of changes) {
            if (change.type !== 'delete') continue;
            files.delete(file);
            if (entry.directories.has(file)) {
                for (const candidate of files.keys()) if (isWithin(candidate, file)) files.delete(candidate);
            }
        }
        const enumerate = !entry.initialized || entry.listedVersion !== listVersion;
        if (enumerate) {
            const seen = new Set();
            const listed = await this.collectFiles(command, args, rootInfo, {
                signal: options.signal,
                includeFile: (file) => {
                    if (seen.has(file) || (options.includeFile && !options.includeFile(file))) return false;
                    seen.add(file);
                    return true;
                },
                statFile: (file) => {
                    const cached = files.get(file);
                    if (cached && !changes.has(file) && fullVersion === entry.checkedFullVersion) {
                        return { size: cached.size, isFile: () => true };
                    }
                    return statFile(file);
                },
            });
            files.clear();
            for (const item of listed) files.set(item.file, item);
        } else {
            const modified = [...changes].filter(([file, change]) => change.type !== 'delete' && files.has(file));
            let next = 0;
            let failure;
            await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, modified.length) }, async () => {
                while (next < modified.length && !options.signal?.aborted && !failure) {
                    const [file] = modified[next++];
                    try {
                        const stat = await statFile(file);
                        if (stat.isFile()) files.set(file, { file, size: stat.size });
                        else { files.delete(file); entry.listVersion++; }
                    } catch (error) {
                        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') files.delete(file);
                        else failure = error;
                    }
                }
            }));
            if (failure) throw failure;
        }
        if (options.signal?.aborted) throw cancelled();
        // Publish atomically. Events received during I/O stay pending for the
        // next pass, rather than being erased by this older snapshot.
        entry.files = files;
        entry.initialized = true;
        entry.listedVersion = listVersion;
        entry.checkedFullVersion = fullVersion;
        for (const [file, change] of changes) {
            if (entry.changes.get(file)?.version === change.version) entry.changes.delete(file);
        }
        if (enumerate) {
            entry.directories.clear();
            for (const file of files.keys()) {
                for (let directory = path.dirname(file); !entry.directories.has(directory); directory = path.dirname(directory)) {
                    entry.directories.add(directory);
                    if (directory === path.dirname(directory)) break;
                }
            }
        }
        this.log(`source search inventory: ${enumerate ? 'enumerated' : 'updated'} ${files.size} files, read ${statCount} sizes`);
    }

    clear() {
        if (!this.state) return;
        this.state.live = false;
        for (const watcher of this.state.watchers.values()) watcher.dispose();
        this.state = null;
    }

    dispose() { this.clear(); }
}

module.exports = { SourceSearchInventory, watchSourceRoots };
