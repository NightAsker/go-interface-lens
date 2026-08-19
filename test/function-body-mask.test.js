'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseGoFile, parseGoDeclarations, serializeParsedFile } = require('../src/ast');
const { AstWorkerPool } = require('../src/ast-cache');
const { maskGoFunctionBodies } = require('../src/go-source');
const { assert, eq, done } = require('./harness');

async function main() {
    const source = [
        'package complex',
        '',
        'import "context"',
        '',
        'type Handler[T any] interface {',
        '    Handle(context.Context, T) (map[string]T, error)',
        '}',
        '',
        'type Impl[T any] struct { Value T }',
        '',
        '// Bodyless declarations used by assembly implementations must stay intact.',
        'func external(value int) int',
        '',
        'func (receiver *Impl[T]) Handle(',
        '    ctx context.Context,',
        '    value T,',
        ') (map[string]T, error) {',
        '    text := "brace } and fake func Wrong() {"',
        '    raw := `raw { } // func Fake() {}`',
        "    char := '}'",
        '    // A comment with } and func Comment() {}',
        '    /* A block comment { with nested-looking braces } */',
        '    nested := func() map[string]T {',
        '        return map[string]T{"value": value}',
        '    }',
        '    _ = []any{text, raw, char, nested, ctx}',
        '    return map[string]T{"value": value}, nil',
        '}',
        '',
        'func (Impl[T]) Snapshot() struct {',
        '    Value T `json:"value"`',
        '} {',
        '    return struct { Value T `json:"value"` }{Value: *new(T)}',
        '}',
        '',
        'var Callback = func(value string) string {',
        '    return "callback:" + value',
        '}',
        '',
        'func (Impl[T]) Unicode() string {',
        '    return "函数体中的中文不会改变后续声明位置"',
        '}',
        '',
        'func (Impl[T]) Last(value func(struct { Field int }) error) error {',
        '    if value == nil {',
        '        return nil',
        '    }',
        '    return value(struct { Field int }{Field: 1})',
        '}',
        '',
    ].join('\n');

    console.log('== declaration-only Go source masking ==');
    const masked = maskGoFunctionBodies(source);
    assert('complex source contains multiple maskable bodies', masked.bodyCount >= 5);
    assert('masking removes substantial body text', masked.maskedCharacters > 200);
    eq('masking preserves JavaScript source length', masked.text.length, source.length);
    eq(
        'masking preserves every line break',
        masked.text.match(/\n/g).length,
        source.match(/\n/g).length
    );
    assert('method signature remains visible', masked.text.includes('func (receiver *Impl[T]) Handle('));
    assert('anonymous struct result remains visible', masked.text.includes('Snapshot() struct {'));
    assert('bodyless declaration remains visible', masked.text.includes('func external(value int) int'));
    assert('method body content is removed', !masked.text.includes('fake func Wrong'));
    assert('nested function body content is removed with its parent', !masked.text.includes('map[string]T{"value"'));
    assert('top-level function literal body is removed', !masked.text.includes('callback:'));
    assert('Unicode body content is removed', !masked.text.includes('函数体中的中文'));

    const [full, declarationsOnly] = await Promise.all([
        parseGoFile(source),
        parseGoFile(masked.text),
    ]);
    assert('masked source remains syntactically valid Go', !declarationsOnly.hasSyntaxError);
    eq(
        'declaration-only parse is semantically identical to the full parse',
        serializeParsedFile(declarationsOnly),
        serializeParsedFile(full)
    );
    eq(
        'declarations after Unicode bodies keep their source line',
        declarationsOnly.types.get('Impl').methodLines.get('Last'),
        full.types.get('Impl').methodLines.get('Last')
    );

    const declarationResult = await parseGoDeclarations(source);
    eq(
        'shared declaration parser matches a full parse',
        serializeParsedFile(declarationResult.parsed),
        serializeParsedFile(full)
    );
    eq(
        'shared declaration parser reports every removed body',
        declarationResult.optimization.bodyCount,
        masked.bodyCount
    );
    assert(
        'shared declaration parser does not fall back for valid source',
        !declarationResult.optimization.fallback
    );

    const invalidBody = 'package broken\nfunc Broken() { value := }\ntype Kept struct{}\n';
    const invalidFull = await parseGoFile(invalidBody);
    const invalidDeclarations = await parseGoDeclarations(invalidBody);
    assert('full parsing observes syntax errors inside a function body', invalidFull.hasSyntaxError);
    assert('declaration parsing ignores syntax errors inside a removed body', !invalidDeclarations.parsed.hasSyntaxError);
    assert(
        'body-only syntax errors do not require a full-source fallback',
        !invalidDeclarations.optimization.fallback
    );

    console.log('\n== dependency worker declaration-only mode and fallback ==');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-interface-body-mask-'));
    const file = path.join(tmp, 'complex.go');
    fs.writeFileSync(file, source);
    const pool = new AstWorkerPool({ concurrency: 1 });
    const parsed = await pool.parseFiles(
        [{ file, diskText: source, declarationOnly: true }],
        10
    );
    assert('worker result retains the complete method set', parsed.get(file).types.get('Impl').methods.has('Last'));
    eq('worker reports one declaration-only parse', pool.stats.declarationOnlyParsed, 1);
    eq('valid masked source does not use the full-source fallback', pool.stats.declarationOnlyFallbacks, 0);
    assert('worker reports skipped function-body characters', pool.stats.functionBodyCharactersSkipped > 200);
    pool.dispose();

    const brokenFile = path.join(tmp, 'broken.go');
    const brokenSource = 'package broken\nfunc Fine() { return }\ntype Broken struct {\n';
    fs.writeFileSync(brokenFile, brokenSource);
    const fallbackPool = new AstWorkerPool({ concurrency: 1 });
    await fallbackPool.parseFiles(
        [{ file: brokenFile, diskText: brokenSource, declarationOnly: true }],
        10
    );
    eq('masked syntax errors trigger a full-source parse', fallbackPool.stats.declarationOnlyFallbacks, 1);
    fallbackPool.dispose();

    fs.rmSync(tmp, { recursive: true, force: true });
    done();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
