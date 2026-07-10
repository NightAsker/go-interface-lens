'use strict';

const path = require('path');
const {
    parseFile,
    resolveInterfaceMethods,
    resolveTypeMethods,
    satisfies,
    normalizeSignature,
    looseSignatureEqual,
} = require(path.join(__dirname, '..', 'src', 'parser'));
const { codeLines, braceDelta } = require(path.join(__dirname, '..', 'src', 'tokenizer'));
const { eq, assert, done } = require(path.join(__dirname, 'harness'));

console.log('== tokenizer: braces inside comments/strings are ignored ==');
{
    const src = [
        'type S struct {',
        '  // fake } brace in comment',
        '  Name string // }',
        '  Data string // `raw` "str"',
        '}',
    ].join('\n');
    let depth = 0;
    for (const l of codeLines(src)) depth += braceDelta(l);
    eq('balanced despite comment braces', depth, 0);
}

console.log('\n== signature normalization ==');
eq(
    'param names dropped, whitespace collapsed',
    normalizeSignature('(p []byte) (n int, err error)'),
    normalizeSignature('([]byte)(int,error)')
);
assert('different arg count differs', normalizeSignature('(a int)') !== normalizeSignature('(a int, b int)'));
assert('no-arg vs arg differ', normalizeSignature('() string') !== normalizeSignature('(x int) string'));

console.log('\n== grouped parameters share a type (regression) ==');
eq(
    'grouped (a, b int) == explicit (a int, b int)',
    normalizeSignature('(a, b int) error'),
    normalizeSignature('(a int, b int) error')
);
eq(
    'grouped (a, b int) == unnamed (int, int)',
    normalizeSignature('(a, b int) error'),
    normalizeSignature('(int, int) error')
);
eq(
    'three-name group (a, b int, c string)',
    normalizeSignature('(a, b int, c string)'),
    normalizeSignature('(int, int, string)')
);
assert(
    'grouped arity still distinguishes',
    normalizeSignature('(a int)') !== normalizeSignature('(a, b int)')
);
eq(
    'single named param == unnamed type',
    normalizeSignature('(p []byte)'),
    normalizeSignature('([]byte)')
);

console.log('\n== false positive: same name, wrong signature ==');
{
    const src = [
        'package p',
        'type Reader interface {',
        '  Read(p []byte) (int, error)',
        '}',
        'type Good struct{}',
        'func (g *Good) Read(p []byte) (int, error) { return 0, nil }',
        'type Bad struct{}',
        'func (b *Bad) Read() string { return "" }',
    ].join('\n');
    const { interfaces, types } = parseFile(src);
    const iface = resolveInterfaceMethods('Reader', interfaces);
    assert('Good satisfies Reader', satisfies(iface.methods, resolveTypeMethods('Good', types)));
    assert('Bad (wrong sig) does not satisfy', !satisfies(iface.methods, resolveTypeMethods('Bad', types)));
}

console.log('\n== embedded interface expansion ==');
{
    const src = [
        'type Reader interface { Read(p []byte) (int, error) }',
        'type Writer interface { Write(p []byte) (int, error) }',
        'type ReadWriter interface {',
        '  Reader',
        '  Writer',
        '}',
        'type File struct{}',
        'func (f *File) Read(p []byte) (int, error) { return 0, nil }',
        'func (f *File) Write(p []byte) (int, error) { return 0, nil }',
        'type OnlyReader struct{}',
        'func (o *OnlyReader) Read(p []byte) (int, error) { return 0, nil }',
    ].join('\n');
    const { interfaces, types } = parseFile(src);
    const rw = resolveInterfaceMethods('ReadWriter', interfaces);
    eq('ReadWriter expands to 2 methods', rw.methods.size, 2);
    assert('File satisfies ReadWriter', satisfies(rw.methods, resolveTypeMethods('File', types)));
    assert('OnlyReader does not satisfy', !satisfies(rw.methods, resolveTypeMethods('OnlyReader', types)));
}

