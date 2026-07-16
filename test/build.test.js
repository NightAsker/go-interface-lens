'use strict';

const path = require('path');
const { shouldIncludeGoFile } = require(path.join(__dirname, '..', 'src', 'build'));
const { assert, done } = require(path.join(__dirname, 'harness'));

const linux = { goos: 'linux', goarch: 'amd64', tags: new Set(['linux', 'amd64', 'unix', 'gc']) };

console.log('== build context filtering ==');
assert('linux filename is included', shouldIncludeGoFile('/p/service_linux.go', 'package p', linux));
assert('windows filename is excluded', !shouldIncludeGoFile('/p/service_windows.go', 'package p', linux));
assert('windows test filename is excluded', !shouldIncludeGoFile('/p/service_windows_test.go', 'package p', linux));
assert(
    'matching go:build expression is included',
    shouldIncludeGoFile('/p/service.go', '//go:build linux && amd64\npackage p', linux)
);
assert(
    'non-matching go:build expression is excluded',
    !shouldIncludeGoFile('/p/service.go', '//go:build windows || arm64\npackage p', linux)
);
assert(
    'unknown positive tags do not hide a possible file',
    shouldIncludeGoFile('/p/service.go', '//go:build linux && cgo\npackage p', linux)
);
assert(
    'known false tag still dominates an unknown tag',
    !shouldIncludeGoFile('/p/service.go', '//go:build windows && custom\npackage p', linux)
);

done();
