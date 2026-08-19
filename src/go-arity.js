'use strict';

const { maskGoFunctionBodies } = require('./go-source');

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

function skipTrivia(source, start) {
    let index = start;
    let sawNewline = false;
    while (index < source.length) {
        const character = source[index];
        const next = source[index + 1];
        if (/\s/.test(character)) {
            if (character === '\n' || character === '\r') sawNewline = true;
            index += 1;
            continue;
        }
        if (character === '/' && next === '/') {
            const newline = source.indexOf('\n', index + 2);
            if (newline === -1) return { index: source.length, sawNewline: true };
            sawNewline = true;
            index = newline + 1;
            continue;
        }
        if (character === '/' && next === '*') {
            const close = source.indexOf('*/', index + 2);
            const end = close === -1 ? source.length : close + 2;
            if (/\r|\n/.test(source.slice(index, end))) sawNewline = true;
            index = end;
            continue;
        }
        break;
    }
    return { index, sawNewline };
}

function readIdentifier(source, start) {
    if (!isIdentifierStart(source[start])) return null;
    let end = start + 1;
    while (isIdentifierPart(source[end])) end += 1;
    return { value: source.slice(start, end), end };
}

function findMatchingDelimiter(source, openIndex) {
    const pairs = new Map([
        ['(', ')'],
        ['[', ']'],
        ['{', '}'],
    ]);
    const expected = pairs.get(source[openIndex]);
    if (!expected) return -1;
    const stack = [expected];
    for (let index = openIndex + 1; index < source.length; ) {
        const character = source[index];
        const next = source[index + 1];
        if (character === '/' && next === '/') {
            const newline = source.indexOf('\n', index + 2);
            index = newline === -1 ? source.length : newline + 1;
            continue;
        }
        if (character === '/' && next === '*') {
            const close = source.indexOf('*/', index + 2);
            index = close === -1 ? source.length : close + 2;
            continue;
        }
        if (character === '"' || character === "'" || character === '`') {
            index = skipQuoted(source, index);
            continue;
        }
        if (pairs.has(character)) {
            stack.push(pairs.get(character));
        } else if (character === ')' || character === ']' || character === '}') {
            if (stack[stack.length - 1] !== character) return -1;
            stack.pop();
            if (stack.length === 0) return index;
        }
        index += 1;
    }
    return -1;
}

function countDelimitedItems(source, openIndex, closeIndex) {
    const pairs = new Map([
        ['(', ')'],
        ['[', ']'],
        ['{', '}'],
    ]);
    const stack = [];
    let count = 0;
    let hasToken = false;
    for (let index = openIndex + 1; index < closeIndex; ) {
        const character = source[index];
        const next = source[index + 1];
        if (/\s/.test(character)) {
            index += 1;
            continue;
        }
        if (character === '/' && next === '/') {
            const newline = source.indexOf('\n', index + 2);
            index = newline === -1 ? closeIndex : Math.min(closeIndex, newline + 1);
            continue;
        }
        if (character === '/' && next === '*') {
            const close = source.indexOf('*/', index + 2);
            index = close === -1 ? closeIndex : Math.min(closeIndex, close + 2);
            continue;
        }
        if (character === '"' || character === "'" || character === '`') {
            hasToken = true;
            index = skipQuoted(source, index);
            continue;
        }
        if (pairs.has(character)) {
            stack.push(pairs.get(character));
            hasToken = true;
        } else if (character === ')' || character === ']' || character === '}') {
            if (stack[stack.length - 1] !== character) return null;
            stack.pop();
            hasToken = true;
        } else if (character === ',' && stack.length === 0) {
            if (hasToken) count += 1;
            hasToken = false;
        } else {
            hasToken = true;
        }
        index += 1;
    }
    if (stack.length > 0) return null;
    return count + (hasToken ? 1 : 0);
}