console.log('\n== embedded struct method promotion ==');
{
    const src = [
        'type Closer interface { Close() error }',
        'type Base struct{}',
        'func (b *Base) Close() error { return nil }',
        'type Derived struct {',
        '  Base',
        '}',
    ].join('\n');
    const { interfaces, types } = parseFile(src);
    const closer = resolveInterfaceMethods('Closer', interfaces);
    assert('Derived satisfies Closer via embedding', satisfies(closer.methods, resolveTypeMethods('Derived', types)));
}

console.log('\n== embedded builtin `error` interface is expanded ==');
{
    const src = [
        'type Exception interface {',
        '\terror',
        '\tCode() int',
        '}',
        'type baseException struct{ code int }',
        'func (e *baseException) Code() int { return e.code }',
        'func (e *baseException) Error() string { return "" }',
        'type onlyErr struct{}',
        'func (o *onlyErr) Error() string { return "" }',
    ].join('\n');
    const { interfaces, types } = parseFile(src);
    const exc = resolveInterfaceMethods('Exception', interfaces);
    eq('Exception expands error -> {Code, Error}', exc.methods.size, 2);
    eq('no unresolved embeds for builtin error', exc.unresolved.length, 0);
    assert('baseException satisfies Exception (strict)', satisfies(exc.methods, resolveTypeMethods('baseException', types)));
    assert(
        'onlyErr (missing Code) does NOT satisfy Exception',
        !satisfies(exc.methods, resolveTypeMethods('onlyErr', types))
    );
}

console.log('\n== type-block interface ==');
{
    const src = [
        'type (',
        '  Service interface {',
        '    Do(x int) error',
        '  }',
        ')',
        'type Impl struct{}',
        'func (i *Impl) Do(x int) error { return nil }',
    ].join('\n');
    const { interfaces, types } = parseFile(src);
    const svc = resolveInterfaceMethods('Service', interfaces);
    eq('Service has 1 method', svc.methods.size, 1);
    assert('Impl satisfies Service', satisfies(svc.methods, resolveTypeMethods('Impl', types)));
}

console.log('\n== unknown imported embedded interface is not falsely satisfied (regression) ==');
{
    // An embed from an unknown third-party package cannot be resolved from text
    // alone, so a type implementing only the local method must NOT be reported.
    const src = [
        'package p',
        'type Custom interface {',
        '  other.Thing',
        '  Extra() string',
        '}',
        'type Partial struct{}',
        'func (t *Partial) Extra() string { return "" }',
    ].join('\n');
    const { interfaces, types } = parseFile(src);
    const iface = resolveInterfaceMethods('Custom', interfaces);
    const tm = resolveTypeMethods('Partial', types);
    assert('other.Thing recorded as unresolved', iface.unresolved.includes('other.Thing'));
    assert(
        'strict satisfies() rejects when embed unresolved',
        satisfies(iface.methods, tm, { unresolved: iface.unresolved }) === false
    );
    assert(
        'lenient satisfies() allows local-method match',
        satisfies(iface.methods, tm, { unresolved: iface.unresolved, allowUnresolved: true }) === true
    );
}

console.log('\n== embedded stdlib interface (io.Reader) is expanded and matched ==');
{
    const src = [
        'package p',
        'type Custom interface {',
        '  io.Reader',
        '  Extra() string',
        '}',
        'type Full struct{}',
        'func (f *Full) Read(p []byte) (int, error) { return 0, nil }',
        'func (f *Full) Extra() string { return "" }',
        'type Partial struct{}',
        'func (t *Partial) Extra() string { return "" }',
    ].join('\n');
    const { interfaces, types } = parseFile(src);
    const iface = resolveInterfaceMethods('Custom', interfaces);
    eq('io.Reader expands: Custom -> {Read, Extra}', iface.methods.size, 2);
    eq('no unresolved embeds for io.Reader', iface.unresolved.length, 0);
    assert('Full (Read+Extra) satisfies Custom', satisfies(iface.methods, resolveTypeMethods('Full', types)));
    assert(
        'Partial (missing Read) does NOT satisfy Custom',
        !satisfies(iface.methods, resolveTypeMethods('Partial', types))
    );
}

