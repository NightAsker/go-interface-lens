'use strict';

const { codeLines, braceDelta } = require('./tokenizer');

/**
 * Go source parsing helpers built on the lightweight tokenizer.
 *
 * These functions extract enough structure to reason about implicit interface
 * satisfaction WITHOUT running gopls: interface method sets (with normalized
 * signatures and embedded-interface expansion) and receiver method definitions
 * (with normalized signatures and embedded-struct field capture).
 *
 * Everything is text/regex based, but signatures are compared, not just method
 * names, which removes the biggest source of false positives in the original
 * implementation.
 */

// A method line inside an interface, e.g. `Read(p []byte) (n int, err error)`.
// Captures the method name; the remainder is the raw signature.
const IFACE_METHOD_RE = /^\s*([A-Z_a-z]\w*)\s*\(/;

// A bare embedded name inside an interface or struct, e.g. `io.Reader`,
// `Reader`, or a pointer-embedded struct field `*Base`. A leading `*` is
// optional and stripped by the caller: for method promotion `struct { *Base }`
// promotes `Base`'s methods just like `struct { Base }`. Optional trailing type
// arguments on a generic embed (e.g. `Base[T]`) are tolerated and ignored.
const EMBED_RE = /^\s*\*?\s*([A-Z_a-z][\w.]*)(?:\s*\[[^\]]*\])?\s*$/;

// Leading tokens that indicate a bare (unnamed) type, not a parameter name.
const TYPE_KEYWORDS = new Set(['chan', 'map', 'func', 'struct', 'interface']);

// Built-in / well-known standard-library interfaces whose method sets are fixed
// and therefore can be expanded when embedded, instead of being treated as
// unresolved. This lets e.g. `type Exception interface { error; Code() int }`
// resolve to the full {Error, Code} method set so implementations are matched,
// and likewise for the ubiquitous `io` / `sync` / `context` interfaces that
// projects routinely embed. Expanding them (rather than marking them
// unresolved) means `findImplementations` can surface real implementers while
// still rejecting types that are missing the embedded methods (e.g. a type with
// only `Extra()` is NOT reported as satisfying `interface { io.Reader; Extra() string }`).
//
// Empty method sets (`any` / `interface{}`) contribute nothing but must not be
// flagged as unresolved either.
//
// Keys are listed under every spelling a file may use: the bare name (valid for
// the predeclared `error`/`any`) and, for stdlib interfaces, the qualified
// `pkg.Name` form as it appears when embedded.
const BUILTIN_INTERFACES = new Map([
    ['error', new Map([['Error', normalizeSignatureLazy('() string')]])],
    ['any', new Map()],

    // io
    ['io.Reader', new Map([['Read', normalizeSignatureLazy('(p []byte) (n int, err error)')]])],
    ['io.Writer', new Map([['Write', normalizeSignatureLazy('(p []byte) (n int, err error)')]])],
    ['io.Closer', new Map([['Close', normalizeSignatureLazy('() error')]])],
    [
        'io.ReadWriter',
        new Map([
            ['Read', normalizeSignatureLazy('(p []byte) (n int, err error)')],
            ['Write', normalizeSignatureLazy('(p []byte) (n int, err error)')],
        ]),
    ],
    [
        'io.ReadCloser',
        new Map([
            ['Read', normalizeSignatureLazy('(p []byte) (n int, err error)')],
            ['Close', normalizeSignatureLazy('() error')],
        ]),
    ],
    [
        'io.WriteCloser',
        new Map([
            ['Write', normalizeSignatureLazy('(p []byte) (n int, err error)')],
            ['Close', normalizeSignatureLazy('() error')],
        ]),
    ],
    [
        'io.ReadWriteCloser',
        new Map([
            ['Read', normalizeSignatureLazy('(p []byte) (n int, err error)')],
            ['Write', normalizeSignatureLazy('(p []byte) (n int, err error)')],
            ['Close', normalizeSignatureLazy('() error')],
        ]),
    ],
    ['fmt.Stringer', new Map([['String', normalizeSignatureLazy('() string')]])],

    // sync
    [
        'sync.Locker',
        new Map([
            ['Lock', normalizeSignatureLazy('()')],
            ['Unlock', normalizeSignatureLazy('()')],
        ]),
    ],

    // context
    [
        'context.Context',
        new Map([
            ['Deadline', normalizeSignatureLazy('() (deadline time.Time, ok bool)')],
            ['Done', normalizeSignatureLazy('() <-chan struct{}')],
            ['Err', normalizeSignatureLazy('() error')],
            ['Value', normalizeSignatureLazy('(key any) any')],
        ]),
    ],
]);

