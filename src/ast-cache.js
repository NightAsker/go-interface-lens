'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { Worker } = require('worker_threads');
const { deserializeParsedFile } = require('./ast');

const CACHE_SCHEMA = 8;
const DEFAULT_AST_CONCURRENCY = 16;
const MAX_AST_CONCURRENCY = 32;
const DEFAULT_WARM_CONCURRENCY = 4;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MEMORY_CACHE_ENTRIES = 512;
const DEFAULT_DISK_CACHE_ENTRIES = 4096;
const DEFAULT_DISK_CACHE_BYTES = 256 * 1024 * 1024;
const CACHE_WRITE_CONCURRENCY = 8;

function availableParallelism() {
    if (typeof os.availableParallelism === 'function') return os.availableParallelism();
    return Math.max(1, (os.cpus() || []).length);
}

class AstWorkerPool {
    constructor(options) {
        const opts = options || {};
        const requested = Number.isFinite(opts.concurrency)
            ? Math.trunc(opts.concurrency)
            : DEFAULT_AST_CONCURRENCY;
        this.concurrency = Math.max(1, Math.min(MAX_AST_CONCURRENCY, requested));
        const requestedWarmConcurrency = Number.isFinite(opts.warmConcurrency)
            ? Math.trunc(opts.warmConcurrency)
            : DEFAULT_WARM_CONCURRENCY;
        this.warmConcurrency = Math.max(
            1,
            Math.min(this.concurrency, requestedWarmConcurrency)
        );
        const parallelism = Number.isFinite(opts.parallelism)
            ? Math.max(1, Math.trunc(opts.parallelism))
            : availableParallelism();
        // WASM workers each own a parser runtime. Leaving headroom for the
        // extension host and OS is faster than saturating every logical CPU,
        // especially while new workers are compiling their WASM modules.
        this.effectiveConcurrency = Math.max(
            this.warmConcurrency,
            Math.min(this.concurrency, Math.max(1, Math.floor((parallelism * 2) / 3)))
        );
        this.idleTimeoutMs = Number.isFinite(opts.idleTimeoutMs)
            ? Math.max(0, Math.trunc(opts.idleTimeoutMs))
            : DEFAULT_IDLE_TIMEOUT_MS;
        this.maxMemoryEntries = Number.isFinite(opts.maxMemoryEntries)
            ? Math.max(1, Math.trunc(opts.maxMemoryEntries))
            : DEFAULT_MEMORY_CACHE_ENTRIES;
        this.maxDiskEntries = Number.isFinite(opts.maxDiskEntries)
            ? Math.max(1, Math.trunc(opts.maxDiskEntries))
            : DEFAULT_DISK_CACHE_ENTRIES;
        this.maxDiskBytes = Number.isFinite(opts.maxDiskBytes)
            ? Math.max(1, Math.trunc(opts.maxDiskBytes))
            : DEFAULT_DISK_CACHE_BYTES;
        this.cacheDir = opts.cacheDir || '';
        this.log = opts.log || (() => {});
        this.astCacheDir = this.cacheDir
            ? path.join(this.cacheDir, `ast-cache-v${CACHE_SCHEMA}`)
            : '';
        this.cacheFile = this.astCacheDir ? path.join(this.astCacheDir, 'index.json') : '';
        this.memory = new Map();
        this.overlays = new Map();
        this.persisted = new Map();
        this.persistedBytes = 0;
        this.pendingWrites = new Map();
        this.pendingDeletes = new Set();
        this.manifestDirty = false;
        this.flushPromise = null;
        this.inflight = new Map();
        this.loaded = false;
        this.loadPromise = null;
        this.workers = [];
        this.queue = [];
        this.nextJobID = 1;
        this.nextSequence = 1;
        this.generation = 1;
        this.writeTimer = null;
        this.shrinkTimer = null;
        this.disposed = false;
        this.stats = {
            parsed: 0,
            memoryHits: 0,
            diskHits: 0,
            active: 0,
            maxActive: 0,
            maxWorkers: 0,
        };
    }

