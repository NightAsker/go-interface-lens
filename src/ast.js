'use strict';

const { parseGoSyntaxTree } = require('./tree-sitter-runtime');
const { maskGoFunctionBodies } = require('./go-source');

const PREDECLARED_CONCRETE_TYPES = new Set([
    'bool', 'byte', 'complex64', 'complex128', 'float32', 'float64',
    'int', 'int8', 'int16', 'int32', 'int64', 'rune', 'string',
    'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
]);

function namedChildren(node) {
    return node ? node.namedChildren.filter(Boolean) : [];
}

function field(node, name) {
    return node && node.childForFieldName(name);
}

function fields(node, name) {
    return node ? node.childrenForFieldName(name).filter(Boolean) : [];
}

function defaultImportAlias(importPath) {
    const parts = importPath.split('/').filter(Boolean);
    let alias = parts.pop() || '';
    if (/^v\d+$/.test(alias) && parts.length > 0) alias = parts.pop();
    return alias;
}

function decodeImportPath(node) {
    if (!node) return '';
    const text = node.text;
    if (text.startsWith('`')) return text.slice(1, -1);
    try {
        return JSON.parse(text);
    } catch (_) {
        return text.replace(/^"|"$/g, '');
    }
}

function extractImports(root) {
    const imports = new Map();
    for (const declaration of namedChildren(root)) {
        if (declaration.type !== 'import_declaration') continue;
        for (const spec of declaration.descendantsOfType('import_spec').filter(Boolean)) {
            const importPath = decodeImportPath(field(spec, 'path'));
            if (!importPath) continue;
            const name = field(spec, 'name');
            const alias = name ? name.text : defaultImportAlias(importPath);
            if (alias && alias !== '_' && alias !== '.') imports.set(alias, importPath);
        }
    }
    return imports;
}

function canonicalQualifiedType(node, packageName, imports) {
    const qualifier = field(node, 'package');
    const name = field(node, 'name');
    if (!qualifier || !name) return node.text.replace(/\s+/g, '');
    if (qualifier.text === packageName) return name.text;
    const importPath = imports.get(qualifier.text);
    return importPath ? `@{${importPath}}.${name.text}` : `${qualifier.text}.${name.text}`;
}

function normalizeParameterSlots(node, packageName, imports, typeVariables) {
    if (!node) return [];
    const slots = [];
    for (const declaration of namedChildren(node)) {
        if (
            declaration.type !== 'parameter_declaration' &&
            declaration.type !== 'variadic_parameter_declaration'
        ) {
            continue;
        }
        const type = field(declaration, 'type');
        if (!type) continue;
        const normalized =
            (declaration.type === 'variadic_parameter_declaration' ? '...' : '') +
            normalizeTypeNode(type, packageName, imports, typeVariables);
        const count = Math.max(1, fields(declaration, 'name').length);
        for (let i = 0; i < count; i++) slots.push(normalized);
    }
    return slots;
}

function normalizeMethodSignature(node, packageName, imports, typeVariables) {
    const parameters = normalizeParameterSlots(
        field(node, 'parameters'),
        packageName,
        imports,
        typeVariables
    );
    const result = field(node, 'result');
    const results = result
        ? result.type === 'parameter_list'
            ? normalizeParameterSlots(result, packageName, imports, typeVariables)
            : [normalizeTypeNode(result, packageName, imports, typeVariables)]
        : [];
    return `(${parameters.join(',')})(${results.join(',')})`;
}

function normalizeFunctionType(node, packageName, imports, typeVariables) {
    const parameters = normalizeParameterSlots(
        field(node, 'parameters'),
        packageName,
        imports,
        typeVariables
    );
    const result = field(node, 'result');
    if (!result) return `func(${parameters.join(',')})`;
    if (result.type === 'parameter_list') {
        return `func(${parameters.join(',')})(${normalizeParameterSlots(result, packageName, imports, typeVariables).join(',')})`;
    }
    return `func(${parameters.join(',')})${normalizeTypeNode(result, packageName, imports, typeVariables)}`;
}

function normalizeInterfaceType(node, packageName, imports, typeVariables) {
    const members = [];
    for (const member of namedChildren(node)) {
        if (member.type === 'method_elem') {
            const name = field(member, 'name');
            if (name) {
                members.push(
                    `${name.text}${normalizeMethodSignature(member, packageName, imports, typeVariables)}`
                );
            }
        } else if (member.type === 'type_elem') {
            members.push(normalizeTypeNode(member, packageName, imports, typeVariables));
        }
    }
    members.sort();
    return `interface{${members.join(';')}}`;
}

