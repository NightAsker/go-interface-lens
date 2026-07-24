'use strict';

const { extractImportAliases } = require('./parser');

function isIdentStart(ch) {
    return ch === '_' || /[A-Za-z]/.test(ch) || (ch && ch.charCodeAt(0) > 127);
}

function isIdentPart(ch) {
    return isIdentStart(ch) || /[0-9]/.test(ch || '');
}

function tokenizeGo(text) {
    const tokens = [];
    let i = 0;
    let line = 0;
    let character = 0;

    const push = (kind, value, start, startLine, startCharacter) => {
        tokens.push({ kind, value, start, end: i, line: startLine, character: startCharacter });
    };
    const advance = () => {
        const ch = text[i++];
        if (ch === '\n') {
            line += 1;
            character = 0;
        } else {
            character += 1;
        }
        return ch;
    };

    while (i < text.length) {
        const ch = text[i];
        if (ch === '\r') {
            advance();
            continue;
        }
        if (ch === '\n') {
            const start = i;
            const startLine = line;
            const startCharacter = character;
            advance();
            push('newline', '\n', start, startLine, startCharacter);
            continue;
        }
        if (/\s/.test(ch)) {
            advance();
            continue;
        }
        if (ch === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') advance();
            continue;
        }
        if (ch === '/' && text[i + 1] === '*') {
            advance();
            advance();
            while (i < text.length) {
                if (text[i] === '*' && text[i + 1] === '/') {
                    advance();
                    advance();
                    break;
                }
                if (text[i] === '\n') {
                    const start = i;
                    const startLine = line;
                    const startCharacter = character;
                    advance();
                    push('newline', '\n', start, startLine, startCharacter);
                } else {
                    advance();
                }
            }
            continue;
        }

        const start = i;
        const startLine = line;
        const startCharacter = character;
        if (isIdentStart(ch)) {
            advance();
            while (i < text.length && isIdentPart(text[i])) advance();
            push('identifier', text.slice(start, i), start, startLine, startCharacter);
            continue;
        }
        if (/[0-9]/.test(ch)) {
            advance();
            while (i < text.length && /[A-Za-z0-9_.]/.test(text[i])) advance();
            push('number', text.slice(start, i), start, startLine, startCharacter);
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            const quote = advance();
            while (i < text.length) {
                const current = advance();
                if (quote !== '`' && current === '\\' && i < text.length) {
                    advance();
                    continue;
                }
                if (current === quote) break;
            }
            push('string', text.slice(start, i), start, startLine, startCharacter);
            continue;
        }

        const three = text.slice(i, i + 3);
        const two = text.slice(i, i + 2);
        if (three === '...') {
            advance();
            advance();
            advance();
            push('punctuation', three, start, startLine, startCharacter);
            continue;
        }
        if (['<-', ':=', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '&^', '++', '--'].includes(two)) {
            advance();
            advance();
            push('punctuation', two, start, startLine, startCharacter);
            continue;
        }
        advance();
        push('punctuation', ch, start, startLine, startCharacter);
    }
    return tokens;
}

function newTypeEntry(line, character) {
    return {
        line,
        character,
        methods: new Map(),
        methodLines: new Map(),
        methodCharacters: new Map(),
        pointerMethods: new Set(),
        embeds: [],
        pointerEmbeds: new Set(),
        genericEmbeds: new Set(),
        declared: false,
        struct: false,
    };
}

function significant(tokens, index) {
    let i = index;
    while (i < tokens.length && tokens[i].kind === 'newline') i += 1;
    return i;
}