// normalizeSignature is defined below; wrap to allow use in the const above.
function normalizeSignatureLazy(raw) {
    return normalizeSignature(raw);
}

// Receiver method definition: func (r *Type[...]) Method(...) ...
// Captures receiver type (without pointer / type params) and method name.
const RECEIVER_METHOD_RE =
    /^\s*func\s+\(\s*(?:[A-Z_a-z]\w*\s+)?\*?\s*([A-Z_a-z]\w*)(?:\s*\[[^\]]*\])?\s*\)\s+([A-Z_a-z]\w*)\s*\(/;

// Interface declarations. Two spellings: the standard `type X interface {` and
// the form inside a `type ( ... )` block (`X interface {`). These are the SINGLE
// source of truth shared by both the parser (what gets indexed) and the CodeLens
// provider (what shows a lens); keeping one copy prevents the lens and the index
// from drifting apart. `INTERFACE_STD_RE` and `INTERFACE_BLOCK_RE` each capture
// the interface name.
const INTERFACE_STD_RE = /^\s*type\s+([A-Z_a-z]\w*)\s+interface\s*\{/;
const INTERFACE_BLOCK_RE = /^\s*([A-Z_a-z]\w*)\s+interface\s*\{/;
// The interface method-line regex is IFACE_METHOD_RE (defined above); it is
// exported so the CodeLens provider shares the exact same matcher.

/**
 * Normalize a method signature so that syntactically different but semantically
 * identical signatures compare equal. We drop parameter names, collapse
 * whitespace, and keep only the shape: `(paramTypes)(resultTypes)`.
 *
 * This is intentionally conservative: it will not resolve type aliases or
 * imported package renames, but it catches the common "same name, wrong
 * arguments" false positives.
 *
 * @param {string} raw signature text starting at the opening paren of params
 * @returns {string} normalized signature key
 */
function normalizeSignature(raw) {
    const params = extractBalanced(raw, 0);
    if (!params) return '()';
    let rest = raw.slice(params.end).trim();

    let results = '';
    if (rest.startsWith('(')) {
        const r = extractBalanced(rest, 0);
        results = r ? r.inner : '';
    } else if (rest.length > 0) {
        // Single unparenthesized result type, stop at line end / comment.
        results = rest;
    }

    return `(${normalizeTypeList(params.inner, true)})(${normalizeTypeList(results, true)})`;
}

/**
 * Remove package qualifiers from a normalized signature string, turning
 * occurrences of `pkg.Type` into `Type`. Only a single-level qualifier is
 * possible in Go type syntax, and the leading segment must be a plain
 * identifier, so this is safe against selectors inside e.g. `map[k.T]v.U`.
 * @param {string} sig
 * @returns {string}
 */
function stripPackageQualifiers(sig) {
    // Replace an identifier followed by '.' and an identifier start with just
    // the trailing identifier. Applied repeatedly is unnecessary since Go has
    // at most one qualifier level per type name.
    return sig.replace(/[A-Za-z_]\w*\.([A-Za-z_]\w*)/g, '$1');
}

/**
 * Remove ONLY the self-package qualifier from a signature string, turning
 * `pkg.Type` into `Type` when (and only when) `pkg` is the file's own package
 * name. Inside a package, `pkg.Type` and `Type` denote the exact same type, so
 * an interface declared with the bare `*FlowContext` and an implementation that
 * (redundantly but legally) writes `*processengine.FlowContext` must compare
 * equal under strict matching. Unlike `stripPackageQualifiers`, this leaves
 * genuine cross-package qualifiers (e.g. `time.Time`) intact, so it does not
 * introduce the false positives that fully-qualifier-blind matching would.
 *
 * @param {string} sig normalized signature string
 * @param {string|null} pkgName the file's own package name
 * @returns {string}
 */
function stripSelfPackageQualifier(sig, pkgName) {
    if (!pkgName) return sig;
    // Match `<pkgName>.` only where `pkgName` is a whole identifier (not the tail
    // of a longer identifier), followed by an identifier start. This turns
    // `processengine.FlowContext` -> `FlowContext` but leaves `time.Time` alone.
    const re = new RegExp('(^|[^\\w.])' + escapeRegExp(pkgName) + '\\.(?=[A-Za-z_])', 'g');
    return sig.replace(re, '$1');
}

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract the package name from a Go file's `package X` declaration.
 * @param {string[]} code code-only lines (comments/strings stripped)
 * @returns {string|null}
 */
function extractPackageName(code) {
    for (const line of code) {
        const m = line.match(/^\s*package\s+([A-Za-z_]\w*)/);
        if (m) return m[1];
    }
    return null;
}

/**
 * Extract the balanced content starting at the paren located at or after
 * `from`. Returns the inner text (without the outer parens) and the index just
 * past the closing paren.
 * @param {string} s
 * @param {number} from
 * @returns {{inner:string,end:number}|null}
 */
function extractBalanced(s, from) {
    const open = s.indexOf('(', from);
    if (open === -1) return null;
    let depth = 0;
    for (let i = open; i < s.length; i++) {
        const c = s[i];
        if (c === '(') depth += 1;
        else if (c === ')') {
            depth -= 1;
            if (depth === 0) {
                return { inner: s.slice(open + 1, i), end: i + 1 };
            }
        }
    }
    return null;
}

/**
 * Normalize a comma-separated parameter/result list to a canonical type-only
 * form. Parameter names are dropped where detectable. This is a heuristic but
 * good enough to distinguish signatures in practice.
 *
 * @param {string} list
 * @param {boolean} dropNames
 * @returns {string}
 */
function normalizeTypeList(list, dropNames) {
    const trimmed = list.trim();
    if (!trimmed) return '';
    const parts = splitTopLevel(trimmed, ',').map((p) => p.trim());

    if (!dropNames) {
        return parts.map((p) => p.replace(/\s+/g, '')).join(',');
    }

    // A parameter group in Go may share a single type across several names,
    // e.g. `(a, b int)` means two `int` parameters. Comma-splitting alone loses
    // that, so we resolve each segment's type and propagate a trailing type
    // leftward onto preceding bare-name segments.
    const resolved = parts.map(analyzeParam);

    // Determine whether the list uses names at all. If ANY segment is an
    // explicit `name type`, bare-identifier segments are names sharing the type
    // to their right; otherwise every segment is an unnamed type.
    const usesNames = resolved.some((r) => r.kind === 'named');

    const types = new Array(resolved.length);
    let inheritedType = null;
    for (let i = resolved.length - 1; i >= 0; i--) {
        const r = resolved[i];
        if (r.kind === 'named') {
            types[i] = r.type;
            inheritedType = r.type;
        } else if (usesNames && inheritedType !== null) {
            // Bare identifier acting as a name that shares the type to its right.
            types[i] = inheritedType;
        } else {
            // Unnamed type (either the list has no names, or nothing to inherit).
            types[i] = r.text;
        }
    }
    return types.join(',');
}

/**
 * Classify a single parameter segment. Returns:
 *  - { kind: 'named', type }  when it is an explicit `name type`
 *  - { kind: 'bare',  text }  when it is a single identifier / a plain type
 * @param {string} param
 */
function analyzeParam(param) {
    const p = param.replace(/\s+/g, ' ').trim();
    const compact = p.replace(/\s+/g, '');

    // A bare single identifier with no whitespace — ambiguous between a name
    // and a simple type; caller decides based on the whole list.
    if (/^[A-Z_a-z]\w*$/.test(p)) {
        return { kind: 'bare', text: compact };
    }

    // `name type` form: leading identifier + space + a type, where the leading
    // token is not a type keyword (chan/map/func/...).
    const m = p.match(/^([A-Z_a-z]\w*)\s+(.*)$/);
    if (m && !TYPE_KEYWORDS.has(m[1])) {
        return { kind: 'named', type: m[2].replace(/\s+/g, '') };
    }

    return { kind: 'bare', text: compact };
}

/**
 * Split a string on a top-level delimiter, respecting (), [], {} nesting so
 * that `map[string]int, func(a, b int) error` splits into two parts.
 * @param {string} s
 * @param {string} delim single char
 * @returns {string[]}
 */
function splitTopLevel(s, delim) {
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') depth -= 1;
        else if (c === delim && depth === 0) {
            out.push(s.slice(start, i));
            start = i + 1;
        }
    }
    out.push(s.slice(start));
    return out;
}

/**
 * Parse a whole Go file into a structured summary. Comments/strings are
 * stripped first so braces and identifiers are reliable.
 *
 * @param {string} text
 * @returns {{
 *   interfaces: Map<string,{line:number, methods:Map<string,string>, embeds:string[]}>,
 *   types: Map<string,{line:number, methods:Map<string,string>, embeds:string[]}>
 * }}
 *   interfaces: name -> { declaration line (0-based), direct method name->normSig, embedded names }
 *   types:      receiver type -> { first decl line, implemented method name->normSig, embedded struct fields }
 */
/**
 * Fresh per-type index entry. `methodLines` maps each directly-declared method
 * to its 0-based declaration line, so navigation does not need to re-read files.
 * @param {number} line
 */
function newTypeEntry(line) {
    return { line, methods: new Map(), embeds: [], methodLines: new Map() };
}

function parseFile(text) {
    const rawLines = text.split('\n');
    const code = codeLines(text);
    const pkgName = extractPackageName(code);

    const interfaces = new Map();
    const types = new Map();

    let i = 0;
    while (i < code.length) {
        const line = code[i];

        // Interface declaration (standard or inside a `type (...)` block).
        const ifaceStd = line.match(INTERFACE_STD_RE);
        const ifaceBlock = line.match(INTERFACE_BLOCK_RE);
        const ifaceMatch = ifaceStd || ifaceBlock;
        if (ifaceMatch) {
            const name = ifaceMatch[1];
            const parsed = parseBracedBlock(code, rawLines, i, pkgName);
            interfaces.set(name, {
                line: i,
                methods: parsed.methods,
                embeds: parsed.embeds,
            });
            i = parsed.endLine + 1;
            continue;
        }

        // Type alias: `type T = Base` (or `type T = pkg.Base`). An alias denotes
        // the SAME type, so it shares the full method set of its target. We model
        // this by recording the target as an embed of the alias, letting the
        // existing embed-expansion in resolveTypeMethods promote the methods. A
        // qualified target (`pkg.Base`) lives in another package and, like other
        // imported embeds, cannot be resolved from text — it is recorded anyway
        // and simply contributes no local methods.
        const aliasMatch = line.match(
            /^\s*type\s+([A-Z_a-z]\w*)\s*=\s*\*?\s*([A-Z_a-z][\w.]*)(?:\s*\[[^\]]*\])?\s*$/
        );
        if (aliasMatch) {
            const name = aliasMatch[1];
            const target = aliasMatch[2];
            const entry = types.get(name) || newTypeEntry(i);
            if (!types.has(name)) entry.line = i;
            if (!entry.embeds.includes(target)) entry.embeds.push(target);
            types.set(name, entry);
            i += 1;
            continue;
        }

        // Struct declaration to capture embedded fields (for method promotion).
        const structStd = line.match(/^\s*type\s+([A-Z_a-z]\w*)(?:\s*\[[^\]]*\])?\s+struct\s*\{/);
        const structBlock = line.match(/^\s*([A-Z_a-z]\w*)(?:\s*\[[^\]]*\])?\s+struct\s*\{/);
        const structMatch = structStd || structBlock;
        if (structMatch) {
            const name = structMatch[1];
            const parsed = parseBracedBlock(code, rawLines, i, pkgName);
            const entry = types.get(name) || newTypeEntry(i);
            if (!types.has(name)) entry.line = i;
            entry.embeds = parsed.embeds;
            types.set(name, entry);
            i = parsed.endLine + 1;
            continue;
        }

        // Receiver method definition.
        const recv = line.match(RECEIVER_METHOD_RE);
        if (recv) {
            const recvType = recv[1];
            const methodName = recv[2];
            const sig = signatureFromLine(code, i, methodName, pkgName);
            const entry = types.get(recvType) || newTypeEntry(i);
            entry.methods.set(methodName, sig);
            // Record the 0-based declaration line so callers can navigate to the
            // exact method without a second synchronous file scan.
            entry.methodLines.set(methodName, i);
            types.set(recvType, entry);
        }

        i += 1;
    }

    return { interfaces, types };
}

/**
 * Parse the body of a braced block that starts on `startLine`. Returns the
 * interface/struct method map, embedded names, and the closing-brace line.
 * @param {string[]} code code-only lines
 * @param {string[]} rawLines original lines (for signature text)
 * @param {number} startLine
 * @param {string|null} [pkgName] the file's own package name (for self-qualifier stripping)
 */
function parseBracedBlock(code, rawLines, startLine, pkgName) {
    const methods = new Map();
    const embeds = [];

    const processSegment = (seg, srcLines, srcIndex) => {
        const method = seg.match(IFACE_METHOD_RE);
        if (method) {
            methods.set(method[1], signatureFromLine(srcLines, srcIndex, method[1], pkgName));
            return;
        }
        const embed = seg.match(EMBED_RE);
        if (embed) embeds.push(embed[1]);
    };

    // The start line always contributes its content after the first `{`.
    const openIdx = code[startLine].indexOf('{');
    const startInline = openIdx === -1 ? '' : code[startLine].slice(openIdx + 1);
    // Members can be separated by `;` or `}` on a single physical line.
    for (const seg of startInline.split(/[;}]/)) {
        if (seg.trim()) processSegment(seg, [startInline], 0);
    }

    let depth = braceDelta(code[startLine]);
    let line = startLine + 1;

    // Continue with subsequent lines only if the block spans multiple lines.
    while (line < code.length && depth > 0) {
        const before = depth;
        depth += braceDelta(code[line]);
        if (before === 1) {
            for (const seg of code[line].split(/[;}]/)) {
                if (seg.trim()) processSegment(seg, code, line);
            }
        }
        line += 1;
    }

    return { methods, embeds, endLine: Math.max(startLine, line - 1) };
}