function normalizeStructField(node, packageName, imports, typeVariables) {
    const type = field(node, 'type');
    if (!type) return [];
    const normalizedType = normalizeTypeNode(type, packageName, imports, typeVariables);
    const tag = field(node, 'tag');
    const suffix = tag ? tag.text : '';
    const names = fields(node, 'name');
    if (names.length === 0) return [`${normalizedType}${suffix}`];
    return names.map((name) => `${name.text}:${normalizedType}${suffix}`);
}

function normalizeStructType(node, packageName, imports, typeVariables) {
    const list = namedChildren(node).find((child) => child.type === 'field_declaration_list');
    const members = [];
    for (const declaration of namedChildren(list)) {
        if (declaration.type === 'field_declaration') {
            members.push(...normalizeStructField(declaration, packageName, imports, typeVariables));
        }
    }
    return `struct{${members.join(';')}}`;
}

function normalizeTypeNode(node, packageName, imports, typeVariables) {
    if (!node) return '';
    if (node.type === 'type_identifier' && typeVariables && typeVariables.has(node.text)) {
        return typeVariables.get(node.text);
    }
    if (node.type === 'qualified_type') {
        return canonicalQualifiedType(node, packageName, imports);
    }
    if (node.type === 'function_type') {
        return normalizeFunctionType(node, packageName, imports, typeVariables);
    }
    if (node.type === 'interface_type') {
        return normalizeInterfaceType(node, packageName, imports, typeVariables);
    }
    if (node.type === 'struct_type') {
        return normalizeStructType(node, packageName, imports, typeVariables);
    }
    if (node.type === 'channel_type') {
        const value = field(node, 'value');
        const prefix = node.text.trimStart().startsWith('<-chan')
            ? '<-chan'
            : node.text.trimStart().startsWith('chan<-')
                ? 'chan<-'
                : 'chan';
        return `${prefix}(${normalizeTypeNode(value, packageName, imports, typeVariables)})`;
    }
    if (node.childCount === 0) return node.text.replace(/\s+/g, '');

    const parts = [];
    for (const child of node.children.filter(Boolean)) {
        if (child.type === 'comment') continue;
        parts.push(
            child.isNamed
                ? normalizeTypeNode(child, packageName, imports, typeVariables)
                : child.text.replace(/\s+/g, '')
        );
    }
    return parts.join('');
}

function canonicalNamedReference(node, imports, state) {
    if (!node) return null;
    const info = state || { pointer: false, generic: false };
    if (node.type === 'pointer_type') {
        info.pointer = true;
        return canonicalNamedReference(node.firstNamedChild, imports, info);
    }
    if (node.type === 'generic_type') {
        info.generic = true;
        return canonicalNamedReference(field(node, 'type'), imports, info);
    }
    if (node.type === 'parenthesized_type') {
        return canonicalNamedReference(node.firstNamedChild, imports, info);
    }
    if (node.type === 'qualified_type') {
        const qualifier = field(node, 'package');
        const name = field(node, 'name');
        if (!qualifier || !name) return null;
        const importPath = imports.get(qualifier.text);
        return {
            name: importPath ? `@{${importPath}}.${name.text}` : `${qualifier.text}.${name.text}`,
            ...info,
        };
    }
    if (node.type === 'type_identifier') return { name: node.text, ...info };
    return null;
}

function newTypeEntry(line, character) {
    return {
        line,
        character,
        methods: new Map(),
        methodLines: new Map(),
        methodCharacters: new Map(),
        pointerMethods: new Set(),
        fieldNames: new Set(),
        embeds: [],
        pointerEmbeds: new Set(),
        genericEmbeds: new Set(),
        embedArguments: new Map(),
        typeParameters: [],
        underlying: null,
        declared: false,
        struct: false,
    };
}

function genericTypeArguments(node, packageName, imports, typeVariables) {
    const argumentsNode = field(node, 'type_arguments');
    if (!argumentsNode) return [];
    return namedChildren(argumentsNode).map((argument) =>
        normalizeTypeNode(argument, packageName, imports, typeVariables)
    );
}

