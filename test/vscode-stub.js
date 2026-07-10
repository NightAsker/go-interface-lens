'use strict';

// Minimal `vscode` stub so parser/indexer logic can be tested headlessly with
// plain Node, without launching the extension host.
module.exports = {
    env: { appRoot: '' }, // forces ripgrep PATH fallback / node directory walk
    ProgressLocation: { Notification: 15 },
    workspace: {
        // Tests may overwrite these to simulate different workspace setups.
        workspaceFolders: undefined,
        createFileSystemWatcher() {
            return {
                onDidCreate() {},
                onDidChange() {},
                onDidDelete() {},
                dispose() {},
            };
        },
        // Tests may reassign this to simulate a document belonging (or not) to a
        // workspace folder.
        getWorkspaceFolder() {
            return undefined;
        },
    },
    window: {
        // Test-observable counter of how many times a progress notification was
        // actually shown. Tests reset and assert on this.
        _withProgressCalls: 0,
        async withProgress(_opts, task) {
            module.exports.window._withProgressCalls += 1;
            return task({ report() {} }, { isCancellationRequested: false });
        },
        showInformationMessage() {},
        showWarningMessage() {},
        showErrorMessage() {},
        createOutputChannel() {
            return { appendLine() {}, dispose() {} };
        },
    },
    Uri: {},
};