console.log('\n== redundant self-package qualifier matches under strict (regression) ==');
{
    // Interface and implementation live in the SAME package. The implementation
    // (legally, if redundantly) qualifies a same-package type with its own
    // package name (`processengine.FlowContext`), while the interface uses the
    // bare name (`FlowContext`). These denote the identical type, so strict
    // matching must treat them as equal.
    const src = [
        'package processengine',
        'type Action interface {',
        '\tExecuteAction(context *FlowContext)',
        '}',
        'type UpdateCloseConversationAction struct{ Action }',
        'func (a *UpdateCloseConversationAction) ExecuteAction(flowContext *processengine.FlowContext) {}',
    ].join('\n');
    const { interfaces, types } = parseFile(src);
    const iface = resolveInterfaceMethods('Action', interfaces);
    assert(
        'self-qualified impl satisfies interface (strict)',
        satisfies(iface.methods, resolveTypeMethods('UpdateCloseConversationAction', types)) === true
    );
}

console.log('\n== genuine cross-package qualifier is NOT stripped (no false positive) ==');
{
    // Here `other.FlowContext` is a DIFFERENT package's type, so it must NOT be
    // equated with the interface's own `FlowContext`.
    const src = [
        'package foo',
        'type Action interface {',
        '\tExecuteAction(context *FlowContext)',
        '}',
        'type Bad struct{}',
        'func (b *Bad) ExecuteAction(ctx *other.FlowContext) {}',
    ].join('\n');
    const { interfaces, types } = parseFile(src);
    const iface = resolveInterfaceMethods('Action', interfaces);
    assert(
        'cross-package type does NOT satisfy under strict',
        satisfies(iface.methods, resolveTypeMethods('Bad', types)) === false
    );
}

console.log('\n== loose signature equality is package-aware (no cross-package false positive) ==');
{
    const N = normalizeSignature;
    // Genuine cross-package case: interface names its own package type
    // unqualified (`Result`), importer qualifies it (`acme.Result`).
    assert(
        'bare Result matches qualified acme.Result',
        looseSignatureEqual(
            N('(ctx context.Context, code string) (Result, error)'),
            N('(ctx context.Context, code string) (acme.Result, error)')
        ) === true
    );
    // Two DIFFERENT packages' same-named types must NOT be treated as equal.
    assert(
        'foo.T does NOT match bar.T (different packages)',
        looseSignatureEqual(N('(a foo.T)'), N('(a bar.T)')) === false
    );
    // Same qualifier still matches.
    assert('acme.Result matches acme.Result', looseSignatureEqual(N('(a acme.Result)'), N('(a acme.Result)')) === true);
    // Shape differences are still rejected loosely.
    assert('differing arity rejected', looseSignatureEqual(N('(a int)'), N('(a int, b int)')) === false);
    assert(
        'differing result order rejected',
        looseSignatureEqual(N('() (int, error)'), N('() (error, int)')) === false
    );
    assert(
        'empty method does not match a real signature',
        looseSignatureEqual(N('()'), N('(ctx context.Context, code string) (Result, error)')) === false
    );
}

console.log('\n== pointer-embedded struct field promotes methods ==');
{
    const src = [
        'package p',
        'type Closer interface { Close() error }',
        'type Base struct{}',
        'func (b *Base) Close() error { return nil }',
        'type Derived struct { *Base }',
    ].join('\n');
    const { interfaces, types } = parseFile(src);
    const closer = resolveInterfaceMethods('Closer', interfaces);
    assert(
        'Derived satisfies Closer via *Base pointer embed',
        satisfies(closer.methods, resolveTypeMethods('Derived', types))
    );
}

console.log('\n== type alias shares the target method set ==');
{
    const src = [
        'package p',
        'type Closer interface { Close() error }',
        'type Base struct{}',
        'func (b *Base) Close() error { return nil }',
        'type Alias = Base',
    ].join('\n');
    const { interfaces, types } = parseFile(src);
    const closer = resolveInterfaceMethods('Closer', interfaces);
    assert(
        'alias `type Alias = Base` satisfies Closer',
        satisfies(closer.methods, resolveTypeMethods('Alias', types))
    );
}

console.log('\n== generic receiver ==');
{
    const src = ['type Stack[T any] struct{}', 'func (s *Stack[T]) Push(v int) {}'].join('\n');
    const { types } = parseFile(src);
    assert('generic Stack.Push captured', resolveTypeMethods('Stack', types).has('Push'));
}

done();
