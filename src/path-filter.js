'use strict';

const path = require('path');

function normalizeWildcardPatterns(patterns) {
    return [
        ...new Set(
            (patterns || [])
                .filter((pattern) => typeof pattern === 'string')
                .map((pattern) => pattern.trim())
                .filter(Boolean)
        ),
    ].sort();
}

function wildcardSource(pattern) {
    let source = '';
    for (const character of pattern) {
        if (character === '*') source += '.*';
        else if (character === '?') source += '.';
        else source += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    }
    return source;
}

function compileWildcardPattern(pattern) {
    if (typeof pattern !== 'string' || !pattern.trim()) return null;
    return new RegExp(`^${wildcardSource(pattern.trim())}$`);
}

/**
 * Build a matcher for directory paths. A pattern without a slash matches one
 * complete path segment; a slash-containing pattern matches a directory
 * subpath at any depth. Only `*` and `?` have wildcard meaning.
 */
function createFolderMatcher(patterns) {
    const matchers = normalizeWildcardPatterns(patterns)
        .map((pattern) => pattern.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
        .filter(Boolean)
        .map((pattern) =>
            pattern.includes('/')
                ? {
                      subpath: new RegExp(
                          `(?:^|/)${wildcardSource(pattern)}(?:/|$)`
                      ),
                  }
                : { segment: compileWildcardPattern(pattern) }
        );

    if (matchers.length === 0) return () => false;
    return (directory) => {
        const normalized = path.normalize(directory).split(path.sep).join('/');
        const segments = normalized.split('/').filter(Boolean);
        return matchers.some((matcher) =>
            matcher.subpath
                ? matcher.subpath.test(normalized)
                : segments.some((segment) => matcher.segment.test(segment))
        );
    };
}

module.exports = {
    normalizeWildcardPatterns,
    compileWildcardPattern,
    createFolderMatcher,
};
