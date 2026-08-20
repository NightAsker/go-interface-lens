'use strict';

const vscode = require('vscode');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { hasCompatibleMethodArity } = require('./go-arity');

const ARITY_PREFILTER_READ_CONCURRENCY = 32;
const RIPGREP_PROCESS_CONCURRENCY = 4;

/**
 * On-demand Go declaration candidate searches. Prefer VS Code's bundled
 * ripgrep, then fall back to a system `rg`. Arguments are always passed as an
 * argv array via execFile so method and type names cannot cause shell injection.
 */

let cachedRgPath;

/**
 * Locate a ripgrep binary. VS Code ships one under its install root.
 * @returns {string|null}
 */
function findRipgrep() {
    if (cachedRgPath !== undefined) return cachedRgPath;

    const candidates = [];
    const appRoot = vscode.env.appRoot;
    if (appRoot) {
        const base = path.join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin');
        const baseAlt = path.join(appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin');
        const bin = process.platform === 'win32' ? 'rg.exe' : 'rg';
        candidates.push(path.join(base, bin), path.join(baseAlt, bin));
    }

    for (const c of candidates) {
        try {
            if (fs.existsSync(c)) {
                cachedRgPath = c;
                return cachedRgPath;
            }
        } catch (_) {
            // ignore
        }
    }

    cachedRgPath = null; // fall back to PATH `rg`
    return cachedRgPath;
}

/**
 * Resolve the Go module cache directory, where downloaded dependency sources
 * live (the interface may be declared there while implemented in the project).
 *
 * Resolution order: explicit override → $GOMODCACHE → $GOPATH/pkg/mod →
 * ~/go/pkg/mod. Returns null if none exists on disk.
 *
 * @param {string} [override] user-configured absolute path
 * @returns {string|null}
 */
function resolveGoModCache(override) {
    const candidates = [];
    if (override && override.trim()) candidates.push(override.trim());
    if (process.env.GOMODCACHE) candidates.push(process.env.GOMODCACHE);
    if (process.env.GOPATH) {
        for (const gp of process.env.GOPATH.split(path.delimiter)) {
            if (gp) candidates.push(path.join(gp, 'pkg', 'mod'));
        }
    }
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) candidates.push(path.join(home, 'go', 'pkg', 'mod'));

    for (const c of candidates) {
        try {
            if (c && fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
        } catch (_) {
            // ignore
        }
    }
    return null;
}

/**
 * Grep a (potentially huge) dependency root for Go files that declare an
 * interface mentioning `methodName`, WITHOUT indexing the whole tree.
 *
 * We search for interface declarations and rely on ripgrep's speed + a bounded
 * result count so scanning the module cache stays fast. Returns absolute file
 * paths of candidate files (the caller parses and verifies them).
 *
 * When `searchDirs` is provided (and non-empty), ripgrep is restricted to
 * exactly those directories — used to search only the module versions locked
 * by the project's go.mod, so other cached versions never leak into results.
 * Otherwise the whole `root` is searched.
 *
 * @param {string} root dependency root (e.g. module cache)
 * @param {string} methodName known method name to look for
 * @param {number} [maxFiles] cap on candidate files
 * @param {string[]} [searchDirs] restrict search to these absolute directories
 * @param {{params:number,results:number}} [arity] optional declaration shape prefilter
 * @returns {Promise<string[]>}
 */
async function grepInterfaceFilesForMethod(root, methodName, maxFiles, searchDirs, arity) {
    if (!/^[A-Za-z_]\w*$/.test(methodName)) return []; // guard the regex input
    const rg = findRipgrep();
    const cap = maxFiles || 200;

    // Match the conventional one-method-per-line form and compact declarations
    // such as `type I interface { Method() }`. The parser still verifies every
    // candidate, so broadening this grep does not weaken result correctness.
    const args = [
        '-l',
        '--glob',
        '*.go',
        '--max-count',
        '1',
        '-e',
        `(?:^\\s*${methodName}\\s*\\(|\\binterface\\s*\\{[^}]*\\b${methodName}\\s*\\()`,
    ];

    // Search targets: either the specific locked-version directories, or `.`
    // (the whole root). Passed after `--` so they are always treated as paths.
    const targets = Array.isArray(searchDirs) && searchDirs.length > 0 ? searchDirs : ['.'];
    try {
        const out = await runRipgrepShards(rg || 'rg', args, targets, root, 20000);
        const files = out
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => (path.isAbsolute(l) ? l : path.join(root, l)));
        return filterFilesByMethodArity(files, methodName, 'interface', arity, cap);
    } catch (_) {
        return [];
    }
}

