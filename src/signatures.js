'use strict';

const BUILTIN_INTERFACES = new Map([
    ['error', new Map([['Error', '()(string)']])],
    ['any', new Map()],
    ['io.Reader', new Map([['Read', '([]byte)(int,error)']])],
    ['io.Writer', new Map([['Write', '([]byte)(int,error)']])],
    ['io.Closer', new Map([['Close', '()(error)']])],
    [
        'io.ReadWriter',
        new Map([
            ['Read', '([]byte)(int,error)'],
            ['Write', '([]byte)(int,error)'],
        ]),
    ],
    [
        'io.ReadCloser',
        new Map([
            ['Read', '([]byte)(int,error)'],
            ['Close', '()(error)'],
        ]),
    ],
    [
        'io.WriteCloser',
        new Map([
            ['Write', '([]byte)(int,error)'],
            ['Close', '()(error)'],
        ]),
    ],
    [
        'io.ReadWriteCloser',
        new Map([
            ['Read', '([]byte)(int,error)'],
            ['Write', '([]byte)(int,error)'],
            ['Close', '()(error)'],
        ]),
    ],
    ['fmt.Stringer', new Map([['String', '()(string)']])],
    [
        'sync.Locker',
        new Map([
            ['Lock', '()()'],
            ['Unlock', '()()'],
        ]),
    ],
    [
        'context.Context',
        new Map([
            ['Deadline', '()(@{time}.Time,bool)'],
            ['Done', '()(<-chan(struct{}))'],
            ['Err', '()(error)'],
            ['Value', '(interface{})(interface{})'],
        ]),
    ],
]);

for (const [name, methods] of [...BUILTIN_INTERFACES]) {
    const dot = name.indexOf('.');
    if (dot !== -1) {
        BUILTIN_INTERFACES.set(`@{${name.slice(0, dot)}}.${name.slice(dot + 1)}`, methods);
    }
}

function stripPackageQualifiers(signature) {
    return signature
        .replace(/@\{[^}]+\}\.([A-Za-z_]\w*)/g, '$1')
        .replace(/[A-Za-z_]\w*\.([A-Za-z_]\w*)/g, '$1');
}

