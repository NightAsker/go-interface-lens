'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_PATH_BYTES = 24000;
const MAX_FILES_PER_TASK = 256;
const STAT_CONCURRENCY = 16;
// Account for opening many small files as well as reading their content.
const FILE_OPEN_WEIGHT = 4096;

function cancellationError() {
    return Object.assign(new Error('Search cancelled'), { code: 'SEARCH_CANCELLED' });
}

function rootBatches(roots) {
    const batches = [];
    for (const root of roots) {
        const size = Buffer.byteLength(root.root) + 1;
        let batch = batches[batches.length - 1];
        if (!batch || batch.roots.length >= 32 || batch.pathBytes + size > MAX_PATH_BYTES) {
            batch = { roots: [], pathBytes: 0 };
            batches.push(batch);
        }
        batch.roots.push(root);
        batch.pathBytes += size;
    }
    return batches;
}

/** Enumerate with rg's own ignore/glob rules, then read metadata only. */
async function collectSearchFiles(command, args, rootInfo, options = {}) {
    const signal = options.signal;
    if (signal?.aborted) throw cancellationError();
    const child = spawn(command, args, { cwd: rootInfo.root, stdio: ['ignore', 'pipe', 'pipe'] });
    let spawnError;
    let stderr = '';
    const closed = new Promise((resolve) => {
        child.on('error', (error) => { spawnError = error; });
        child.on('close', (code) => resolve(code));
    });
    const abort = () => { if (!child.killed) child.kill(); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-65536); });
    child.stdout.setEncoding('utf8');
    const files = [];
    const statFile = options.statFile || fs.promises.stat;
    const readSizes = async (paths) => {
        let next = 0;
        let failure;
        await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, paths.length) }, async () => {
            while (next < paths.length && !signal?.aborted && !failure) {
                const file = paths[next++];
                try {
                    const stat = await statFile(file);
                    if (stat.isFile()) files.push({ file, size: stat.size });
                } catch (error) {
                    // A file removed during enumeration no longer needs searching.
                    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') failure = error;
                }
            }
        }));
        if (signal?.aborted) throw cancellationError();
        if (failure) throw failure;
    };
    try {
        let buffer = '';
        let pending = [];
        const add = async (value) => {
            if (!value) return;
            const file = path.resolve(rootInfo.root, value);
            if (options.includeFile && !options.includeFile(file)) return;
            pending.push(file);
            if (pending.length >= 128) {
                await readSizes(pending);
                pending = [];
            }
        };
        // Awaiting metadata batches provides backpressure; the entire directory
        // listing is never queued as thousands of concurrent stat requests.
        for await (const chunk of child.stdout) {
            if (signal?.aborted) throw cancellationError();
            buffer += chunk;
            let offset = 0;
            let separator;
            while ((separator = buffer.indexOf('\0', offset)) >= 0) {
                await add(buffer.slice(offset, separator));
                offset = separator + 1;
                if (signal?.aborted) throw cancellationError();
            }
            buffer = buffer.slice(offset);
        }
        await add(buffer);
        await readSizes(pending);
        const code = await closed;
        if (signal?.aborted) throw cancellationError();
        if (spawnError) throw spawnError;
        if (code !== 0 && code !== 1) {
            throw Object.assign(new Error(stderr.trim() || `File enumeration exited with code ${code}`), { code: 'RIPGREP_FAILED' });
        }
        return files;
    } finally {
        signal?.removeEventListener('abort', abort);
        abort();
        await closed;
    }
}

/** Partition package directories using fresh file counts and byte sizes. */
function planSearchJobs(files, parallelism = 8) {
    if (!files.length) return [];
    const packages = new Map();
    for (const file of files) {
        const directory = path.dirname(file.file);
        let pkg = packages.get(directory);
        if (!pkg) { pkg = { directory, files: [], weight: 0 }; packages.set(directory, pkg); }
        const weight = file.size + FILE_OPEN_WEIGHT;
        pkg.files.push({ ...file, weight });
        pkg.weight += weight;
    }
    const slots = Math.min(4, Math.max(1, parallelism), files.length);
    const totalWeight = [...packages.values()].reduce((sum, pkg) => sum + pkg.weight, 0);
    const targetWeight = totalWeight / (slots * 2);
    const jobs = [];
    const sorted = [...packages.values()].sort((left, right) => right.weight - left.weight || left.directory.localeCompare(right.directory));
    for (const pkg of sorted) {
        // A large package can occupy several tasks; small packages share a task.
        // Keep files from the same package together where the size budget allows.
        const sortedFiles = pkg.files.sort((left, right) => right.weight - left.weight || left.file.localeCompare(right.file));
        let job;
        for (const file of sortedFiles) {
            const pathBytes = Buffer.byteLength(file.file) + 1;
            const fits = (candidate) => candidate.weight + file.weight <= targetWeight
                && candidate.files.length < MAX_FILES_PER_TASK && candidate.pathBytes + pathBytes <= MAX_PATH_BYTES;
            if (!job || !fits(job)) job = jobs.find(fits);
            if (!job) { job = { files: [], weight: 0, bytes: 0, pathBytes: 0 }; jobs.push(job); }
            job.files.push(file);
            job.weight += file.weight;
            job.bytes += file.size;
            job.pathBytes += pathBytes;
        }
    }
    return jobs.sort((left, right) => right.weight - left.weight);
}

module.exports = { collectSearchFiles, planSearchJobs, rootBatches };
