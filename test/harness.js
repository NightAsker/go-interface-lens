'use strict';

// Tiny assertion harness shared by the test files. No dependencies.
let pass = 0;
let fail = 0;

function eq(name, got, want) {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g === w) {
        pass++;
        console.log('  ok   ' + name);
    } else {
        fail++;
        console.log(`  FAIL ${name}\n       got : ${g}\n       want: ${w}`);
    }
}

function assert(name, cond) {
    if (cond) {
        pass++;
        console.log('  ok   ' + name);
    } else {
        fail++;
        console.log('  FAIL ' + name);
    }
}

function done() {
    console.log(`\n==== ${pass} passed, ${fail} failed ====`);
    if (fail > 0) process.exitCode = 1;
}

module.exports = { eq, assert, done };
