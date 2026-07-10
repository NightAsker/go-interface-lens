'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Minimal go.mod parsing + Go module cache path resolution.
 *
 * The goal is to restrict dependency interface search to EXACTLY the module
 * versions the project's go.mod currently locks, so the module cache (which
 * keeps every previously downloaded version) does not leak stale versions into
 * results.
 */

/**
 * Locate the nearest go.mod at or above `startDir`.
 * @param {string} startDir absolute directory
 * @returns {string|null} absolute path to go.mod, or null
 */
function findGoMod(startDir) {
    let dir = startDir;
    // Walk up until filesystem root.
    for (let i = 0; i < 100; i++) {
        const candidate = path.join(dir, 'go.mod');
        try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                return candidate;
            }
        } catch (_) {
            // ignore
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/**
 * Parse the effective module -> version map from a go.mod file. Handles single
 * `require x v1` lines, `require ( ... )` blocks, and `replace` directives
 * (replacements win over the original require). `// indirect` comments and
 * inline comments are ignored.
 *
 * Local/filesystem replacements (targets starting with `.` or `/` or a drive
 * path) are recorded separately so the caller can search that directory
 * directly instead of the module cache.
 *
 * @param {string} text go.mod contents
 * @returns {{versions: Map<string,string>, localReplaces: Map<string,string>}}
 *   versions: modulePath -> version (e.g. "github.com/acme/x" -> "v1.3.0")
 *   localReplaces: modulePath -> filesystem path target
 */
function parseGoMod(text) {
    const versions = new Map();
    const localReplaces = new Map();

    const lines = text.split('\n');
    let inRequireBlock = false;

    const stripComment = (s) => {
        const idx = s.indexOf('//');
        return (idx === -1 ? s : s.slice(0, idx)).trim();
    };

    for (let raw of lines) {
        const line = stripComment(raw);
        if (!line) continue;

        // require ( ... ) block boundaries
        if (/^require\s*\($/.test(line)) {
            inRequireBlock = true;
            continue;
        }
        if (inRequireBlock) {
            if (line === ')') {
                inRequireBlock = false;
                continue;
            }
            addRequire(line, versions);
            continue;
        }

        // single-line require
        const single = line.match(/^require\s+(.*)$/);
        if (single) {
            addRequire(single[1].trim(), versions);
            continue;
        }

        // replace directives (single-line form): replace A [vX] => B [vY].
        // The `replace ( ... )` block form has no `=>` on its opening line, so
        // addReplace safely ignores it here; the dedicated second pass below
        // handles block contents.
        const rep = line.match(/^replace\s+(.*)$/);
        if (rep) {
            addReplace(rep[1].trim(), versions, localReplaces);
            continue;
        }
    }

    // Second pass for replace ( ... ) blocks (kept simple and separate).
    let inReplaceBlock = false;
    for (let raw of lines) {
        const line = stripComment(raw);
        if (!line) continue;
        if (/^replace\s*\($/.test(line)) {
            inReplaceBlock = true;
            continue;
        }
        if (inReplaceBlock) {
            if (line === ')') {
                inReplaceBlock = false;
                continue;
            }
            addReplace(line, versions, localReplaces);
        }
    }

    return { versions, localReplaces };
}

function addRequire(spec, versions) {
    // "modulePath vX.Y.Z"
    const m = spec.match(/^(\S+)\s+(\S+)$/);
    if (m) versions.set(m[1], m[2]);
}

function addReplace(spec, versions, localReplaces) {
    // Forms:
    //   old => new vX
    //   old vX => new vY
    //   old => ./local/path
    //   old vX => /abs/path
    const parts = spec.split('=>');
    if (parts.length !== 2) return;
    const left = parts[0].trim();
    const right = parts[1].trim();

    const oldPath = left.split(/\s+/)[0];
    const rightTokens = right.split(/\s+/);
    const target = rightTokens[0];
    const targetVersion = rightTokens[1];

    if (isLocalPath(target)) {
        localReplaces.set(oldPath, target);
        // A local replace overrides any cache version.
        versions.delete(oldPath);
    } else if (targetVersion) {
        // Replaced by another module@version.
        versions.set(oldPath, targetVersion);
        versions.set(target, targetVersion);
    }
}

function isLocalPath(target) {
    return (
        target.startsWith('./') ||
        target.startsWith('../') ||
        target.startsWith('/') ||
        target === '.' ||
        target === '..' ||
        /^[A-Za-z]:[\\/]/.test(target) // Windows drive
    );
}

/**
 * Escape a module path or version to its Go module cache directory form. Go
 * lower-cases uppercase letters and prefixes them with '!' to keep the cache
 * case-insensitive-safe. E.g. `github.com/Sirupsen/logrus` ->
 * `github.com/!sirupsen/logrus`.
 * @param {string} s
 * @returns {string}
 */
function escapeModulePath(s) {
    let out = '';
    for (const ch of s) {
        if (ch >= 'A' && ch <= 'Z') {
            out += '!' + ch.toLowerCase();
        } else {
            out += ch;
        }
    }
    return out;
}

/**
 * Resolve the exact module-cache directories for the versions locked by the
 * project's go.mod. Only directories that exist on disk are returned.
 *
 * @param {string} projectDir a directory inside the project (used to find go.mod)
 * @param {string} modCacheRoot the Go module cache root (e.g. ~/go/pkg/mod)
 * @returns {{dirs: string[], goModPath: string|null}}
 *   dirs: absolute directories to restrict dependency search to
 */
function resolveLockedModuleDirs(projectDir, modCacheRoot) {
    const goModPath = findGoMod(projectDir);
    if (!goModPath) return { dirs: [], goModPath: null };

    let parsed;
    try {
        parsed = parseGoMod(fs.readFileSync(goModPath, 'utf8'));
    } catch (_) {
        return { dirs: [], goModPath };
    }

    const dirs = [];

    if (modCacheRoot) {
        for (const [modPath, version] of parsed.versions) {
            const escaped = escapeModulePath(modPath) + '@' + escapeModulePath(version);
            const abs = path.join(modCacheRoot, ...escaped.split('/'));
            try {
                if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
                    dirs.push(abs);
                }
            } catch (_) {
                // ignore
            }
        }
    }

    // Local (filesystem) replacements: search the replacement directory directly.
    const goModDir = path.dirname(goModPath);
    for (const [, target] of parsed.localReplaces) {
        const abs = path.isAbsolute(target) ? target : path.join(goModDir, target);
        try {
            if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
                dirs.push(abs);
            }
        } catch (_) {
            // ignore
        }
    }

    return { dirs, goModPath };
}

module.exports = {
    findGoMod,
    parseGoMod,
    escapeModulePath,
    resolveLockedModuleDirs,
    isLocalPath,
};