function parseMethodArity(source, parameterOpen) {
    const parameterClose = findMatchingDelimiter(source, parameterOpen);
    if (parameterClose === -1) return null;
    const params = countDelimitedItems(source, parameterOpen, parameterClose);
    if (params === null) return null;

    const afterParameters = skipTrivia(source, parameterClose + 1);
    if (afterParameters.sawNewline) return { params, results: 0 };
    const resultStart = afterParameters.index;
    if (source[resultStart] === '(') {
        const resultClose = findMatchingDelimiter(source, resultStart);
        if (resultClose === -1) return null;
        const results = countDelimitedItems(source, resultStart, resultClose);
        return results === null ? null : { params, results };
    }
    if (
        resultStart >= source.length ||
        source[resultStart] === '{' ||
        source[resultStart] === '}' ||
        source[resultStart] === ';'
    ) {
        return { params, results: 0 };
    }
    return { params, results: 1 };
}

function scanImplementationArities(source, methodName) {
    const arities = [];
    let uncertain = false;
    for (let index = 0; index < source.length; ) {
        const character = source[index];
        const next = source[index + 1];
        if (character === '/' && next === '/') {
            const newline = source.indexOf('\n', index + 2);
            index = newline === -1 ? source.length : newline + 1;
            continue;
        }
        if (character === '/' && next === '*') {
            const close = source.indexOf('*/', index + 2);
            index = close === -1 ? source.length : close + 2;
            continue;
        }
        if (character === '"' || character === "'" || character === '`') {
            index = skipQuoted(source, index);
            continue;
        }
        const identifier = readIdentifier(source, index);
        if (!identifier) {
            index += 1;
            continue;
        }
        index = identifier.end;
        if (identifier.value !== 'func') continue;

        const receiverStart = skipTrivia(source, index).index;
        if (source[receiverStart] !== '(') continue;
        const receiverClose = findMatchingDelimiter(source, receiverStart);
        if (receiverClose === -1) continue;
        const nameStart = skipTrivia(source, receiverClose + 1).index;
        const name = readIdentifier(source, nameStart);
        if (!name || name.value !== methodName) {
            index = receiverClose + 1;
            continue;
        }
        const parameters = skipTrivia(source, name.end);
        if (parameters.sawNewline || source[parameters.index] !== '(') {
            uncertain = true;
            index = name.end;
            continue;
        }
        const arity = parseMethodArity(source, parameters.index);
        if (arity) arities.push(arity);
        else uncertain = true;
        index = parameters.index + 1;
    }
    return { arities, uncertain };
}

function scanInterfaceArities(source, methodName) {
    const arities = [];
    let uncertain = false;
    for (let index = 0; index < source.length; ) {
        const character = source[index];
        const next = source[index + 1];
        if (character === '/' && next === '/') {
            const newline = source.indexOf('\n', index + 2);
            index = newline === -1 ? source.length : newline + 1;
            continue;
        }
        if (character === '/' && next === '*') {
            const close = source.indexOf('*/', index + 2);
            index = close === -1 ? source.length : close + 2;
            continue;
        }
        if (character === '"' || character === "'" || character === '`') {
            index = skipQuoted(source, index);
            continue;
        }
        const identifier = readIdentifier(source, index);
        if (!identifier) {
            index += 1;
            continue;
        }
        index = identifier.end;
        if (identifier.value !== methodName) continue;
        const parameters = skipTrivia(source, identifier.end);
        if (parameters.sawNewline || source[parameters.index] !== '(') continue;
        const arity = parseMethodArity(source, parameters.index);
        if (arity) arities.push(arity);
        else uncertain = true;
        index = parameters.index + 1;
    }
    return { arities, uncertain };
}

function scanMethodDeclarationArities(source, methodName, kind) {
    const declarations = maskGoFunctionBodies(source).text;
    return kind === 'implementation'
        ? scanImplementationArities(declarations, methodName)
        : scanInterfaceArities(declarations, methodName);
}

function hasCompatibleMethodArity(source, methodName, kind, wanted) {
    if (
        !wanted ||
        !Number.isInteger(wanted.params) ||
        !Number.isInteger(wanted.results)
    ) {
        return true;
    }
    const scanned = scanMethodDeclarationArities(source, methodName, kind);
    if (scanned.uncertain || scanned.arities.length === 0) return true;
    return scanned.arities.some(
        (arity) => arity.params === wanted.params && arity.results === wanted.results
    );
}

module.exports = {
    hasCompatibleMethodArity,
    scanMethodDeclarationArities,
};