/**
 * Build a normalized signature for the method whose name starts on `line`.
 * Handles multi-line signatures by joining following lines until the parameter
 * (and optional result) parens balance.
 * @param {string[]} code
 * @param {number} line
 * @param {string} methodName
 * @param {string|null} [pkgName] the file's own package name (for self-qualifier stripping)
 * @returns {string}
 */
function signatureFromLine(code, line, methodName, pkgName) {
    let joined = code[line];
    // For receiver methods the name appears after the receiver; slice from the
    // method name occurrence to focus on the signature.
    const idx = joined.indexOf(methodName + '(');
    let start = idx === -1 ? joined.indexOf(methodName) : idx;
    if (start === -1) start = 0;
    let sigText = joined.slice(start + methodName.length);

    // Ensure the parameter parens are balanced; if not, pull in more lines.
    let attempts = 0;
    while (!parenBalanced(sigText) && line + 1 + attempts < code.length && attempts < 20) {
        attempts += 1;
        sigText += ' ' + code[line + attempts];
    }
    // Cut off at a method body `{` or an interface-closing `}` that is not
    // nested inside brackets/parens (so `struct{}` / `map[...]` survive).
    sigText = cutAtTopLevelBrace(sigText);

    // Drop a redundant self-package qualifier (`pkg.Type` -> `Type`) so that an
    // interface using the bare name and an implementation using the fully
    // qualified name of a type from THEIR OWN package compare equal under strict
    // matching. Cross-package qualifiers are preserved.
    return stripSelfPackageQualifier(normalizeSignature(sigText.trim()), pkgName);
}

