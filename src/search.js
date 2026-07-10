'use strict';

const vscode = require('vscode');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * File discovery for Go sources.
 *
 * Prefers ripgrep (bundled with VS Code) because it is multi-threaded and
 * honours .gitignore, then falls back to a system `rg`, then to a plain Node
 * directory walk. Arguments are always passed as an argv array via execFile —
 * never interpolated into a shell string — so method / type names can never
 * cause shell injection.
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
 * List all *.go files under root, excluding common vendored / generated
 * directories at the walk level. Returns absolute paths.
 *
 * @param {string} root workspace path
 * @param {string[]} excludedFolders
 * @returns {Promise<string[]>}
 */
async function listGoFiles(root, excludedFolders) {
    const rg = findRipgrep();
    const args = ['--files', '--glob', '*.go'];
    for (const folder of excludedFolders) {
        args.push('--glob', `!**/${folder}/**`);
    }

    try {
        const out = await runExec(rg || 'rg', args, root);
        return out
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => (path.isAbsolute(l) ? l : path.join(root, l)));
    } catch (_) {
        // Fallback: manual walk.
        return walkGoFiles(root, new Set(excludedFolders));
    }
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
 * @returns {Promise<string[]>}
 */
async function grepInterfaceFilesForMethod(root, methodName, maxFiles, searchDirs) {
    if (!/^[A-Za-z_]\w*$/.test(methodName)) return []; // guard the regex input
    const rg = findRipgrep();
    const cap = maxFiles || 200;

    // Match a line where the method is declared inside an interface, e.g.
    // `\tMethodName(` — a word-boundaried method name followed by `(`.
    // `-l` lists matching files only; multiline is unnecessary since Go
    // interface methods are one per line.
    const args = [
        '-l',
        '--glob',
        '*.go',
        '--max-count',
        '1',
        '-e',
        `^\\s*${methodName}\\s*\\(`,
        '--',
    ];

    // Search targets: either the specific locked-version directories, or `.`
    // (the whole root). Passed after `--` so they are always treated as paths.
    const targets = Array.isArray(searchDirs) && searchDirs.length > 0 ? searchDirs : ['.'];
    for (const t of targets) args.push(t);

    try {
        const out = await runExec(rg || 'rg', args, root, 20000);
        return out
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => (path.isAbsolute(l) ? l : path.join(root, l)))
            .slice(0, cap);
    } catch (_) {
        return [];
    }
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} cwd
 * @param {number} [timeout]
 * @returns {Promise<string>}
 */
function runExec(cmd, args, cwd, timeout) {
    return new Promise((resolve, reject) => {
        execFile(
            cmd,
            args,
            { cwd, timeout: timeout || 15000, maxBuffer: 32 * 1024 * 1024 },
            (error, stdout) => {
                if (error && !stdout) {
                    reject(error);
                    return;
                }
                resolve(stdout || '');
            }
        );
    });
}

/**
 * @param {string} dir
 * @param {Set<string>} excluded
 * @param {string[]} acc
 * @returns {string[]}
 */
function walkGoFiles(dir, excluded, acc) {
    acc = acc || [];
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
        return acc;
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (excluded.has(entry.name) || entry.name === '.git' || entry.name === 'node_modules') {
                continue;
            }
            walkGoFiles(path.join(dir, entry.name), excluded, acc);
        } else if (entry.isFile() && entry.name.endsWith('.go')) {
            acc.push(path.join(dir, entry.name));
        }
    }
    return acc;
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
    listGoFiles,
    resolveSearchRoots,
    findRipgrep,
    resolveGoModCache,
    grepInterfaceFilesForMethod,
};