    async _load() {
        if (this.loaded) return;
        if (this.loadPromise) return this.loadPromise;
        this.loadPromise = (async () => {
            if (!this.cacheFile) {
                this.loaded = true;
                return;
            }
            try {
                const payload = JSON.parse(await fs.promises.readFile(this.cacheFile, 'utf8'));
                if (payload.schema === CACHE_SCHEMA && Array.isArray(payload.files)) {
                    this.persisted = new Map(
                        payload.files.filter(
                            (item) =>
                                Array.isArray(item) &&
                                typeof item[0] === 'string' &&
                                item[1] &&
                                typeof item[1].key === 'string'
                        )
                    );
                    this.persistedBytes = [...this.persisted.values()].reduce(
                        (total, entry) => total + (Number.isFinite(entry.bytes) ? entry.bytes : 0),
                        0
                    );
                    this._trimPersisted();
                }
            } catch (err) {
                if (err.code !== 'ENOENT') this.log(`AST cache load failed: ${err.message}`);
            }
            this.loaded = true;
            if (this.manifestDirty) this._scheduleWrite();
        })();
        return this.loadPromise;
    }

    _cacheKey(file) {
        return crypto.createHash('sha1').update(path.normalize(file)).digest('hex');
    }

    _cacheShardFile(key) {
        return path.join(this.astCacheDir, `${key}.json`);
    }

    _rememberMemory(file, value) {
        this.memory.delete(file);
        this.memory.set(file, value);
        while (this.memory.size > this.maxMemoryEntries) {
            this.memory.delete(this.memory.keys().next().value);
        }
    }

    _deletePersisted(file) {
        const entry = this.persisted.get(file);
        if (!entry) return false;
        this.persisted.delete(file);
        this.persistedBytes = Math.max(0, this.persistedBytes - (entry.bytes || 0));
        this.pendingWrites.delete(file);
        this.pendingDeletes.add(entry.key);
        this.manifestDirty = true;
        return true;
    }

    _trimPersisted() {
        while (
            this.persisted.size > this.maxDiskEntries ||
            this.persistedBytes > this.maxDiskBytes
        ) {
            const oldest = this.persisted.keys().next().value;
            if (oldest === undefined) break;
            this._deletePersisted(oldest);
        }
    }

    _setPersisted(file, stat, serialized) {
        const normalized = path.normalize(file);
        const existing = this.persisted.get(normalized);
        if (existing) {
            this.persisted.delete(normalized);
            this.persistedBytes = Math.max(0, this.persistedBytes - (existing.bytes || 0));
        }
        const entry = {
            key: existing ? existing.key : this._cacheKey(normalized),
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            bytes: Buffer.byteLength(JSON.stringify(serialized)),
        };
        this.persisted.set(normalized, entry);
        this.persistedBytes += entry.bytes;
        this.pendingDeletes.delete(entry.key);
        this.pendingWrites.set(normalized, { entry, parsed: serialized });
        this.manifestDirty = true;
        this._trimPersisted();
    }

    async _readPersisted(file, entry) {
        try {
            const payload = JSON.parse(await fs.promises.readFile(this._cacheShardFile(entry.key), 'utf8'));
            if (
                payload.schema !== CACHE_SCHEMA ||
                path.normalize(payload.file || '') !== path.normalize(file) ||
                payload.mtimeMs !== entry.mtimeMs ||
                payload.size !== entry.size
            ) {
                throw new Error('AST cache shard metadata mismatch');
            }
            return payload.parsed;
        } catch (err) {
            this._deletePersisted(path.normalize(file));
            this._scheduleWrite();
            if (err.code !== 'ENOENT') this.log(`AST cache shard load failed: ${err.message}`);
            return null;
        }
    }

    _ensureWorkers(target) {
        if (this.disposed) return;
        const desired = Math.max(
            0,
            Math.min(this.concurrency, target === undefined ? this.warmConcurrency : target)
        );
        while (this.workers.length < desired) this._spawnWorker();
    }

    _desiredWorkerCount() {
        return Math.min(
            this.effectiveConcurrency,
            Math.max(this.warmConcurrency, this.stats.active + this.queue.length)
        );
    }

    _cancelShrink() {
        if (!this.shrinkTimer) return;
        clearTimeout(this.shrinkTimer);
        this.shrinkTimer = null;
    }

    _scheduleShrink() {
        if (
            this.disposed ||
            this.shrinkTimer ||
            this.stats.active !== 0 ||
            this.queue.length !== 0 ||
            this.workers.length <= this.warmConcurrency
        ) {
            return;
        }
        this.shrinkTimer = setTimeout(() => {
            this.shrinkTimer = null;
            this._shrinkIdleWorkers();
        }, this.idleTimeoutMs);
        if (typeof this.shrinkTimer.unref === 'function') this.shrinkTimer.unref();
    }