/**
 * Truncate the signature at the first top-level `{` or `}` (nesting-aware),
 * which marks either the start of a method body or the end of the enclosing
 * interface block. Braces inside (), [] are preserved.
 * @param {string} s
 * @returns {string}
 */
function cutAtTopLevelBrace(s) {
    let paren = 0;
    let bracket = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '(') paren += 1;
        else if (c === ')') paren -= 1;
        else if (c === '[') bracket += 1;
        else if (c === ']') bracket -= 1;
        else if ((c === '{' || c === '}') && paren <= 0 && bracket <= 0) {
            return s.slice(0, i);
        }
    }
    return s;
}

function parenBalanced(s) {
    let depth = 0;
    let seenOpen = false;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '(') {
            depth += 1;
            seenOpen = true;
        } else if (s[i] === ')') {
            depth -= 1;
        }
    }
    return seenOpen && depth <= 0;
}

/**
 * Resolve the full method set of an interface, expanding embedded interfaces
 * recursively. Embedded names that cannot be resolved locally (e.g. imported
 * `io.Reader`) are recorded so callers can decide how strict to be.
 *
 * @param {string} interfaceName
 * @param {Map<string,any>} interfaces map from parseFile (possibly merged across files)
 * @param {Set<string>} [_seen] recursion guard
 * @param {Map<string,{methods:Map<string,string>,unresolved:string[]}>} [_cache] shared resolution cache
 * @returns {{methods:Map<string,string>, unresolved:string[]}}
 */