function matching(tokens, openIndex, open, close) {
    let depth = 0;
    for (let i = openIndex; i < tokens.length; i++) {
        if (tokens[i].value === open) depth += 1;
        else if (tokens[i].value === close) {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return tokens.length - 1;
}

const TYPE_PREFIX_KEYWORDS = new Set(['chan', 'map', 'func', 'struct', 'interface']);

function splitTopLevelTokens(tokens, delimiter) {
    const parts = [];
    let start = 0;
    let paren = 0;
    let bracket = 0;
    let brace = 0;
    for (let i = 0; i < tokens.length; i++) {
        const value = tokens[i].value;
        if (value === '(') paren += 1;
        else if (value === ')') paren -= 1;
        else if (value === '[') bracket += 1;
        else if (value === ']') bracket -= 1;
        else if (value === '{') brace += 1;
        else if (value === '}') brace -= 1;
        else if (value === delimiter && paren === 0 && bracket === 0 && brace === 0) {
            parts.push(tokens.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(tokens.slice(start));
    return parts.map((part) => part.filter((token) => token.kind !== 'newline'));
}

function classifyField(tokens) {
    if (tokens.length === 1 && tokens[0].kind === 'identifier') return { kind: 'bare', tokens };
    const first = tokens[0];
    const second = tokens[1];
    if (!first || first.kind !== 'identifier' || !second || TYPE_PREFIX_KEYWORDS.has(first.value)) {
        return { kind: 'type', tokens };
    }

    // A selector or a complete generic instantiation starts with an unnamed
    // type. Every other valid token after an identifier starts the type of a
    // named field: x *T, x []T, x <-chan T, x q.T, x Box[T], and so on.
    if (second.value === '.') return { kind: 'type', tokens };
    if (second.value === '[') {
        const close = matching(tokens, 1, '[', ']');
        if (close === tokens.length - 1) return { kind: 'type', tokens };
    }
    return { kind: 'named', tokens: tokens.slice(1) };
}

function appendCanonical(out, state, text, startsWord, endsWord) {
    if (state.word && startsWord) out.push(' ');
    out.push(text);
    state.word = endsWord;
}

function normalizeInterfaceTokens(tokens, openIndex, closeIndex, packageName, imports) {
    const members = [];
    for (const member of splitMembers(tokens, openIndex + 1, closeIndex)) {
        if (member[0] && member[0].kind === 'identifier' && member[1] && member[1].value === '(') {
            members.push(
                member[0].value +
                    normalizeSignatureTokens(member, 1, member.length, packageName, imports)
            );
        } else {
            members.push(normalizeTypeTokens(member, packageName, imports));
        }
    }
    // Method and embedded-type order does not participate in interface type
    // identity. Sorting also makes differently formatted literals compare.
    members.sort();
    return `interface{${members.join(';')}}`;
}

function normalizeTypeTokens(tokens, packageName, imports) {
    const out = [];
    const state = { word: false };
    for (let i = 0; i < tokens.length;) {
        const token = tokens[i];
        if (token.kind === 'newline') {
            i += 1;
            continue;
        }

        if (token.value === 'func') {
            const open = significant(tokens, i + 1);
            if (tokens[open] && tokens[open].value === '(') {
                const close = matching(tokens, open, '(', ')');
                appendCanonical(out, state, 'func', true, true);
                appendCanonical(
                    out,
                    state,
                    `(${normalizeFieldList(tokens.slice(open + 1, close), packageName, imports)})`,
                    false,
                    false
                );
                i = close + 1;
                const result = significant(tokens, i);
                if (tokens[result] && tokens[result].value === '(') {
                    const resultClose = matching(tokens, result, '(', ')');
                    appendCanonical(
                        out,
                        state,
                        `(${normalizeFieldList(tokens.slice(result + 1, resultClose), packageName, imports)})`,
                        false,
                        false
                    );
                    i = resultClose + 1;
                }
                continue;
            }
        }

        if (token.value === 'interface') {
            const open = significant(tokens, i + 1);
            if (tokens[open] && tokens[open].value === '{') {
                const close = matching(tokens, open, '{', '}');
                appendCanonical(
                    out,
                    state,
                    normalizeInterfaceTokens(tokens, open, close, packageName, imports),
                    true,
                    false
                );
                i = close + 1;
                continue;
            }
        }

        if (
            token.kind === 'identifier' &&
            tokens[i + 1] && tokens[i + 1].value === '.' &&
            tokens[i + 2] && tokens[i + 2].kind === 'identifier'
        ) {
            const target = tokens[i + 2].value;
            const importPath = imports && imports.get(token.value);
            const qualified = token.value === packageName
                ? target
                : importPath
                    ? `@{${importPath}}.${target}`
                    : `${token.value}.${target}`;
            appendCanonical(out, state, qualified, true, true);
            i += 3;
            continue;
        }

        const word = token.kind === 'identifier' || token.kind === 'number' || token.kind === 'string';
        appendCanonical(out, state, token.value, word, word);
        i += 1;
    }
    return out.join('');
}

function normalizeFieldList(tokens, packageName, imports) {
    const fields = splitTopLevelTokens(tokens, ',').filter((field) => field.length > 0);
    if (fields.length === 0) return '';
    const classified = fields.map(classifyField);
    const usesNames = classified.some((field) => field.kind === 'named');
    const types = new Array(classified.length);
    let sharedType = null;
    for (let i = classified.length - 1; i >= 0; i--) {
        const field = classified[i];
        if (field.kind === 'named') {
            sharedType = normalizeTypeTokens(field.tokens, packageName, imports);
            types[i] = sharedType;
        } else if (usesNames && field.kind === 'bare' && sharedType !== null) {
            types[i] = sharedType;
        } else {
            types[i] = normalizeTypeTokens(field.tokens, packageName, imports);
        }
    }
    return types.join(',');
}

function normalizeSignatureTokens(tokens, openIndex, endIndex, packageName, imports) {
    const paramsClose = matching(tokens, openIndex, '(', ')');
    const params = normalizeFieldList(tokens.slice(openIndex + 1, paramsClose), packageName, imports);
    const resultIndex = significant(tokens, paramsClose + 1);
    if (resultIndex >= endIndex) return `(${params})()`;
    if (tokens[resultIndex] && tokens[resultIndex].value === '(') {
        const resultClose = matching(tokens, resultIndex, '(', ')');
        return `(${params})(${normalizeFieldList(tokens.slice(resultIndex + 1, resultClose), packageName, imports)})`;
    }
    return `(${params})(${normalizeTypeTokens(tokens.slice(resultIndex, endIndex), packageName, imports)})`;
}

function canonicalReference(parts, imports) {
    const significantParts = parts.filter((token) => token.kind !== 'newline');
    let pointer = false;
    while (
        significantParts[0] &&
        (significantParts[0].value === '*' || significantParts[0].value === '(')
    ) {
        if (significantParts.shift().value === '*') pointer = true;
    }
    const values = significantParts.map((token) => token.value);
    const identifiers = [];
    for (let i = 0; i < values.length; i++) {
        if (significantParts[i] && significantParts[i].kind === 'identifier') {
            identifiers.push({ value: values[i], index: i });
        }
        if (values[i] === '[') break;
    }
    if (identifiers.length === 0) return null;
    let name;
    if (
        identifiers.length >= 2 &&
        values[identifiers[0].index + 1] === '.' &&
        identifiers[1].index === identifiers[0].index + 2
    ) {
        const qualifier = identifiers[0].value;
        const importPath = imports.get(qualifier);
        name = importPath ? `@{${importPath}}.${identifiers[1].value}` : `${qualifier}.${identifiers[1].value}`;
    } else {
        name = identifiers[0].value;
    }
    return { name, pointer, generic: values.includes('[') };
}

function canonicalNamedReference(parts, imports) {
    const tokens = parts.filter((token) => token.kind !== 'newline');
    let start = 0;
    let end = tokens.length;
    while (tokens[start] && tokens[start].value === '(' && tokens[end - 1] && tokens[end - 1].value === ')') {
        const close = matching(tokens, start, '(', ')');
        if (close !== end - 1) break;
        start += 1;
        end -= 1;
    }
    if (tokens[start] && tokens[start].value === '*') start += 1;
    if (!tokens[start] || tokens[start].kind !== 'identifier') return null;
    let cursor = start + 1;
    if (
        tokens[cursor] && tokens[cursor].value === '.' &&
        tokens[cursor + 1] && tokens[cursor + 1].kind === 'identifier'
    ) {
        cursor += 2;
    }
    if (tokens[cursor] && tokens[cursor].value === '[') {
        cursor = matching(tokens, cursor, '[', ']') + 1;
    }
    if (cursor !== end) return null;
    return canonicalReference(tokens.slice(0, end), imports);
}

function splitMembers(tokens, start, end) {
    const members = [];
    let memberStart = start;
    let paren = 0;
    let bracket = 0;
    let brace = 0;
    for (let i = start; i < end; i++) {
        const value = tokens[i].value;
        if (value === '(') paren += 1;
        else if (value === ')') paren -= 1;
        else if (value === '[') bracket += 1;
        else if (value === ']') bracket -= 1;
        else if (value === '{') brace += 1;
        else if (value === '}') brace -= 1;
        const separator = (tokens[i].kind === 'newline' || value === ';') && paren === 0 && bracket === 0 && brace === 0;
        if (separator) {
            if (memberStart < i) members.push(tokens.slice(memberStart, i));
            memberStart = i + 1;
        }
    }
    if (memberStart < end) members.push(tokens.slice(memberStart, end));
    return members.map((member) => member.filter((token) => token.kind !== 'newline')).filter((member) => member.length > 0);
}

function normalizedMethodSignature(tokens, openIndex, endIndex, packageName, imports) {
    return normalizeSignatureTokens(tokens, openIndex, endIndex, packageName, imports);
}

function parseInterfaceBody(tokens, openIndex, closeIndex, packageName, imports) {
    const methods = new Map();
    const methodLines = new Map();
    const methodCharacters = new Map();
    const embeds = [];
    const genericEmbeds = new Set();
    let constraint = false;
    for (const member of splitMembers(tokens, openIndex + 1, closeIndex)) {
        const first = member[0];
        if (!first) continue;
        if (member.some((token) => token.value === '|' || token.value === '~')) constraint = true;
        if (first.kind === 'identifier' && member[1] && member[1].value === '(') {
            methods.set(
                first.value,
                normalizedMethodSignature(member, 1, member.length, packageName, imports)
            );
            methodLines.set(first.value, first.line);
            methodCharacters.set(first.value, first.character);
            continue;
        }
        const reference = canonicalReference(member, imports);
        if (reference) {
            embeds.push(reference.name);
            if (reference.generic) genericEmbeds.add(reference.name);
        }
    }
    return { methods, methodLines, methodCharacters, embeds, genericEmbeds, constraint };
}

function parseStructBody(tokens, openIndex, closeIndex, imports) {
    const embeds = [];
    const pointerEmbeds = new Set();
    const genericEmbeds = new Set();
    for (const member of splitMembers(tokens, openIndex + 1, closeIndex)) {
        const withoutTag = member.filter((token) => token.kind !== 'string');
        if (withoutTag.length === 0) continue;
        const reference = canonicalReference(withoutTag, imports);
        if (!reference) continue;

        const identifiersBeforeTypeArgs = withoutTag.filter(
            (token, index) =>
                token.kind === 'identifier' &&
                withoutTag.slice(0, index).every((previous) => previous.value !== '[')
        );
        const qualified = withoutTag.some((token) => token.value === '.');
        const expectedIdentifiers = qualified ? 2 : 1;
        if (identifiersBeforeTypeArgs.length !== expectedIdentifiers) continue;
        embeds.push(reference.name);
        if (reference.pointer) pointerEmbeds.add(reference.name);
        if (reference.generic) genericEmbeds.add(reference.name);
    }
    return { embeds, pointerEmbeds, genericEmbeds };
}

function receiverInfo(tokens, openIndex, closeIndex) {
    const receiver = tokens.slice(openIndex + 1, closeIndex).filter((token) => token.kind !== 'newline');
    const star = receiver.findIndex((token) => token.value === '*');
    if (star >= 0) {
        const type = receiver.slice(star + 1).find((token) => token.kind === 'identifier');
        return type ? { name: type.value, pointer: true } : null;
    }
    const identifiers = receiver.filter((token) => token.kind === 'identifier');
    if (identifiers.length === 0) return null;
    const type = identifiers.length > 1 ? identifiers[1] : identifiers[0];
    return { name: type.value, pointer: false };
}

function typeExpressionEnd(tokens, startIndex) {
    const start = significant(tokens, startIndex);
    const token = tokens[start];
    if (!token) return start;

    if (token.value === '(') return matching(tokens, start, '(', ')') + 1;
    if (token.value === '*') return typeExpressionEnd(tokens, start + 1);
    if (token.value === '[') {
        const close = matching(tokens, start, '[', ']');
        return typeExpressionEnd(tokens, close + 1);
    }
    if (token.value === 'map') {
        const open = significant(tokens, start + 1);
        if (!tokens[open] || tokens[open].value !== '[') return start + 1;
        return typeExpressionEnd(tokens, matching(tokens, open, '[', ']') + 1);
    }
    if (token.value === 'chan') {
        let element = significant(tokens, start + 1);
        if (tokens[element] && tokens[element].value === '<-') {
            element = significant(tokens, element + 1);
        }
        return typeExpressionEnd(tokens, element);
    }
    if (token.value === '<-') {
        const channel = significant(tokens, start + 1);
        if (tokens[channel] && tokens[channel].value === 'chan') {
            return typeExpressionEnd(tokens, channel + 1);
        }
        return start + 1;
    }
    if (token.value === 'func') {
        const open = significant(tokens, start + 1);
        if (!tokens[open] || tokens[open].value !== '(') return start + 1;
        const paramsEnd = matching(tokens, open, '(', ')') + 1;
        const result = significant(tokens, paramsEnd);
        if (!tokens[result] || ['{', ';', '}'].includes(tokens[result].value)) return paramsEnd;
        if (tokens[result].value === '(') return matching(tokens, result, '(', ')') + 1;
        return typeExpressionEnd(tokens, result);
    }
    if (token.value === 'interface' || token.value === 'struct') {
        const open = significant(tokens, start + 1);
        return tokens[open] && tokens[open].value === '{'
            ? matching(tokens, open, '{', '}') + 1
            : start + 1;
    }

    if (token.kind !== 'identifier') return start + 1;
    let end = significant(tokens, start + 1);
    if (
        tokens[end] && tokens[end].value === '.' &&
        tokens[significant(tokens, end + 1)] &&
        tokens[significant(tokens, end + 1)].kind === 'identifier'
    ) {
        end = significant(tokens, end + 1) + 1;
    }
    end = significant(tokens, end);
    if (tokens[end] && tokens[end].value === '[') {
        return matching(tokens, end, '[', ']') + 1;
    }
    return end;
}

function signatureEnd(tokens, openIndex) {
    const paramsClose = matching(tokens, openIndex, '(', ')');
    const result = significant(tokens, paramsClose + 1);
    if (!tokens[result] || ['{', ';', '}'].includes(tokens[result].value)) {
        return paramsClose + 1;
    }
    if (tokens[result].value === '(') return matching(tokens, result, '(', ')') + 1;
    return typeExpressionEnd(tokens, result);
}

function parseGoFile(text) {
    const tokens = tokenizeGo(text);
    const imports = extractImportAliases(text);
    const interfaces = new Map();
    const types = new Map();
    const aliases = new Map();
    let packageName = null;

    const ensureType = (name, token) => {
        if (!types.has(name)) types.set(name, newTypeEntry(token.line, token.character));
        return types.get(name);
    };

    const parseTypeSpec = (start, grouped) => {
        let i = significant(tokens, start);
        const nameToken = tokens[i];
        if (!nameToken || nameToken.kind !== 'identifier') return i + 1;
        const name = nameToken.value;
        i = significant(tokens, i + 1);
        let generic = false;
        if (tokens[i] && tokens[i].value === '[') {
            generic = true;
            i = significant(tokens, matching(tokens, i, '[', ']') + 1);
        }
        let alias = false;
        if (tokens[i] && tokens[i].value === '=') {
            alias = true;
            i = significant(tokens, i + 1);
        }
        const kind = tokens[i] && tokens[i].value;
        if (kind === 'interface') {
            const open = significant(tokens, i + 1);
            if (!tokens[open] || tokens[open].value !== '{') return open;
            const close = matching(tokens, open, '{', '}');
            const body = parseInterfaceBody(tokens, open, close, packageName, imports);
            interfaces.set(name, {
                line: nameToken.line,
                character: nameToken.character,
                generic,
                ...body,
            });
            return close + 1;
        }
        if (kind === 'struct') {
            const open = significant(tokens, i + 1);
            const entry = ensureType(name, nameToken);
            entry.declared = true;
            entry.struct = true;
            entry.line = nameToken.line;
            entry.character = nameToken.character;
            if (tokens[open] && tokens[open].value === '{') {
                const close = matching(tokens, open, '{', '}');
                const body = parseStructBody(tokens, open, close, imports);
                entry.embeds = body.embeds;
                entry.pointerEmbeds = body.pointerEmbeds;
                entry.genericEmbeds = body.genericEmbeds;
                return close + 1;
            }
            return open;
        }

        const entry = ensureType(name, nameToken);
        entry.declared = true;
        entry.line = nameToken.line;
        entry.character = nameToken.character;
        let end = i;
        let paren = 0;
        let bracket = 0;
        let brace = 0;
        for (; end < tokens.length; end++) {
            if (tokens[end].value === '(') paren += 1;
            else if (tokens[end].value === ')') {
                if (grouped && paren === 0 && bracket === 0 && brace === 0) break;
                paren -= 1;
            } else if (tokens[end].value === '[') bracket += 1;
            else if (tokens[end].value === ']') bracket -= 1;
            else if (tokens[end].value === '{') brace += 1;
            else if (tokens[end].value === '}') brace -= 1;
            if (
                paren === 0 && bracket === 0 && brace === 0 &&
                (tokens[end].kind === 'newline' || tokens[end].value === ';')
            ) {
                break;
            }
        }
        if (alias) {
            const aliasTokens = tokens.slice(i, end);
            const reference = canonicalNamedReference(aliasTokens, imports);
            aliases.set(name, normalizeTypeTokens(aliasTokens, packageName, imports));
            if (reference) {
                entry.embeds = [reference.name];
                if (reference.pointer) entry.pointerEmbeds.add(reference.name);
                if (reference.generic) entry.genericEmbeds.add(reference.name);
            }
        }
        return end;
    };

    let i = 0;
    while (i < tokens.length) {
        i = significant(tokens, i);
        const token = tokens[i];
        if (!token) break;
        if (token.value === 'package') {
            const name = tokens[significant(tokens, i + 1)];
            if (name && name.kind === 'identifier') packageName = name.value;
            i += 2;
            continue;
        }
        if (token.value === 'type') {
            let next = significant(tokens, i + 1);
            if (tokens[next] && tokens[next].value === '(') {
                const close = matching(tokens, next, '(', ')');
                next += 1;
                while (next < close) next = parseTypeSpec(next, true);
                i = close + 1;
            } else {
                i = parseTypeSpec(next, false);
            }
            continue;
        }
        if (token.value === 'func') {
            let next = significant(tokens, i + 1);
            if (!tokens[next] || tokens[next].value !== '(') {
                const nameIndex = next;
                let open = significant(tokens, nameIndex + 1);
                if (tokens[open] && tokens[open].value === '[') {
                    open = significant(tokens, matching(tokens, open, '[', ']') + 1);
                }
                if (tokens[open] && tokens[open].value === '(') {
                    const end = signatureEnd(tokens, open);
                    const body = significant(tokens, end);
                    i = tokens[body] && tokens[body].value === '{'
                        ? matching(tokens, body, '{', '}') + 1
                        : end;
                } else {
                    i += 1;
                }
                continue;
            }
            const receiverClose = matching(tokens, next, '(', ')');
            const receiver = receiverInfo(tokens, next, receiverClose);
            const methodIndex = significant(tokens, receiverClose + 1);
            const methodToken = tokens[methodIndex];
            if (!receiver || !methodToken || methodToken.kind !== 'identifier') {
                i = receiverClose + 1;
                continue;
            }
            let open = significant(tokens, methodIndex + 1);
            if (tokens[open] && tokens[open].value === '[') open = significant(tokens, matching(tokens, open, '[', ']') + 1);
            if (!tokens[open] || tokens[open].value !== '(') {
                i = methodIndex + 1;
                continue;
            }
            const end = signatureEnd(tokens, open);
            const entry = ensureType(receiver.name, methodToken);
            entry.methods.set(
                methodToken.value,
                normalizedMethodSignature(tokens, open, end, packageName, imports)
            );
            entry.methodLines.set(methodToken.value, methodToken.line);
            entry.methodCharacters.set(methodToken.value, methodToken.character);
            if (receiver.pointer) entry.pointerMethods.add(methodToken.value);
            const body = significant(tokens, end);
            i = tokens[body] && tokens[body].value === '{'
                ? matching(tokens, body, '{', '}') + 1
                : end;
            continue;
        }
        i += 1;
    }

    return { syntax: 'declaration-ast-v1', packageName, imports, aliases, interfaces, types };
}

function mapToEntries(map, valueMapper) {
    return [...(map || new Map())].map(([key, value]) => [key, valueMapper ? valueMapper(value) : value]);
}

function serializeParsedFile(parsed) {
    const serializeType = (info) => ({
        ...info,
        methods: mapToEntries(info.methods),
        methodLines: mapToEntries(info.methodLines),
        methodCharacters: mapToEntries(info.methodCharacters),
        pointerMethods: [...(info.pointerMethods || [])],
        pointerEmbeds: [...(info.pointerEmbeds || [])],
        genericEmbeds: [...(info.genericEmbeds || [])],
    });
    return {
        syntax: parsed.syntax,
        packageName: parsed.packageName,
        imports: mapToEntries(parsed.imports),
        aliases: mapToEntries(parsed.aliases),
        interfaces: mapToEntries(parsed.interfaces, serializeType),
        types: mapToEntries(parsed.types, serializeType),
    };
}

function deserializeParsedFile(serialized) {
    const deserializeType = (info) => ({
        ...info,
        methods: new Map(info.methods || []),
        methodLines: new Map(info.methodLines || []),
        methodCharacters: new Map(info.methodCharacters || []),
        pointerMethods: new Set(info.pointerMethods || []),
        pointerEmbeds: new Set(info.pointerEmbeds || []),
        genericEmbeds: new Set(info.genericEmbeds || []),
    });
    return {
        syntax: serialized.syntax,
        packageName: serialized.packageName,
        imports: new Map(serialized.imports || []),
        aliases: new Map(serialized.aliases || []),
        interfaces: new Map((serialized.interfaces || []).map(([key, value]) => [key, deserializeType(value)])),
        types: new Map((serialized.types || []).map(([key, value]) => [key, deserializeType(value)])),
    };
}

module.exports = {
    tokenizeGo,
    parseGoFile,
    serializeParsedFile,
    deserializeParsedFile,
};