function splitTopLevel(value, delimiter) {
    const parts = [];
    let start = 0;
    let paren = 0;
    let bracket = 0;
    let brace = 0;
    for (let i = 0; i < value.length; i++) {
        const character = value[i];
        if (character === '(') paren += 1;
        else if (character === ')') paren -= 1;
        else if (character === '[') bracket += 1;
        else if (character === ']') bracket -= 1;
        else if (character === '{') brace += 1;
        else if (character === '}') brace -= 1;
        else if (
            character === delimiter &&
            paren === 0 &&
            bracket === 0 &&
            brace === 0
        ) {
            parts.push(value.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(value.slice(start));
    return parts;
}

function extractBalanced(value, start) {
    const open = value.indexOf('(', start);
    if (open === -1) return null;
    let depth = 0;
    for (let i = open; i < value.length; i++) {
        if (value[i] === '(') depth += 1;
        else if (value[i] === ')') {
            depth -= 1;
            if (depth === 0) {
                return { inner: value.slice(open + 1, i), end: i + 1 };
            }
        }
    }
    return null;
}

function splitNormalizedSignature(signature) {
    const parameters = extractBalanced(signature, 0);
    if (!parameters) return null;
    const results = extractBalanced(signature.slice(parameters.end), 0);
    const split = (value) =>
        splitTopLevel(value, ',')
            .map((part) => part.trim())
            .filter(Boolean);
    return {
        params: split(parameters.inner),
        results: results ? split(results.inner) : [],
    };
}

function looseTypeSlotEqual(left, right) {
    if (left === right) return true;
    if (stripPackageQualifiers(left) !== stripPackageQualifiers(right)) return false;
    const qualifiers = (slot) =>
        [...slot.matchAll(/(?:@\{([^}]+)\}|([A-Za-z_]\w*))\.[A-Za-z_]\w*/g)].map(
            (match) => match[1] || match[2]
        );
    const leftQualifiers = qualifiers(left);
    const rightQualifiers = qualifiers(right);
    if (leftQualifiers.length === rightQualifiers.length) {
        for (let i = 0; i < leftQualifiers.length; i++) {
            if (leftQualifiers[i] !== rightQualifiers[i]) return false;
        }
    }
    return true;
}

function looseSignatureEqual(left, right) {
    if (left === right) return true;
    const leftSlots = splitNormalizedSignature(left);
    const rightSlots = splitNormalizedSignature(right);
    if (!leftSlots || !rightSlots) {
        return stripPackageQualifiers(left) === stripPackageQualifiers(right);
    }
    if (
        leftSlots.params.length !== rightSlots.params.length ||
        leftSlots.results.length !== rightSlots.results.length
    ) {
        return false;
    }
    return (
        leftSlots.params.every((slot, index) =>
            looseTypeSlotEqual(slot, rightSlots.params[index])
        ) &&
        leftSlots.results.every((slot, index) =>
            looseTypeSlotEqual(slot, rightSlots.results[index])
        )
    );
}

function tokenizeType(value) {
    const root = [];
    const stack = [{ open: '', nodes: root }];
    const openToClose = new Map([
        ['(', ')'],
        ['[', ']'],
        ['{', '}'],
    ]);
    const closing = new Set(openToClose.values());
    let index = 0;
    const append = (node) => stack[stack.length - 1].nodes.push(node);
    while (index < value.length) {
        const rest = value.slice(index);
        const character = value[index];
        if (/\s/.test(character)) {
            index += 1;
            continue;
        }
        if (openToClose.has(character)) {
            const group = { kind: 'group', open: character, close: openToClose.get(character), nodes: [] };
            append(group);
            stack.push(group);
            index += 1;
            continue;
        }
        if (closing.has(character)) {
            if (stack.length > 1 && stack[stack.length - 1].close === character) stack.pop();
            else append({ kind: 'atom', text: character });
            index += 1;
            continue;
        }
        const canonical = rest.match(/^@\{[^}]+\}\.[_\p{L}][_\p{L}\p{N}]*/u);
        if (canonical) {
            append({ kind: 'atom', text: canonical[0] });
            index += canonical[0].length;
            continue;
        }
        const marker = rest.match(/^\$\d+/);
        if (marker) {
            append({ kind: 'atom', text: marker[0] });
            index += marker[0].length;
            continue;
        }
        const qualified = rest.match(
            /^[_\p{L}][_\p{L}\p{N}]*\.[_\p{L}][_\p{L}\p{N}]*/u
        );
        if (qualified) {
            append({ kind: 'atom', text: qualified[0] });
            index += qualified[0].length;
            continue;
        }
        const identifier = rest.match(/^[_\p{L}][_\p{L}\p{N}]*/u);
        if (identifier) {
            append({ kind: 'atom', text: identifier[0] });
            index += identifier[0].length;
            continue;
        }
        if (rest.startsWith('...') || rest.startsWith('<-')) {
            const operator = rest.startsWith('...') ? '...' : '<-';
            append({ kind: 'atom', text: operator });
            index += operator.length;
            continue;
        }
        if (character === '`' || character === '"' || character === "'") {
            const quote = character;
            let end = index + 1;
            while (end < value.length) {
                if (quote !== '`' && value[end] === '\\') {
                    end += 2;
                    continue;
                }
                if (value[end++] === quote) break;
            }
            append({ kind: 'atom', text: value.slice(index, end) });
            index = end;
            continue;
        }
        append({ kind: 'atom', text: character });
        index += 1;
    }
    return root;
}

function renderTypeNodes(nodes) {
    return nodes
        .map((node) =>
            node.kind === 'group'
                ? `${node.open}${renderTypeNodes(node.nodes)}${node.close}`
                : node.text
        )
        .join('');
}

function matchGenericType(pattern, candidate, markers, bindings, loose) {
    const patternNodes = tokenizeType(pattern);
    const candidateNodes = tokenizeType(candidate);
    const atomEqual = (left, right) =>
        left === right || (loose && looseTypeSlotEqual(left, right));
    const bindingEqual = (left, right) =>
        left === right || (loose && looseTypeSlotEqual(left, right));

    const matchSequence = (wanted, actual, current, wantedIndex, actualIndex) => {
        if (wantedIndex === wanted.length) {
            return actualIndex === actual.length ? current : null;
        }
        const wantedNode = wanted[wantedIndex];
        if (wantedNode.kind === 'atom' && markers.has(wantedNode.text)) {
            const existing = current.get(wantedNode.text);
            for (let end = actualIndex + 1; end <= actual.length; end++) {
                const slice = actual.slice(actualIndex, end);
                if (
                    slice.some(
                        (node) =>
                            node.kind === 'atom' && (node.text === ',' || node.text === ';')
                    )
                ) {
                    break;
                }
                const value = renderTypeNodes(slice);
                if (existing !== undefined && !bindingEqual(existing, value)) continue;
                const next = new Map(current);
                if (existing === undefined) next.set(wantedNode.text, value);
                const matched = matchSequence(wanted, actual, next, wantedIndex + 1, end);
                if (matched) return matched;
            }
            return null;
        }
        if (actualIndex >= actual.length) return null;
        const actualNode = actual[actualIndex];
        if (wantedNode.kind === 'group') {
            if (
                actualNode.kind !== 'group' ||
                wantedNode.open !== actualNode.open ||
                wantedNode.close !== actualNode.close
            ) {
                return null;
            }
            const nested = matchSequence(wantedNode.nodes, actualNode.nodes, current, 0, 0);
            if (!nested) return null;
            return matchSequence(wanted, actual, nested, wantedIndex + 1, actualIndex + 1);
        }
        if (actualNode.kind !== 'atom' || !atomEqual(wantedNode.text, actualNode.text)) {
            return null;
        }
        return matchSequence(wanted, actual, current, wantedIndex + 1, actualIndex + 1);
    };

    return matchSequence(patternNodes, candidateNodes, new Map(bindings || []), 0, 0);
}

function inferTypeParameterBindings(interfaceMethods, typeMethods, typeParameters, options) {
    const parameters = typeParameters || [];
    const markers = new Set(parameters.map((parameter) => parameter.marker));
    let bindings = new Map((options && options.bindings) || []);
    for (const [name, signature] of interfaceMethods) {
        const implementation = typeMethods.get(name);
        if (implementation === undefined) return null;
        const wanted = splitNormalizedSignature(signature);
        const actual = splitNormalizedSignature(implementation);
        if (
            !wanted ||
            !actual ||
            wanted.params.length !== actual.params.length ||
            wanted.results.length !== actual.results.length
        ) {
            return null;
        }
        for (const section of ['params', 'results']) {
            for (let index = 0; index < wanted[section].length; index++) {
                bindings = matchGenericType(
                    wanted[section][index],
                    actual[section][index],
                    markers,
                    bindings,
                    !!(options && options.loose)
                );
                if (!bindings) return null;
            }
        }
    }
    return bindings;
}

function substituteTypeParameters(value, bindings) {
    if (!bindings || bindings.size === 0) return value;
    return value.replace(/\$\d+/g, (marker) => bindings.get(marker) || marker);
}

function satisfies(interfaceMethods, typeMethods, options) {
    if (interfaceMethods.size === 0) return false;
    const unresolved = (options && options.unresolved) || [];
    if (unresolved.length > 0 && !(options && options.allowUnresolved)) return false;
    if (options && options.typeParameters && options.typeParameters.length > 0) {
        return !!inferTypeParameterBindings(
            interfaceMethods,
            typeMethods,
            options.typeParameters,
            options
        );
    }
    for (const [name, signature] of interfaceMethods) {
        const implementation = typeMethods.get(name);
        if (implementation === undefined) return false;
        if (implementation === signature) continue;
        if (options && options.loose && looseSignatureEqual(implementation, signature)) continue;
        return false;
    }
    return true;
}

function resolveInterfaceMethods(interfaceName, interfaces, seen, cache) {
    const visiting = seen || new Set();
    const resolvedCache = cache || new Map();
    if (visiting.has(interfaceName)) return { methods: new Map(), unresolved: [] };
    if (resolvedCache.has(interfaceName)) return resolvedCache.get(interfaceName);
    visiting.add(interfaceName);

    const declaration = interfaces.get(interfaceName);
    if (!declaration) {
        const missing = { methods: new Map(), unresolved: [interfaceName] };
        resolvedCache.set(interfaceName, missing);
        return missing;
    }

    const methods = new Map(declaration.methods);
    const unresolved = [];
    let constraint = !!declaration.constraint;
    for (const embed of declaration.embeds || []) {
        if (BUILTIN_INTERFACES.has(embed)) {
            for (const [name, signature] of BUILTIN_INTERFACES.get(embed)) {
                if (!methods.has(name)) methods.set(name, signature);
            }
            continue;
        }
        if (embed.includes('.')) {
            unresolved.push(embed);
            continue;
        }
        const target = declaration.packageKey ? `${declaration.packageKey}\0${embed}` : embed;
        const nested = resolveInterfaceMethods(
            target,
            interfaces,
            new Set(visiting),
            resolvedCache
        );
        constraint = constraint || !!nested.constraint;
        let nestedMethods = nested.methods;
        if (declaration.genericEmbeds && declaration.genericEmbeds.has(embed)) {
            const argumentsList =
                declaration.embedArguments && declaration.embedArguments.get(embed);
            if (
                !argumentsList ||
                argumentsList.length !== (nested.typeParameters || []).length
            ) {
                unresolved.push(embed);
                continue;
            }
            const bindings = new Map(
                nested.typeParameters.map((parameter, index) => [
                    parameter.marker,
                    argumentsList[index],
                ])
            );
            nestedMethods = new Map(
                [...nested.methods].map(([name, signature]) => [
                    name,
                    substituteTypeParameters(signature, bindings),
                ])
            );
        }
        for (const [name, signature] of nestedMethods) {
            if (!methods.has(name)) methods.set(name, signature);
        }
        unresolved.push(...nested.unresolved);
    }
    const resolved = {
        methods,
        unresolved,
        typeParameters: declaration.typeParameters || [],
        constraint,
    };
    resolvedCache.set(interfaceName, resolved);
    return resolved;
}

function resolveTypeMethods(typeName, types, seen) {
    const visiting = seen || new Set();
    if (visiting.has(typeName)) return new Map();
    visiting.add(typeName);
    const declaration = types.get(typeName);
    if (!declaration) return new Map();
    const methods = new Map(declaration.methods);
    for (const embed of declaration.embeds || []) {
        if (embed.includes('.')) continue;
        const target = declaration.packageKey ? `${declaration.packageKey}\0${embed}` : embed;
        for (const [name, signature] of resolveTypeMethods(target, types, visiting)) {
            if (!methods.has(name)) methods.set(name, signature);
        }
    }
    return methods;
}

module.exports = {
    BUILTIN_INTERFACES,
    inferTypeParameterBindings,
    looseSignatureEqual,
    resolveInterfaceMethods,
    resolveTypeMethods,
    satisfies,
    splitNormalizedSignature,
    splitTopLevel,
    stripPackageQualifiers,
    substituteTypeParameters,
};