function parseTypeParameters(spec, packageName, imports) {
    const list = field(spec, 'type_parameters');
    if (!list) return { parameters: [], variables: new Map() };
    const declarations = namedChildren(list).filter(
        (node) => node.type === 'type_parameter_declaration'
    );
    const names = declarations.flatMap((declaration) =>
        fields(declaration, 'name').map((name) => name.text)
    );
    const variables = new Map(names.map((name, index) => [name, `$${index}`]));
    const parameters = [];
    for (const declaration of declarations) {
        const constraintNode = field(declaration, 'type');
        const constraint = normalizeTypeNode(
            constraintNode,
            packageName,
            imports,
            variables
        );
        const interfaceNode =
            constraintNode && constraintNode.descendantsOfType('interface_type')[0];
        const interfaceConstraint = interfaceNode
            ? parseInterfaceType(
                  interfaceNode,
                  [],
                  packageName,
                  imports,
                  variables
              )
            : null;
        const constraintMethods = interfaceConstraint
            ? interfaceConstraint.methods
            : new Map();
        const constraintTypeElements = interfaceConstraint
            ? interfaceConstraint.typeElements
            : [];
        for (const name of fields(declaration, 'name')) {
            parameters.push({
                name: name.text,
                marker: variables.get(name.text),
                constraint,
                constraintMethods,
                constraintTypeElements,
            });
        }
    }
    return { parameters, variables };
}

function parseInterfaceType(typeNode, typeParameters, packageName, imports, typeVariables) {
    const methods = new Map();
    const methodLines = new Map();
    const methodCharacters = new Map();
    const embeds = [];
    const genericEmbeds = new Set();
    const embedArguments = new Map();
    const typeElements = [];
    let constraint = false;

    for (const member of namedChildren(typeNode)) {
        if (member.type === 'method_elem') {
            const name = field(member, 'name');
            if (!name) continue;
            methods.set(
                name.text,
                normalizeMethodSignature(member, packageName, imports, typeVariables)
            );
            methodLines.set(name.text, name.startPosition.row);
            methodCharacters.set(name.text, name.startPosition.column);
            continue;
        }
        if (member.type !== 'type_elem') continue;
        typeElements.push(normalizeTypeNode(member, packageName, imports, typeVariables));
        const type = member.firstNamedChild;
        if (
            member.text.includes('|') ||
            member.descendantsOfType('negated_type').length > 0 ||
            (type &&
                type.type === 'type_identifier' &&
                (type.text === 'comparable' || PREDECLARED_CONCRETE_TYPES.has(type.text))) ||
            (type &&
                type.type !== 'type_identifier' &&
                type.type !== 'qualified_type' &&
                type.type !== 'generic_type')
        ) {
            constraint = true;
        }
        const reference = canonicalNamedReference(type, imports);
        if (!reference) continue;
        embeds.push(reference.name);
        if (reference.generic) {
            genericEmbeds.add(reference.name);
            embedArguments.set(
                reference.name,
                genericTypeArguments(type, packageName, imports, typeVariables)
            );
        }
    }

    return {
        generic: typeParameters.length > 0,
        typeParameters,
        methods,
        methodLines,
        methodCharacters,
        embeds,
        genericEmbeds,
        embedArguments,
        typeElements,
        constraint,
    };
}

function parseStructType(typeNode, packageName, imports, typeVariables) {
    const embeds = [];
    const fieldNames = new Set();
    const pointerEmbeds = new Set();
    const genericEmbeds = new Set();
    const embedArguments = new Map();
    const list = namedChildren(typeNode).find((child) => child.type === 'field_declaration_list');
    for (const declaration of namedChildren(list)) {
        if (declaration.type !== 'field_declaration') continue;
        const names = fields(declaration, 'name');
        if (names.length > 0) {
            for (const name of names) fieldNames.add(name.text);
            continue;
        }
        const reference = canonicalNamedReference(field(declaration, 'type'), imports);
        if (!reference) continue;
        if (declaration.text.trimStart().startsWith('*')) reference.pointer = true;
        const qualifiedName = reference.name.match(/\.([_\p{L}][_\p{L}\p{N}]*)$/u);
        fieldNames.add(qualifiedName ? qualifiedName[1] : reference.name);
        embeds.push(reference.name);
        if (reference.pointer) pointerEmbeds.add(reference.name);
        if (reference.generic) {
            genericEmbeds.add(reference.name);
            embedArguments.set(
                reference.name,
                genericTypeArguments(
                    field(declaration, 'type'),
                    packageName,
                    imports,
                    typeVariables
                )
            );
        }
    }
    return { fieldNames, embeds, pointerEmbeds, genericEmbeds, embedArguments };
}