/**
 * Find Go files containing a receiver method declaration named `methodName`.
 * The caller expands each hit to its complete package and performs semantic AST
 * verification, so this grep is deliberately recall-oriented.
 *
 * @param {string} root dependency root (e.g. module cache)
 * @param {string} methodName interface method used as the candidate anchor
 * @param {number} [maxFiles] cap on candidate files
 * @param {string[]} [searchDirs] restrict search to locked module directories
 * @param {{params:number,results:number}} [arity] optional declaration shape prefilter
 * @returns {Promise<string[]>}
 */
async function grepImplementationFilesForMethod(root, methodName, maxFiles, searchDirs, arity) {
    if (!/^[A-Za-z_]\w*$/.test(methodName)) return [];
    const rg = findRipgrep();
    const cap = maxFiles || 400;
    const args = [
        '-l',
        '-U',
        '--glob',
        '*.go',
        '--max-count',
        '1',
        '-e',
        `\\bfunc\\s*\\([^)]*\\)\\s*${methodName}\\s*\\(`,
    ];
    const targets = Array.isArray(searchDirs) && searchDirs.length > 0 ? searchDirs : ['.'];

    try {
        const out = await runRipgrepShards(rg || 'rg', args, targets, root, 20000);
        const files = out
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => (path.isAbsolute(line) ? line : path.join(root, line)));
        return filterFilesByMethodArity(files, methodName, 'implementation', arity, cap);
    } catch (_) {
        return [];
    }
}

async function filterFilesByMethodArity(files, methodName, kind, arity, maxFiles) {
    const cap = maxFiles || Number.MAX_SAFE_INTEGER;
    if (
        !arity ||
        !Number.isInteger(arity.params) ||
        !Number.isInteger(arity.results)
    ) {
        return files.slice(0, cap);
    }
    const keep = new Array(files.length);
    let next = 0;
    const workers = Array.from(
        { length: Math.min(files.length, ARITY_PREFILTER_READ_CONCURRENCY) },
        async () => {
            while (next < files.length) {
                const index = next++;
                try {
                    const source = await fs.promises.readFile(files[index], 'utf8');
                    keep[index] = hasCompatibleMethodArity(
                        source,
                        methodName,
                        kind,
                        arity
                    );
                } catch (_) {
                    keep[index] = true;
                }
            }
        }
    );
    await Promise.all(workers);
    return files.filter((_, index) => keep[index]).slice(0, cap);
}


/**
 * Find files that may embed or alias one of the supplied named types. AST
 * method-set resolution later rejects ordinary references and ambiguous embeds.
 *
 * @param {string} root dependency root
 * @param {Iterable<string>} typeNames candidate embedded type names
 * @param {number} [maxFiles] cap on candidate files
 * @param {string[]} [searchDirs] restrict search to locked module directories
 * @returns {Promise<string[]>}
 */
async function grepGoFilesForTypeNames(root, typeNames, maxFiles, searchDirs) {
    const names = [...new Set(typeNames)].filter((name) => /^[A-Za-z_]\w*$/.test(name)).sort();
    if (names.length === 0) return [];
    const rg = findRipgrep();
    const cap = maxFiles || 400;
    const alternatives = names.join('|');
    const namedReference = `\\*?(?:[A-Z_a-z]\\w*\\.)?(?:${alternatives})\\b`;
    const typeArguments = `(?:\\s*\\[[^\\]\\n]*\\])?`;
    const directAlias =
        `\\btype\\s+[A-Z_a-z]\\w*(?:\\s*\\[[^\\]\\n]*\\])?` +
        `\\s*=\\s*${namedReference}${typeArguments}`;
    const groupedAlias =
        `\\btype\\s*\\([^)]*\\b[A-Z_a-z]\\w*` +
        `(?:\\s*\\[[^\\]\\n]*\\])?\\s*=\\s*${namedReference}${typeArguments}`;
    const embeddedField =
        `\\b(?:struct|interface)\\s*\\{` +
        `(?:[^};\\n]*(?:;|\\n))*\\s*${namedReference}${typeArguments}` +
        `\\s*(?:\x60[^\x60\\n]*\x60)?\\s*(?:;|\\n|\\})`;
    const args = [
        '-l',
        '-U',
        '--glob',
        '*.go',
        '--max-count',
        '1',
        '-e',
        `(?:${directAlias}|${groupedAlias}|${embeddedField})`,
    ];
    const targets = Array.isArray(searchDirs) && searchDirs.length > 0 ? searchDirs : ['.'];

    try {
        const out = await runRipgrepShards(rg || 'rg', args, targets, root, 20000);
        return out
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => (path.isAbsolute(line) ? line : path.join(root, line)))
            .slice(0, cap);
    } catch (_) {
        return [];
    }
}