function resolveInterfaceMethods(interfaceName, interfaces, _seen, _cache) {
    const seen = _seen || new Set();
    const cache = _cache || new Map();
    const methods = new Map();
    const unresolved = [];

    if (seen.has(interfaceName)) return { methods, unresolved };
    if (cache.has(interfaceName)) return cache.get(interfaceName);
    seen.add(interfaceName);

    const iface = interfaces.get(interfaceName);
    if (!iface) {
        unresolved.push(interfaceName);
        const resolved = { methods, unresolved };
        cache.set(interfaceName, resolved);
        return resolved;
    }

    for (const [name, sig] of iface.methods) {
        methods.set(name, sig);
    }

    for (const embed of iface.embeds) {
        // Well-known built-in / stdlib interfaces (error, any, io.Reader,
        // sync.Locker, context.Context, ...) have fixed method sets; expand them
        // rather than marking them unresolved, so implementations are matched.
        // Keyed by the exact spelling used in source (bare `error` or qualified
        // `io.Reader`).
        if (BUILTIN_INTERFACES.has(embed)) {
            for (const [name, sig] of BUILTIN_INTERFACES.get(embed)) {
                if (!methods.has(name)) methods.set(name, sig);
            }
            continue;
        }
        // A qualified embed (`pkg.Reader`) that is not a known built-in lives in
        // another package and cannot be resolved from text; treat as unresolved.
        if (embed.includes('.')) {
            unresolved.push(embed);
            continue;
        }
        const sub = resolveInterfaceMethods(embed, interfaces, new Set(seen), cache);
        for (const [name, sig] of sub.methods) {
            if (!methods.has(name)) methods.set(name, sig);
        }
        unresolved.push(...sub.unresolved);
    }

    const resolved = { methods, unresolved };
    cache.set(interfaceName, resolved);
    return resolved;
}