function receiverTypeVariables(receiverType) {
    let current = receiverType;
    while (current && (current.type === 'pointer_type' || current.type === 'parenthesized_type')) {
        current = current.firstNamedChild;
    }
    if (!current || current.type !== 'generic_type') return new Map();
    const argumentsNode = field(current, 'type_arguments');
    const variables = new Map();
    for (const [index, argument] of namedChildren(argumentsNode).entries()) {
        const identifier = argument.firstNamedChild;
        if (identifier && identifier.type === 'type_identifier') {
            variables.set(identifier.text, `$${index}`);
        }
    }
    return variables;
}

function packageNameFromRoot(root) {
    const clause = namedChildren(root).find((node) => node.type === 'package_clause');
    const name = clause && clause.firstNamedChild;
    return name ? name.text : null;
}

function buildDeclarationIR(root) {
    const packageName = packageNameFromRoot(root);
    const imports = extractImports(root);
    const interfaces = new Map();
    const types = new Map();
    const aliases = new Map();

    const ensureType = (name, location) => {
        if (!types.has(name)) {
            types.set(name, newTypeEntry(location.startPosition.row, location.startPosition.column));
        }
        return types.get(name);
    };

    for (const declaration of namedChildren(root)) {
        if (declaration.type === 'type_declaration') {
            for (const spec of namedChildren(declaration)) {
                if (spec.type !== 'type_spec' && spec.type !== 'type_alias') continue;
                const nameNode = field(spec, 'name');
                const typeNode = field(spec, 'type');
                if (!nameNode || !typeNode) continue;
                const { parameters: typeParameters, variables: typeVariables } =
                    parseTypeParameters(spec, packageName, imports);

                if (typeNode.type === 'interface_type') {
                    interfaces.set(nameNode.text, {
                        line: nameNode.startPosition.row,
                        character: nameNode.startPosition.column,
                        ...parseInterfaceType(
                            typeNode,
                            typeParameters,
                            packageName,
                            imports,
                            typeVariables
                        ),
                    });
                    continue;
                }

                const entry = ensureType(nameNode.text, nameNode);
                entry.declared = true;
                entry.line = nameNode.startPosition.row;
                entry.character = nameNode.startPosition.column;
                entry.typeParameters = typeParameters;
                entry.underlying = normalizeTypeNode(
                    typeNode,
                    packageName,
                    imports,
                    typeVariables
                );
                if (typeNode.type === 'struct_type') {
                    entry.struct = true;
                    Object.assign(
                        entry,
                        parseStructType(typeNode, packageName, imports, typeVariables)
                    );
                }
                if (spec.type === 'type_alias') {
                    aliases.set(
                        nameNode.text,
                        normalizeTypeNode(typeNode, packageName, imports, typeVariables)
                    );
                    const reference = canonicalNamedReference(typeNode, imports);
                    if (reference) {
                        entry.embeds = [reference.name];
                        if (reference.pointer) entry.pointerEmbeds.add(reference.name);
                        if (reference.generic) {
                            entry.genericEmbeds.add(reference.name);
                            entry.embedArguments.set(
                                reference.name,
                                genericTypeArguments(
                                    typeNode,
                                    packageName,
                                    imports,
                                    typeVariables
                                )
                            );
                        }
                    }
                }
            }
            continue;
        }

        if (declaration.type !== 'method_declaration') continue;
        const receiver = field(declaration, 'receiver');
        const receiverDeclaration = namedChildren(receiver)[0];
        const receiverType = receiverDeclaration && field(receiverDeclaration, 'type');
        const receiverInfo = canonicalNamedReference(receiverType, imports);
        const methodName = field(declaration, 'name');
        if (!receiverInfo || !methodName || receiverInfo.name.includes('.')) continue;
        const entry = ensureType(receiverInfo.name, methodName);
        entry.methods.set(
            methodName.text,
            normalizeMethodSignature(
                declaration,
                packageName,
                imports,
                receiverTypeVariables(receiverType)
            )
        );
        entry.methodLines.set(methodName.text, methodName.startPosition.row);
        entry.methodCharacters.set(methodName.text, methodName.startPosition.column);
        if (receiverInfo.pointer) entry.pointerMethods.add(methodName.text);
    }

    const constraintCache = new Map();
    const isConstraintOnly = (name, seen) => {
        if (constraintCache.has(name)) return constraintCache.get(name);
        const info = interfaces.get(name);
        if (!info) return false;
        const visiting = seen || new Set();
        if (visiting.has(name)) return false;
        visiting.add(name);
        const result =
            info.constraint ||
            info.embeds.some(
                (embed) =>
                    !embed.includes('.') &&
                    ((types.has(embed) && !interfaces.has(embed)) ||
                        isConstraintOnly(embed, new Set(visiting)))
            );
        constraintCache.set(name, result);
        return result;
    };
    for (const [name, info] of interfaces) {
        info.constraint = isConstraintOnly(name);
    }

    return {
        syntax: 'declaration-ast-v1',
        parser: 'tree-sitter-go-wasm',
        hasSyntaxError: root.hasError,
        packageName,
        imports,
        aliases,
        interfaces,
        types,
    };
}

