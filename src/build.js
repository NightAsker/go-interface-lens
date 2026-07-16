'use strict';

const path = require('path');

const GOOS = new Set([
    'aix',
    'android',
    'darwin',
    'dragonfly',
    'freebsd',
    'illumos',
    'ios',
    'js',
    'linux',
    'netbsd',
    'openbsd',
    'plan9',
    'solaris',
    'wasip1',
    'windows',
]);
const GOARCH = new Set([
    '386',
    'amd64',
    'arm',
    'arm64',
    'loong64',
    'mips',
    'mips64',
    'mips64le',
    'mipsle',
    'ppc64',
    'ppc64le',
    'riscv64',
    's390x',
    'wasm',
]);
const UNIX_GOOS = new Set([
    'aix',
    'android',
    'darwin',
    'dragonfly',
    'freebsd',
    'hurd',
    'illumos',
    'ios',
    'linux',
    'netbsd',
    'openbsd',
    'solaris',
]);

function currentBuildContext() {
    const platform = { win32: 'windows' }[process.platform] || process.platform;
    const architecture = { x64: 'amd64', ia32: '386' }[process.arch] || process.arch;
    const goos = process.env.GOOS || platform;
    const goarch = process.env.GOARCH || architecture;
    const tags = new Set([goos, goarch, 'gc']);
    if (UNIX_GOOS.has(goos)) tags.add('unix');
    // Go's build package treats these target pairs as additionally satisfying
    // the parent operating-system tag.
    if (goos === 'android') tags.add('linux');
    if (goos === 'ios') tags.add('darwin');
    if (goos === 'illumos') tags.add('solaris');
    return { goos, goarch, tags };
}

function fileNameMatchesContext(filePath, context) {
    let name = path.basename(filePath, '.go');
    if (name.endsWith('_test')) name = name.slice(0, -'_test'.length);
    const parts = name.split('_');
    const last = parts[parts.length - 1];
    const previous = parts[parts.length - 2];

    if (GOOS.has(previous) && GOARCH.has(last)) {
        return previous === context.goos && last === context.goarch;
    }
    if (GOOS.has(last)) return last === context.goos;
    if (GOARCH.has(last)) return last === context.goarch;
    return true;
}

function evaluateBuildExpression(expression, tags) {
    const tokens = expression.match(/&&|\|\||!|\(|\)|[A-Za-z0-9_.]+/g) || [];
    let at = 0;

    const primary = () => {
        const token = tokens[at++];
        if (token === '(') {
            const value = orExpr();
            if (tokens[at] !== ')') throw new Error('unclosed build expression');
            at += 1;
            return value;
        }
        if (!token || token === ')') throw new Error('invalid build expression');
        if (tags.has(token)) return true;
        if (GOOS.has(token) || GOARCH.has(token) || token === 'unix' || token === 'gc') return false;
        // The extension does not know cgo, release, or user-supplied -tags
        // without spawning the Go toolchain. Preserve those files unless the
        // known part of the expression proves they cannot match.
        return null;
    };
    const unary = () => {
        if (tokens[at] === '!') {
            at += 1;
            const value = unary();
            return value === null ? null : !value;
        }
        return primary();
    };
    const andExpr = () => {
        let value = unary();
        while (tokens[at] === '&&') {
            at += 1;
            const right = unary();
            value = value === false || right === false ? false : value === null || right === null ? null : true;
        }
        return value;
    };
    const orExpr = () => {
        let value = andExpr();
        while (tokens[at] === '||') {
            at += 1;
            const right = andExpr();
            value = value === true || right === true ? true : value === null || right === null ? null : false;
        }
        return value;
    };

    try {
        const value = orExpr();
        return at === tokens.length ? value !== false : true;
    } catch (_) {
        // Invalid/unknown expressions should not make source disappear from the
        // index. The Go compiler remains the source of truth for such files.
        return true;
    }
}

function legacyBuildLineMatches(expression, tags) {
    // Space-separated options are OR; comma-separated terms inside one option
    // are AND, matching the historical // +build syntax.
    let sawUnknown = false;
    const matched = expression
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .some((option) =>
            option.split(',').every((term) => {
                const negated = term.startsWith('!');
                const tag = negated ? term.slice(1) : term;
                const known = GOOS.has(tag) || GOARCH.has(tag) || tag === 'unix' || tag === 'gc';
                if (!known && !tags.has(tag)) {
                    sawUnknown = true;
                    return true;
                }
                const present = tags.has(tag);
                return negated ? !present : present;
            })
        );
    return matched || sawUnknown;
}

function shouldIncludeGoFile(filePath, text, context) {
    const ctx = context || currentBuildContext();
    if (!fileNameMatchesContext(filePath, ctx)) return false;
    if (!text) return true;

    const legacy = [];
    for (const line of text.split('\n').slice(0, 50)) {
        if (/^\s*package\b/.test(line)) break;
        const modern = line.match(/^\s*\/\/go:build\s+(.+)$/);
        if (modern) return evaluateBuildExpression(modern[1], ctx.tags);
        const old = line.match(/^\s*\/\/\s*\+build\s+(.+)$/);
        if (old) legacy.push(old[1]);
    }
    return legacy.every((line) => legacyBuildLineMatches(line, ctx.tags));
}

module.exports = {
    currentBuildContext,
    evaluateBuildExpression,
    fileNameMatchesContext,
    shouldIncludeGoFile,
};
