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
            ['Done', '()(<-chanstruct{})'],
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

function satisfies(interfaceMethods, typeMethods, options) {
    if (interfaceMethods.size === 0) return false;
    const unresolved = (options && options.unresolved) || [];
    if (unresolved.length > 0 && !(options && options.allowUnresolved)) return false;
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
        for (const [name, signature] of nested.methods) {
            if (!methods.has(name)) methods.set(name, signature);
        }
        unresolved.push(...nested.unresolved);
    }
    const resolved = { methods, unresolved };
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
    looseSignatureEqual,
    resolveInterfaceMethods,
    resolveTypeMethods,
    satisfies,
    splitNormalizedSignature,
    splitTopLevel,
    stripPackageQualifiers,
};
