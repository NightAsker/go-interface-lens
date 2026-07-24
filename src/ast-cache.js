'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { deserializeParsedFile } = require('./ast');

const CACHE_SCHEMA = 4;

class AstWorkerPool {
    constructor(options) {
        const opts = options || {};
        this.concurrency = Math.max(1, Math.min(4, opts.concurrency || 2));
        this.cacheDir = opts.cacheDir || '';
        this.log = opts.log || (() => {});
        this.cacheFile = this.cacheDir ? path.join(this.cacheDir, `ast-cache-v${CACHE_SCHEMA}.json`) : '';
        this.memory = new Map();
        this.overlays = new Map();
        this.persisted = new Map();
        this.inflight = new Map();
        this.loaded = false;
        this.loadPromise = null;
        this.workers = [];
        this.queue = [];
        this.nextJobID = 1;
        this.nextSequence = 1;
        this.generation = 1;
        this.writeTimer = null;
        this.disposed = false;
        this.stats = { parsed: 0, memoryHits: 0, diskHits: 0, active: 0, maxActive: 0 };
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
                if (payload.schema === CACHE_SCHEMA) {
                    this.persisted = new Map(Object.entries(payload.files || {}));
                }
            } catch (err) {
                if (err.code !== 'ENOENT') this.log(`AST cache load failed: ${err.message}`);
            }
            this.loaded = true;
        })();
        return this.loadPromise;
    }

    _ensureWorkers() {
        if (this.workers.length > 0 || this.disposed) return;
        for (let i = 0; i < this.concurrency; i++) this._spawnWorker();
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
            if (!this.disposed && code !== 0) this._workerFailed(state, new Error(`AST worker exited with code ${code}`));
        });
        this.workers.push(state);
    }

    _workerFailed(state, err) {
        if (state.failed) return;
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
        if (!this.disposed && this.workers.length < this.concurrency) this._spawnWorker();
        this._dispatch();
    }

    /** Start parser workers and wait until their modules are loaded. */
    async warmup() {
        if (this.disposed) return 0;
        for (let attempt = 0; attempt < 3; attempt++) {
            this._ensureWorkers();
            const snapshot = [...this.workers];
            await Promise.all(snapshot.map((state) => state.readyPromise));
            const ready = this.workers.filter((state) => state.ready && !state.failed).length;
            if (ready >= this.concurrency || this.disposed) return ready;
        }
        return this.workers.filter((state) => state.ready && !state.failed).length;
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
        this.queue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
        for (const state of this.workers) {
            if (state.busy || this.queue.length === 0) continue;
            const job = this.queue.shift();
            state.busy = true;
            state.job = job;
            this.stats.active += 1;
            this.stats.maxActive = Math.max(this.stats.maxActive, this.stats.active);
            state.worker.postMessage({ id: job.id, file: job.file, text: job.text });
        }
    }

    _run(file, text, priority) {
        if (this.disposed) return Promise.reject(new Error('AST worker pool is disposed'));
        this._ensureWorkers();
        return new Promise((resolve, reject) => {
            this.queue.push({
                id: this.nextJobID++,
                sequence: this.nextSequence++,
                priority: priority || 0,
                file,
                text,
                resolve,
                reject,
            });
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
            this.stats.memoryHits += 1;
            return memory.parsed;
        }
        const persisted = this.persisted.get(file);
        if (persisted && persisted.mtimeMs === stat.mtimeMs && persisted.size === stat.size) {
            const parsed = deserializeParsedFile(persisted.parsed);
            if (generation === this.generation) {
                this.memory.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
            }
            this.stats.diskHits += 1;
            return parsed;
        }

        const serialized = await this._run(file, undefined, priority);
        const parsed = deserializeParsedFile(serialized);
        if (generation === this.generation) {
            this.memory.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
            this.persisted.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, parsed: serialized });
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
        if (this.persisted.delete(file)) this._scheduleWrite();
    }

    clear() {
        this.generation += 1;
        this.inflight.clear();
        if (!this.loaded) {
            this.loaded = true;
            this.loadPromise = Promise.resolve();
        }
        this.memory.clear();
        this.overlays.clear();
        this.persisted.clear();
        if (this.cacheFile) {
            try {
                fs.unlinkSync(this.cacheFile);
            } catch (err) {
                if (err.code !== 'ENOENT') this.log(`AST cache clear failed: ${err.message}`);
            }
        }
        this._scheduleWrite();
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
        await fs.promises.mkdir(this.cacheDir, { recursive: true });
        const payload = JSON.stringify({ schema: CACHE_SCHEMA, files: Object.fromEntries(this.persisted) });
        const temporary = `${this.cacheFile}.${process.pid}.tmp`;
        await fs.promises.writeFile(temporary, payload);
        await fs.promises.rename(temporary, this.cacheFile);
    }

    dispose() {
        this.disposed = true;
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
            try {
                fs.mkdirSync(this.cacheDir, { recursive: true });
                fs.writeFileSync(
                    this.cacheFile,
                    JSON.stringify({ schema: CACHE_SCHEMA, files: Object.fromEntries(this.persisted) })
                );
            } catch (err) {
                this.log(`AST cache final write failed: ${err.message}`);
            }
        }
    }
}

module.exports = { AstWorkerPool, CACHE_SCHEMA };
