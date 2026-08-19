'use strict';

function isIdentifierStart(character) {
    return !!character && /[A-Za-z_]/.test(character);
}

function isIdentifierPart(character) {
    return !!character && /[A-Za-z0-9_]/.test(character);
}

function skipQuoted(source, start) {
    const quote = source[start];
    let index = start + 1;
    while (index < source.length) {
        const character = source[index];
        if (quote !== '`' && character === '\\') {
            index += 2;
            continue;
        }
        index += 1;
        if (character === quote) break;
    }
    return index;
}

function skipLineComment(source, start) {
    const newline = source.indexOf('\n', start + 2);
    return newline === -1 ? source.length : newline;
}

function skipBlockComment(source, start) {
    const close = source.indexOf('*/', start + 2);
    return close === -1 ? source.length : close + 2;
}

function findFunctionBody(source, start) {
    let parentheses = 0;
    let brackets = 0;
    let typeBraces = 0;
    let sawParameterList = false;
    let previousIdentifier = '';

    for (let index = start; index < source.length; ) {
        const character = source[index];
        const next = source[index + 1];
        if (character === '/' && next === '/') {
            index = skipLineComment(source, index);
            continue;
        }
        if (character === '/' && next === '*') {
            index = skipBlockComment(source, index);
            continue;
        }
        if (character === '"' || character === "'" || character === '`') {
            index = skipQuoted(source, index);
            previousIdentifier = '';
            continue;
        }
        if (isIdentifierStart(character)) {
            let end = index + 1;
            while (isIdentifierPart(source[end])) end += 1;
            previousIdentifier = source.slice(index, end);
            index = end;
            continue;
        }
        if (character === '\n' || character === '\r') {
            if (
                sawParameterList &&
                parentheses === 0 &&
                brackets === 0 &&
                typeBraces === 0
            ) {
                return -1;
            }
            index += 1;
            continue;
        }
        if (/\s/.test(character)) {
            index += 1;
            continue;
        }

        if (character === '(') {
            parentheses += 1;
            sawParameterList = true;
        } else if (character === ')') {
            parentheses = Math.max(0, parentheses - 1);
        } else if (character === '[') {
            brackets += 1;
        } else if (character === ']') {
            brackets = Math.max(0, brackets - 1);
        } else if (character === '{') {
            const startsTypeLiteral =
                previousIdentifier === 'struct' || previousIdentifier === 'interface';
            if (
                parentheses > 0 ||
                brackets > 0 ||
                typeBraces > 0 ||
                startsTypeLiteral
            ) {
                typeBraces += 1;
            } else if (sawParameterList) {
                return index;
            } else {
                return -1;
            }
        } else if (character === '}') {
            if (typeBraces === 0) return -1;
            typeBraces -= 1;
        } else if (
            character === ';' &&
            parentheses === 0 &&
            brackets === 0 &&
            typeBraces === 0
        ) {
            return -1;
        }
        previousIdentifier = '';
        index += 1;
    }
    return -1;
}

function findMatchingBrace(source, open) {
    let depth = 1;
    for (let index = open + 1; index < source.length; ) {
        const character = source[index];
        const next = source[index + 1];
        if (character === '/' && next === '/') {
            index = skipLineComment(source, index);
            continue;
        }
        if (character === '/' && next === '*') {
            index = skipBlockComment(source, index);
            continue;
        }
        if (character === '"' || character === "'" || character === '`') {
            index = skipQuoted(source, index);
            continue;
        }
        if (character === '{') depth += 1;
        else if (character === '}') {
            depth -= 1;
            if (depth === 0) return index;
        }
        index += 1;
    }
    return -1;
}

/**
 * Replace package-level function and method body contents with spaces while
 * preserving braces, line breaks, and JavaScript string offsets. The resulting
 * source remains valid input for the normal Go grammar but contains only the
 * declaration information used by the interface index.
 */
function maskGoFunctionBodies(source) {
    const ranges = [];
    let braceDepth = 0;
    for (let index = 0; index < source.length; ) {
        const character = source[index];
        const next = source[index + 1];
        if (character === '/' && next === '/') {
            index = skipLineComment(source, index);
            continue;
        }
        if (character === '/' && next === '*') {
            index = skipBlockComment(source, index);
            continue;
        }
        if (character === '"' || character === "'" || character === '`') {
            index = skipQuoted(source, index);
            continue;
        }
        if (isIdentifierStart(character)) {
            let end = index + 1;
            while (isIdentifierPart(source[end])) end += 1;
            if (braceDepth === 0 && source.slice(index, end) === 'func') {
                const open = findFunctionBody(source, end);
                const close = open >= 0 ? findMatchingBrace(source, open) : -1;
                if (close >= 0) {
                    ranges.push([open + 1, close]);
                    index = close + 1;
                    continue;
                }
            }
            index = end;
            continue;
        }
        if (character === '{') braceDepth += 1;
        else if (character === '}') braceDepth = Math.max(0, braceDepth - 1);
        index += 1;
    }

    if (ranges.length === 0) {
        return { text: source, bodyCount: 0, maskedCharacters: 0 };
    }
    const parts = [];
    let cursor = 0;
    let maskedCharacters = 0;
    for (const [start, end] of ranges) {
        parts.push(source.slice(cursor, start));
        const body = source.slice(start, end);
        let lineBreakCharacters = 0;
        for (const character of body) {
            if (character === '\r' || character === '\n') lineBreakCharacters += 1;
        }
        maskedCharacters += body.length - lineBreakCharacters;
        parts.push(body.replace(/[^\r\n]/g, ' '));
        cursor = end;
    }
    parts.push(source.slice(cursor));
    return { text: parts.join(''), bodyCount: ranges.length, maskedCharacters };
}

module.exports = { maskGoFunctionBodies };