/**
 * Resolve the full method set of a concrete type, expanding embedded struct
 * fields recursively (method promotion). Only locally known embedded types are
 * expanded.
 *
 * @param {string} typeName
 * @param {Map<string,any>} types map from parseFile (merged across files)
 * @returns {Map<string,string>} method name -> normalized signature
 */
function resolveTypeMethods(typeName, types, _seen) {
    const seen = _seen || new Set();
    const methods = new Map();
    if (seen.has(typeName)) return methods;
    seen.add(typeName);

    const t = types.get(typeName);
    if (!t) return methods;

    for (const [name, sig] of t.methods) {
        methods.set(name, sig);
    }
    for (const embed of t.embeds) {
        if (embed.includes('.')) continue; // imported embedded type, skip
        const sub = resolveTypeMethods(embed, types, seen);
        for (const [name, sig] of sub) {
            if (!methods.has(name)) methods.set(name, sig);
        }
    }
    return methods;
}

/**
 * Decide whether `typeMethods` satisfies `interfaceMethods` (implicit
 * interface implementation). A method matches when the name is present and the
 * normalized signature matches.
 *
 * When the interface embeds an imported interface (e.g. `io.Reader`), its
 * methods cannot be resolved locally. Such interfaces are impossible to verify
 * from text alone, so by default `satisfies` returns `false` for them to avoid
 * reporting a type as an implementation when it may be missing the imported
 * methods (the previous behaviour produced false positives). Pass
 * `allowUnresolved: true` to fall back to matching only the locally known
 * methods when the caller has already constrained the match some other way.
 *
 * @param {Map<string,string>} interfaceMethods name -> normSig
 * @param {Map<string,string>} typeMethods name -> normSig
 * @param {{unresolved?:string[], allowUnresolved?:boolean}} [opts]
 * @returns {boolean}
 */