function splitSearchTargets(targets, concurrency = RIPGREP_PROCESS_CONCURRENCY) {
    const values = [...(targets || [])];
    if (values.length === 0) return [];
    const groupCount = Math.min(
        values.length,
        Math.max(1, Number.isInteger(concurrency) ? concurrency : RIPGREP_PROCESS_CONCURRENCY)
    );
    const groups = Array.from({ length: groupCount }, () => []);
    for (let index = 0; index < values.length; index++) {
        groups[index % groupCount].push(values[index]);
    }
    return groups;
}

async function runRipgrepShards(cmd, args, targets, cwd, timeout) {
    const groups = splitSearchTargets(targets);
    const outputs = await Promise.all(
        groups.map((group) => runExec(cmd, [...args, '--', ...group], cwd, timeout))
    );
    return outputs.filter(Boolean).join('\n');
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} cwd
 * @param {number} [timeout]
 * @returns {Promise<string>}
 */
function runExec(cmd, args, cwd, timeout) {
    return runExecResult(cmd, args, cwd, timeout).then((result) => {
        if (result.complete) return result.stdout;
        const error = result.error || new Error(`Command failed: ${cmd}`);
        error.stdout = result.stdout;
        error.timedOut = result.timedOut;
        throw error;
    });
}

function runExecResult(cmd, args, cwd, timeout) {
    return new Promise((resolve) => {
        execFile(
            cmd,
            args,
            { cwd, timeout: timeout || 15000, maxBuffer: 32 * 1024 * 1024 },
            (error, stdout) => {
                const noMatches = !!error && error.code === 1 && !error.killed;
                const timedOut = !!error && !!error.killed && !!error.signal;
                resolve({
                    stdout: stdout || '',
                    complete: !error || noMatches,
                    timedOut,
                    error: noMatches ? null : error || null,
                });
            }
        );
    });
}

/**
 * Resolve the set of search roots to index for a given document.
 *
 * The implementations of an interface almost always live in the user's own
 * project, even when the interface itself is declared in a dependency package
 * (module cache / vendor) that sits OUTSIDE the open workspace. So we always
 * index every open workspace folder, and additionally include the document's
 * own workspace folder or, when the file is outside the workspace entirely
 * (a dependency file), its containing directory as a fallback so that at least
 * that package is searchable too.
 *
 * @param {vscode.Uri} documentUri
 * @returns {string[]} de-duplicated absolute root paths
 */
function resolveSearchRoots(documentUri) {
    const roots = new Set();

    const folders = vscode.workspace.workspaceFolders || [];
    for (const f of folders) {
        roots.add(f.uri.fsPath);
    }

    const owning = vscode.workspace.getWorkspaceFolder(documentUri);
    if (owning) {
        roots.add(owning.uri.fsPath);
    } else if (documentUri && documentUri.fsPath) {
        // Dependency / standalone file outside any workspace folder: also index
        // its own directory so the interface's own package is covered.
        roots.add(path.dirname(documentUri.fsPath));
    }

    if (roots.size === 0 && documentUri && documentUri.fsPath) {
        roots.add(path.dirname(documentUri.fsPath));
    }

    return [...roots];
}

module.exports = {
    resolveSearchRoots,
    findRipgrep,
    resolveGoModCache,
    grepInterfaceFilesForMethod,
    grepImplementationFilesForMethod,
    grepGoFilesForTypeNames,
    splitSearchTargets,
};