    _shrinkIdleWorkers() {
        if (this.disposed || this.stats.active !== 0 || this.queue.length !== 0) return;
        const retiring = this.workers.slice(this.warmConcurrency);
        this.workers = this.workers.slice(0, this.warmConcurrency);
        for (const state of retiring) {
            state.retiring = true;
            if (!state.ready) state.resolveReady(false);
            state.worker.terminate();
        }
    }

    _spawnWorker() {
        let resolveReady;
        const readyPromise = new Promise((resolve) => {
            resolveReady = resolve;
        });
        const state = {
            worker: null,
            busy: false,
            job: null,
            failed: false,
            retiring: false,
            ready: false,
            readyPromise,
            resolveReady,
        };
        const worker = new Worker(path.join(__dirname, 'ast-worker.js'));
        state.worker = worker;
        worker.on('message', (message) => {
            if (message && message.type === 'ready') {
                if (!state.ready) {
                    state.ready = true;
                    state.resolveReady(true);
                }
                return;
            }
            this._finishWorkerJob(state, message);
        });
        worker.on('error', (err) => this._workerFailed(state, err));
        worker.on('exit', (code) => {
            if (!this.disposed && !state.retiring && code !== 0) {
                this._workerFailed(state, new Error(`AST worker exited with code ${code}`));
            }
        });
        this.workers.push(state);
        this.stats.maxWorkers = Math.max(this.stats.maxWorkers, this.workers.length);
    }

    _workerFailed(state, err) {
        if (state.failed || state.retiring) return;
        state.failed = true;
        if (!state.ready) state.resolveReady(false);
        const index = this.workers.indexOf(state);
        if (index >= 0) this.workers.splice(index, 1);
        if (state.job) {
            this.stats.active = Math.max(0, this.stats.active - 1);
            state.job.reject(err);
        }
        state.job = null;
        state.busy = false;
        if (!this.disposed) this._ensureWorkers(this._desiredWorkerCount());
        this._dispatch();
    }

    /** Start parser workers and wait until their modules are loaded. */
    async warmup() {
        if (this.disposed) return 0;
        for (let attempt = 0; attempt < 3; attempt++) {
            const target = Math.max(this.warmConcurrency, this.workers.length);
            this._ensureWorkers(target);
            const snapshot = [...this.workers];
            await Promise.all(snapshot.map((state) => state.readyPromise));
            const ready = this.workers.filter((state) => state.ready && !state.failed).length;
            if (ready >= Math.min(this.concurrency, target) || this.disposed) return ready;
        }
        return this.workers.filter((state) => state.ready && !state.failed).length;
    }

    _jobPrecedes(left, right) {
        return (
            left.priority > right.priority ||
            (left.priority === right.priority && left.sequence < right.sequence)
        );
    }

