'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const {
    parseGoMod,
    escapeModulePath,
    resolveLockedModuleDirs,
    resolveModuleImportDirectory,
    isLocalPath,
} = require(path.join(__dirname, '..', 'src', 'gomod'));
const { eq, assert, done } = require(path.join(__dirname, 'harness'));

console.log('== escapeModulePath (cache escaping) ==');
eq('lowercase unchanged', escapeModulePath('github.com/acme/x'), 'github.com/acme/x');
eq('uppercase escaped with !', escapeModulePath('github.com/Sirupsen/logrus'), 'github.com/!sirupsen/logrus');
eq('version passthrough', escapeModulePath('v1.3.0'), 'v1.3.0');
eq('mixed case version', escapeModulePath('v1.3.0-RC1'), 'v1.3.0-!r!c1');

console.log('\n== parseGoMod ==');
{
    const mod = [
        'module example.com/proj',
        '',
        'go 1.21',
        '',
        'require github.com/acme/x v1.3.0',
        '',
        'require (',
        '\tgithub.com/foo/bar v2.0.1 // indirect',
        '\tgithub.com/Baz/Qux v0.5.0',
        ')',
    ].join('\n');
    const { versions } = parseGoMod(mod);
    eq('single require version', versions.get('github.com/acme/x'), 'v1.3.0');
    eq('block require version', versions.get('github.com/foo/bar'), 'v2.0.1');
    eq('mixed-case module recorded raw', versions.get('github.com/Baz/Qux'), 'v0.5.0');
    eq('module count', versions.size, 3);
}

console.log('\n== parseGoMod with replace ==');
{
    const mod = [
        'module example.com/proj',
        'require github.com/acme/x v1.3.0',
        'require github.com/old/lib v1.0.0',
        'replace github.com/old/lib => github.com/new/lib v2.2.2',
        'replace github.com/acme/x => ../local/x',
    ].join('\n');
    const { versions, localReplaces, moduleReplaces } = parseGoMod(mod);
    eq('replaced-by-module version applied to target', versions.get('github.com/new/lib'), 'v2.2.2');
    eq('local replace recorded', localReplaces.get('github.com/acme/x'), '../local/x');
    assert('locally-replaced module removed from cache versions', !versions.has('github.com/acme/x'));
    eq('module replacement target retained', moduleReplaces.get('github.com/old/lib'), {
        modulePath: 'github.com/new/lib',
        version: 'v2.2.2',
    });
}

console.log('\n== isLocalPath ==');
assert('./ is local', isLocalPath('./x'));
assert('../ is local', isLocalPath('../x'));
assert('/abs is local', isLocalPath('/abs/x'));
assert('module path is NOT local', !isLocalPath('github.com/acme/x'));

console.log('\n== resolveLockedModuleDirs (only locked versions) ==');
{
    // Build a temp project + fake module cache with TWO versions of a module.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gomod-test-'));
    const proj = path.join(tmp, 'proj');
    const cache = path.join(tmp, 'modcache');
    fs.mkdirSync(proj, { recursive: true });

    const modDirV12 = path.join(cache, 'github.com', 'acme', 'iface@v1.2.0');
    const modDirV13 = path.join(cache, 'github.com', 'acme', 'iface@v1.3.0');
    fs.mkdirSync(modDirV12, { recursive: true });
    fs.mkdirSync(modDirV13, { recursive: true });

    fs.writeFileSync(
        path.join(proj, 'go.mod'),
        ['module example.com/proj', 'go 1.21', 'require github.com/acme/iface v1.3.0'].join('\n')
    );

    const { dirs, goModPath } = resolveLockedModuleDirs(proj, cache);
    console.log('  got dirs:', dirs.map((d) => path.basename(d)));
    assert('found go.mod', goModPath !== null);
    assert('includes locked v1.3.0 dir', dirs.includes(modDirV13));
    assert('EXCLUDES stale v1.2.0 dir', !dirs.includes(modDirV12));
    eq('exactly one locked dir', dirs.length, 1);

    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n== resolveModuleImportDirectory ==');
{
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gomod-import-test-'));
    const proj = path.join(tmp, 'proj');
    const cache = path.join(tmp, 'modcache');
    const local = path.join(tmp, 'local');
    const normalPackage = path.join(cache, 'example.com', 'dep@v1.2.0', 'runner');
    const replacedPackage = path.join(cache, 'example.com', 'new@v2.0.0', 'api');
    const localPackage = path.join(local, 'adapter');
    for (const directory of [proj, normalPackage, replacedPackage, localPackage]) {
        fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(
        path.join(proj, 'go.mod'),
        [
            'module example.com/project',
            'require example.com/dep v1.2.0',
            'require example.com/old v1.0.0',
            'replace example.com/old => example.com/new v2.0.0',
            'replace example.com/local => ../local',
        ].join('\n')
    );
    eq(
        'locked module package resolved',
        resolveModuleImportDirectory(proj, 'example.com/dep/runner', cache),
        normalPackage
    );
    eq(
        'module replacement package resolved',
        resolveModuleImportDirectory(proj, 'example.com/old/api', cache),
        replacedPackage
    );
    eq(
        'local replacement package resolved',
        resolveModuleImportDirectory(proj, 'example.com/local/adapter', cache),
        localPackage
    );
    fs.rmSync(tmp, { recursive: true, force: true });
}

done();