async function parseGoFile(text) {
    const tree = await parseGoSyntaxTree(text);
    try {
        return buildDeclarationIR(tree.rootNode);
    } finally {
        tree.delete();
    }
}

/**
 * Parse declaration metadata without sending function body contents through
 * Tree-sitter. Invalid/incomplete declarations fall back to the original text
 * so editor-time syntax recovery remains unchanged.
 */
async function parseGoDeclarations(text) {
    const masked = maskGoFunctionBodies(text);
    let parsed = await parseGoFile(masked.text);
    let fallback = false;
    if (masked.bodyCount > 0 && parsed.hasSyntaxError) {
        parsed = await parseGoFile(text);
        fallback = true;
    }
    return {
        parsed,
        optimization: {
            declarationOnly: true,
            bodyCount: masked.bodyCount,
            maskedCharacters: masked.maskedCharacters,
            fallback,
        },
    };
}

function mapToEntries(map, valueMapper) {
    return [...(map || new Map())].map(([key, value]) => [key, valueMapper ? valueMapper(value) : value]);
}

function serializeParsedFile(parsed) {
    const serializeTypeParameter = (parameter) => ({
        ...parameter,
        constraintMethods: mapToEntries(parameter.constraintMethods),
    });
    const serializeType = (info) => ({
        ...info,
        methods: mapToEntries(info.methods),
        methodLines: mapToEntries(info.methodLines),
        methodCharacters: mapToEntries(info.methodCharacters),
        pointerMethods: [...(info.pointerMethods || [])],
        fieldNames: [...(info.fieldNames || [])],
        pointerEmbeds: [...(info.pointerEmbeds || [])],
        genericEmbeds: [...(info.genericEmbeds || [])],
        embedArguments: mapToEntries(info.embedArguments),
        typeParameters: (info.typeParameters || []).map(serializeTypeParameter),
    });
    return {
        syntax: parsed.syntax,
        parser: parsed.parser,
        hasSyntaxError: !!parsed.hasSyntaxError,
        packageName: parsed.packageName,
        imports: mapToEntries(parsed.imports),
        aliases: mapToEntries(parsed.aliases),
        interfaces: mapToEntries(parsed.interfaces, serializeType),
        types: mapToEntries(parsed.types, serializeType),
    };
}

function deserializeParsedFile(serialized) {
    const deserializeTypeParameter = (parameter) => ({
        ...parameter,
        constraintMethods: new Map(parameter.constraintMethods || []),
    });
    const deserializeType = (info) => ({
        ...info,
        methods: new Map(info.methods || []),
        methodLines: new Map(info.methodLines || []),
        methodCharacters: new Map(info.methodCharacters || []),
        pointerMethods: new Set(info.pointerMethods || []),
        fieldNames: new Set(info.fieldNames || []),
        pointerEmbeds: new Set(info.pointerEmbeds || []),
        genericEmbeds: new Set(info.genericEmbeds || []),
        embedArguments: new Map(info.embedArguments || []),
        typeParameters: (info.typeParameters || []).map(deserializeTypeParameter),
    });
    return {
        syntax: serialized.syntax,
        parser: serialized.parser,
        hasSyntaxError: !!serialized.hasSyntaxError,
        packageName: serialized.packageName,
        imports: new Map(serialized.imports || []),
        aliases: new Map(serialized.aliases || []),
        interfaces: new Map((serialized.interfaces || []).map(([key, value]) => [key, deserializeType(value)])),
        types: new Map((serialized.types || []).map(([key, value]) => [key, deserializeType(value)])),
    };
}

module.exports = {
    parseGoFile,
    parseGoDeclarations,
    buildDeclarationIR,
    serializeParsedFile,
    deserializeParsedFile,
};