    _enqueue(job) {
        this.queue.push(job);
        let index = this.queue.length - 1;
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (this._jobPrecedes(this.queue[parent], this.queue[index])) break;
            [this.queue[parent], this.queue[index]] = [this.queue[index], this.queue[parent]];
            index = parent;
        }
    }

    _dequeue() {
        if (this.queue.length === 0) return null;
        const first = this.queue[0];
        const last = this.queue.pop();
        if (this.queue.length > 0) {
            this.queue[0] = last;
            let index = 0;
            while (true) {
                const left = index * 2 + 1;
                const right = left + 1;
                let best = index;
                if (
                    left < this.queue.length &&
                    this._jobPrecedes(this.queue[left], this.queue[best])
                ) {
                    best = left;
                }
                if (
                    right < this.queue.length &&
                    this._jobPrecedes(this.queue[right], this.queue[best])
                ) {
                    best = right;
                }
                if (best === index) break;
                [this.queue[index], this.queue[best]] = [this.queue[best], this.queue[index]];
                index = best;
            }
        }
        return first;
    }

    _finishWorkerJob(state, message) {
        const job = state.job;
        if (!job || job.id !== message.id) return;
        state.job = null;
        state.busy = false;
        this.stats.active = Math.max(0, this.stats.active - 1);
        if (message.error) {
            const err = new Error(message.error.message);
            err.code = message.error.code;
            job.reject(err);
        } else {
            job.resolve(message.parsed);
        }
        this._dispatch();
    }

    _dispatch() {
        if (this.disposed) return;
        for (const state of this.workers) {
            if (state.busy || this.queue.length === 0) continue;
            const job = this._dequeue();
            state.busy = true;
            state.job = job;
            this.stats.active += 1;
            this.stats.maxActive = Math.max(this.stats.maxActive, this.stats.active);
            state.worker.postMessage({ id: job.id, file: job.file, text: job.text });
        }
        this._scheduleShrink();
    }

    _run(file, text, priority) {
        if (this.disposed) return Promise.reject(new Error('AST worker pool is disposed'));
        this._cancelShrink();
        return new Promise((resolve, reject) => {
            this._enqueue({
                id: this.nextJobID++,
                sequence: this.nextSequence++,
                priority: priority || 0,
                file,
                text,
                resolve,
                reject,
            });
            this._ensureWorkers(this._desiredWorkerCount());
            this._dispatch();
        });
    }

    parseFile(file, text, priority) {
        const overlayHash =
            text === undefined
                ? 'disk'
                : crypto.createHash('sha1').update(text).digest('hex');
        const key = `${file}\0${overlayHash}`;
        if (this.inflight.has(key)) return this.inflight.get(key);
        let request;
        request = this._parseFile(file, text, priority).finally(() => {
            if (this.inflight.get(key) === request) this.inflight.delete(key);
        });
        this.inflight.set(key, request);
        return request;
    }

    async _parseFile(file, text, priority) {
        await this._load();
        const generation = this.generation;
        if (text !== undefined) {
            const overlay = this.overlays.get(file);
            if (overlay && overlay.text === text) {
                this.stats.memoryHits += 1;
                return overlay.parsed;
            }
            const serialized = await this._run(file, text, priority);
            const parsed = deserializeParsedFile(serialized);
            if (generation === this.generation) this.overlays.set(file, { text, parsed });
            this.stats.parsed += 1;
            return parsed;
        }

        const stat = await fs.promises.stat(file);
        const memory = this.memory.get(file);
        if (memory && memory.mtimeMs === stat.mtimeMs && memory.size === stat.size) {
            this._rememberMemory(file, memory);
            this.stats.memoryHits += 1;
            return memory.parsed;
        }
        const persisted = this.persisted.get(file);
        if (persisted && persisted.mtimeMs === stat.mtimeMs && persisted.size === stat.size) {
            const pending = this.pendingWrites.get(file);
            const serialized = pending ? pending.parsed : await this._readPersisted(file, persisted);
            if (serialized) {
                const parsed = deserializeParsedFile(serialized);
                if (generation === this.generation) {
                    this._rememberMemory(file, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
                }
                this.stats.diskHits += 1;
                return parsed;
            }
        }

        const serialized = await this._run(file, undefined, priority);
        const parsed = deserializeParsedFile(serialized);
        if (generation === this.generation) {
            this._rememberMemory(file, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
            if (this.cacheFile) this._setPersisted(file, stat, serialized);
        }
        this.stats.parsed += 1;
        this._scheduleWrite();
        return parsed;
    }

    async parseFiles(requests, priority) {
        const results = await Promise.all(
            requests.map(async (request) => [
                request.file,
                await this.parseFile(request.file, request.text, priority),
            ])
        );
        return new Map(results);
    }

    clearOverlay(file) {
        this.overlays.delete(file);
    }

    invalidate(file) {
        this.generation += 1;
        for (const key of [...this.inflight.keys()]) {
            if (key.startsWith(`${file}\0`)) this.inflight.delete(key);
        }
        this.memory.delete(file);
        this.overlays.delete(file);
        if (this._deletePersisted(path.normalize(file))) this._scheduleWrite();
    }

    clear() {
        this.generation += 1;
        this.inflight.clear();
        if (this.writeTimer) clearTimeout(this.writeTimer);
        this.writeTimer = null;
        if (!this.loaded) {
            this.loaded = true;
            this.loadPromise = Promise.resolve();
        }
        this.memory.clear();
        this.overlays.clear();
        this.persisted.clear();
        this.persistedBytes = 0;
        this.pendingWrites.clear();
        this.pendingDeletes.clear();
        this.manifestDirty = false;
        if (this.astCacheDir) {
            try {
                fs.rmSync(this.astCacheDir, { recursive: true, force: true });
            } catch (err) {
                if (err.code !== 'ENOENT') this.log(`AST cache clear failed: ${err.message}`);
            }
        }
    }

    _scheduleWrite() {
        if (!this.cacheFile || this.writeTimer || this.disposed) return;
        this.writeTimer = setTimeout(() => {
            this.writeTimer = null;
            this.flush().catch((err) => this.log(`AST cache write failed: ${err.message}`));
        }, 500);
        if (typeof this.writeTimer.unref === 'function') this.writeTimer.unref();
    }

    async flush() {
        if (!this.cacheFile) return;
        if (this.flushPromise) {
            await this.flushPromise;
            if (this.pendingWrites.size > 0 || this.pendingDeletes.size > 0 || this.manifestDirty) {
                return this.flush();
            }
            return;
        }
        if (this.pendingWrites.size === 0 && this.pendingDeletes.size === 0 && !this.manifestDirty) {
            return;
        }

        const writes = [...this.pendingWrites];
        const deletes = [...this.pendingDeletes];
        const writeManifest = this.manifestDirty;
        this.pendingWrites.clear();
        this.pendingDeletes.clear();
        this.manifestDirty = false;
        const manifest = JSON.stringify({ schema: CACHE_SCHEMA, files: [...this.persisted] });

        this.flushPromise = (async () => {
            await fs.promises.mkdir(this.astCacheDir, { recursive: true });
            for (let start = 0; start < writes.length; start += CACHE_WRITE_CONCURRENCY) {
                await Promise.all(
                    writes.slice(start, start + CACHE_WRITE_CONCURRENCY).map(async ([file, value]) => {
                        const target = this._cacheShardFile(value.entry.key);
                        const temporary = `${target}.${process.pid}.tmp`;
                        const payload = JSON.stringify({
                            schema: CACHE_SCHEMA,
                            file,
                            mtimeMs: value.entry.mtimeMs,
                            size: value.entry.size,
                            parsed: value.parsed,
                        });
                        await fs.promises.writeFile(temporary, payload);
                        await fs.promises.rename(temporary, target);
                    })
                );
            }
            for (let start = 0; start < deletes.length; start += CACHE_WRITE_CONCURRENCY) {
                await Promise.all(
                    deletes.slice(start, start + CACHE_WRITE_CONCURRENCY).map(async (key) => {
                        try {
                            await fs.promises.unlink(this._cacheShardFile(key));
                        } catch (err) {
                            if (err.code !== 'ENOENT') throw err;
                        }
                    })
                );
            }
            if (writeManifest) {
                const temporary = `${this.cacheFile}.${process.pid}.tmp`;
                await fs.promises.writeFile(temporary, manifest);
                await fs.promises.rename(temporary, this.cacheFile);
            }
        })();
        try {
            await this.flushPromise;
        } catch (err) {
            for (const [file, value] of writes) {
                const current = this.persisted.get(file);
                if (
                    current &&
                    current.key === value.entry.key &&
                    current.mtimeMs === value.entry.mtimeMs &&
                    current.size === value.entry.size
                ) {
                    this.pendingWrites.set(file, value);
                }
            }
            for (const key of deletes) {
                if (![...this.persisted.values()].some((entry) => entry.key === key)) {
                    this.pendingDeletes.add(key);
                }
            }
            if (writeManifest) this.manifestDirty = true;
            this._scheduleWrite();
            throw err;
        } finally {
            this.flushPromise = null;
        }
        if (this.pendingWrites.size > 0 || this.pendingDeletes.size > 0 || this.manifestDirty) {
            return this.flush();
        }
    }

    dispose() {
        this.disposed = true;
        this._cancelShrink();
        if (this.writeTimer) clearTimeout(this.writeTimer);
        this.writeTimer = null;
        for (const job of this.queue) job.reject(new Error('AST worker pool disposed'));
        this.queue = [];
        for (const state of this.workers) {
            if (!state.ready) state.resolveReady(false);
            if (state.job) state.job.reject(new Error('AST worker pool disposed'));
            state.job = null;
            state.worker.terminate();
        }
        this.workers = [];
        if (this.cacheFile && this.loaded) {
            this.flush().catch((err) => this.log(`AST cache final write failed: ${err.message}`));
        }
    }
}

module.exports = {
    AstWorkerPool,
    CACHE_SCHEMA,
    DEFAULT_AST_CONCURRENCY,
    MAX_AST_CONCURRENCY,
    DEFAULT_WARM_CONCURRENCY,
    DEFAULT_IDLE_TIMEOUT_MS,
    DEFAULT_MEMORY_CACHE_ENTRIES,
    DEFAULT_DISK_CACHE_ENTRIES,
    DEFAULT_DISK_CACHE_BYTES,
};