function satisfies(interfaceMethods, typeMethods, opts) {
    if (interfaceMethods.size === 0) return false;

    const unresolved = (opts && opts.unresolved) || [];
    const allowUnresolved = !!(opts && opts.allowUnresolved);
    const loose = !!(opts && opts.loose);
    if (unresolved.length > 0 && !allowUnresolved) {
        // Cannot verify the imported embedded methods; do not claim satisfaction.
        return false;
    }

    for (const [name, sig] of interfaceMethods) {
        const impl = typeMethods.get(name);
        if (impl === undefined) return false;
        if (impl === sig) continue;
        // Loose mode tolerates cross-package package-qualifier differences
        // (e.g. `Result` vs `dep.Result`) while still requiring the same
        // argument/result shape AND — unlike a blind qualifier strip — rejecting
        // two DIFFERENT packages' same-named types (e.g. `foo.T` vs `bar.T`).
        if (loose && looseSignatureEqual(impl, sig)) continue;
        return false;
    }
    return true;
}

/**
 * Split a normalized signature `(p1,p2)(r1,r2)` into its parameter and result
 * type-slot lists. Splitting is nesting-aware so composite types such as
 * `map[k]v` / `func(a)b` stay in a single slot.
 * @param {string} sig normalized signature
 * @returns {{params:string[], results:string[]}|null}
 */
function splitNormalizedSignature(sig) {
    // Params are the first top-level (...) group; results the second.
    const first = extractBalanced(sig, 0);
    if (!first) return null;
    const rest = sig.slice(first.end);
    const second = extractBalanced(rest, 0);
    const params = splitTopLevel(first.inner, ',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    const results = second
        ? splitTopLevel(second.inner, ',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
        : [];
    return { params, results };
}

/**
 * Compare two type slots under cross-package loose rules:
 *  - identical text matches;
 *  - the same shape after stripping ALL package qualifiers is required
 *    (guarantees pointer/slice/map structure and base type names line up);
 *  - where BOTH sides carry a package qualifier in corresponding positions, the
 *    package names must be equal, so `foo.T` and `bar.T` do NOT match, while a
 *    bare `T` still matches a qualified `pkg.T` (the genuine cross-package case
 *    where an interface names its own package type unqualified and the importer
 *    qualifies it).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function looseTypeSlotEqual(a, b) {
    if (a === b) return true;
    if (stripPackageQualifiers(a) !== stripPackageQualifiers(b)) return false;
    const qa = [...a.matchAll(/([A-Za-z_]\w*)\.[A-Za-z_]\w*/g)].map((m) => m[1]);
    const qb = [...b.matchAll(/([A-Za-z_]\w*)\.[A-Za-z_]\w*/g)].map((m) => m[1]);
    // Only when both sides qualify the same number of types do we require the
    // package names to line up; a differing count means one side left a type
    // unqualified (the cross-package scenario) and is allowed.
    if (qa.length === qb.length) {
        for (let i = 0; i < qa.length; i++) {
            if (qa[i] !== qb[i]) return false;
        }
    }
    return true;
}

/**
 * Loose signature equality for cross-package matching. Requires identical
 * arity and per-slot compatibility (see `looseTypeSlotEqual`). This replaces the
 * previous blunt "strip every package qualifier and compare" approach, which
 * treated any two same-named types from different packages as equal and so
 * produced cross-package false positives.
 *
 * @param {string} a normalized signature
 * @param {string} b normalized signature
 * @returns {boolean}
 */
function looseSignatureEqual(a, b) {
    if (a === b) return true;
    const sa = splitNormalizedSignature(a);
    const sb = splitNormalizedSignature(b);
    if (!sa || !sb) {
        // Fall back to the historical behaviour if either signature is not in
        // the expected `(...)(...)`​ shape.
        return stripPackageQualifiers(a) === stripPackageQualifiers(b);
    }
    if (sa.params.length !== sb.params.length) return false;
    if (sa.results.length !== sb.results.length) return false;
    for (let i = 0; i < sa.params.length; i++) {
        if (!looseTypeSlotEqual(sa.params[i], sb.params[i])) return false;
    }
    for (let i = 0; i < sa.results.length; i++) {
        if (!looseTypeSlotEqual(sa.results[i], sb.results[i])) return false;
    }
    return true;
}

module.exports = {
    parseFile,
    resolveInterfaceMethods,
    resolveTypeMethods,
    satisfies,
    normalizeSignature,
    stripPackageQualifiers,
    stripSelfPackageQualifier,
    looseSignatureEqual,
    extractPackageName,
    splitTopLevel,
    RECEIVER_METHOD_RE,
    INTERFACE_STD_RE,
    INTERFACE_BLOCK_RE,
    IFACE_METHOD_RE,
};
