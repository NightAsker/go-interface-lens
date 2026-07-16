'use strict';

const vscode = require('vscode');
const path = require('path');

const { codeLines } = require('./src/tokenizer');
const {
    parseFile,
    RECEIVER_METHOD_RE,
} = require('./src/parser');
const { WorkspaceIndex } = require('./src/indexer');
const { resolveSearchRoots } = require('./src/search');

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
let output;
function log(msg) {
    if (output) output.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Configuration & filtering
// ---------------------------------------------------------------------------
function getConfiguration() {
    const config = vscode.workspace.getConfiguration('goInterfaceLens');
    return {
        excludedFolders: config.get('excludedFolders', ['mocks', 'mock', 'testdata', 'vendor']),
        excludedFilePatterns: config.get('excludedFilePatterns', ['_mock.go', 'mock_', '.pb.go', '_test.go']),
        excludedTypePatterns: config.get('excludedTypePatterns', ['Mock', 'mock', 'Stub', 'Fake']),
        searchDependencies: config.get('searchDependencies', true),
        goModCache: config.get('goModCache', ''),
    };
}

function shouldExclude(filePath, receiverType) {
    const config = getConfiguration();

    const pathParts = filePath.split(path.sep);
    for (const folder of config.excludedFolders) {
        if (pathParts.includes(folder)) return true;
    }

    const fileName = path.basename(filePath);
    for (const pattern of config.excludedFilePatterns) {
        if (fileName.includes(pattern)) return true;
    }

    if (receiverType) {
        for (const pattern of config.excludedTypePatterns) {
            if (receiverType.includes(pattern)) return true;
        }
        if (receiverType.startsWith('_')) return true;
    }

    return false;
}

// Shared index instance.
let workspaceIndex = null;
const overlayTimers = new Map();
const OVERLAY_DELAY_MS = 150;
const WORKSPACE_PREWARM_DELAY_MS = 300;

function resolvePrewarmRoots(documentUri) {
    const roots = new Set();
    for (const folder of vscode.workspace.workspaceFolders || []) {
        roots.add(folder.uri.fsPath);
    }

    const owning = documentUri && vscode.workspace.getWorkspaceFolder(documentUri);
    if (owning) roots.add(owning.uri.fsPath);

    // A standalone Go file still benefits from indexing its containing folder.
    // When a workspace IS open, deliberately do not add an external dependency
    // directory here; dependency lookup remains on-demand.
    if (roots.size === 0 && documentUri && documentUri.fsPath) {
        roots.add(path.dirname(documentUri.fsPath));
    }
    return [...roots];
}

function prewarmRoots(roots, reason) {
    if (!workspaceIndex || typeof workspaceIndex.ensureBuilt !== 'function' || roots.length === 0) return;
    if (typeof workspaceIndex.areRootsBuilt === 'function' && workspaceIndex.areRootsBuilt(roots)) return;

    Promise.all(roots.map((root) => workspaceIndex.ensureBuilt(root))).catch((err) => {
        log(`${reason} prewarm failed: ${err && err.message}`);
    });
}

function prewarmWorkspace(documentUri, reason) {
    prewarmRoots(resolvePrewarmRoots(documentUri), reason);
}

function cancelOverlayTimer(filePath) {
    const timer = overlayTimers.get(filePath);
    if (timer) clearTimeout(timer);
    overlayTimers.delete(filePath);
}

function scheduleDocumentOverlay(document) {
    if (!workspaceIndex || !document || document.languageId !== 'go' || !document.uri.fsPath) return;
    const filePath = document.uri.fsPath;
    cancelOverlayTimer(filePath);
    const timer = setTimeout(() => {
        overlayTimers.delete(filePath);
        workspaceIndex.updateOverlay(filePath, document.getText(), false);
    }, OVERLAY_DELAY_MS);
    if (typeof timer.unref === 'function') timer.unref();
    overlayTimers.set(filePath, timer);
}

function syncOpenDocument(documentUri) {
    if (!workspaceIndex || !documentUri || !documentUri.fsPath) return;
    const documents = vscode.workspace.textDocuments || [];
    const document = documents.find((doc) => doc.uri && doc.uri.fsPath === documentUri.fsPath);
    if (document && document.isDirty) {
        cancelOverlayTimer(documentUri.fsPath);
        workspaceIndex.updateOverlay(documentUri.fsPath, document.getText(), false);
    }
}

// ---------------------------------------------------------------------------
// CodeLens providers
// ---------------------------------------------------------------------------
class GoInterfaceLensProvider {
    constructor() {
        this._onDidChangeCodeLenses = new vscode.EventEmitter();
        this.onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
    }

    provideCodeLenses(document) {
        const codeLenses = [];
        const parsed = parseFile(document.getText());

        if (parsed.interfaces.size > 0) {
            // Pure interface files have no receiver methods, so the reverse-lens
            // provider cannot trigger its existing lazy build. Start the same
            // deduplicated build here without delaying CodeLens rendering.
            prewarmWorkspace(document.uri, 'interface lens');
        }

        const lineRange = (index) => new vscode.Range(index, 0, index, document.lineAt(index).text.length);

        for (const [interfaceName, info] of parsed.interfaces) {
            codeLenses.push(
                new vscode.CodeLens(lineRange(info.line), {
                    title: 'implementations',
                    command: 'go-interface-lens.showImplementations',
                    arguments: [interfaceName, document.uri],
                })
            );
            for (const [methodName, methodLine] of info.methodLines || []) {
                codeLenses.push(
                    new vscode.CodeLens(lineRange(methodLine), {
                        title: '→ implementations',
                        command: 'go-interface-lens.showMethodImplementations',
                        arguments: [interfaceName, methodName, document.uri],
                    })
                );
            }
        }

        return codeLenses;
    }

    resolveCodeLens(codeLens) {
        return codeLens;
    }
}

class GoGotoInterfaceLensProvider {
    constructor() {
        this._onDidChangeCodeLenses = new vscode.EventEmitter();
        this.onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
    }

    provideCodeLenses(document) {
        const code = codeLines(document.getText());

        // Collect candidate receiver-method declarations first.
        const candidates = [];
        code.forEach((line, index) => {
            const match = line.match(RECEIVER_METHOD_RE);
            if (!match) return;
            const receiverType = match[1];
            const methodName = match[2];
            if (shouldExclude(document.fileName, receiverType)) return;
            candidates.push({ index, receiverType, methodName });
        });

        if (candidates.length === 0) return [];

        // The lens is only shown for methods that actually implement some
        // interface. That check reads the index, so it must be cheap enough to
        // run on every file switch. Two guarantees keep it fast:
        //   1. We never block on indexing here. If the relevant roots are not yet
        //      built we kick off the build in the background and return no
        //      goto-interface lenses for now; when the build finishes the index
        //      fires onDidChange and VS Code re-invokes this provider, so the
        //      lenses appear a moment later without stalling the editor.
        //   2. When the roots ARE built we use a synchronous, memoized,
        //      workspace-only check (hasLocalInterface) that never greps the
        //      module cache. The expensive dependency search stays in the
        //      explicit "goto interface" click handler.
        const roots = resolveSearchRoots(document.uri);
        if (!workspaceIndex.areRootsBuilt(roots)) {
            // Build in the background; do not await. onDidChange will refresh.
            Promise.all(roots.map((root) => workspaceIndex.ensureBuilt(root))).catch((err) => {
                log(`goto-interface lens: background index build failed: ${err && err.message}`);
            });
            return [];
        }

        const codeLenses = [];
        for (const c of candidates) {
            if (!workspaceIndex.hasLocalInterface(c.receiverType, c.methodName, document.fileName)) continue;
            const range = new vscode.Range(c.index, 0, c.index, document.lineAt(c.index).text.length);
            codeLenses.push(
                new vscode.CodeLens(range, {
                    title: '← goto interface',
                    command: 'go-interface-lens.gotoInterface',
                    arguments: [c.receiverType, c.methodName, document.uri],
                })
            );
        }
        return codeLenses;
    }

    resolveCodeLens(codeLens) {
        return codeLens;
    }
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------
async function navigateTo(filePath, line) {
    try {
        const document = await vscode.workspace.openTextDocument(filePath);
        const position = new vscode.Position(Math.max(0, line), 0);
        const selection = new vscode.Selection(position, position);
        // Pass the target selection to showTextDocument so the file opens with the
        // cursor already on the target line. Setting editor.selection afterwards would
        // create a second navigation-history entry (open at 0:0, then jump), which is
        // why "Go Back" required two presses to return to the originating interface.
        await vscode.window.showTextDocument(document, { selection });
    } catch (err) {
        vscode.window.showErrorMessage(`Error opening file: ${err.message}`);
    }
}

async function pickAndNavigate(items, placeHolder) {
    const selected = await vscode.window.showQuickPick(items, {
        placeHolder,
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (selected) await navigateTo(selected.filePath, selected.line);
}

// Delay before a slow search shows its progress notification (ms). Searches
// that finish faster than this show no progress bar at all, avoiding a
// distracting flash for the common fast case.
let PROGRESS_DELAY_MS = 250;

/**
 * Run `search` (index building + searching) and only show a progress
 * notification if it takes longer than PROGRESS_DELAY_MS. Fast searches show
 * nothing; slow ones get a spinner that disappears as soon as results are
 * ready. The QuickPick and navigation happen afterwards, outside this scope.
 *
 * The progress notification is started lazily on a timer. If the work finishes
 * first, the timer is cancelled and `withProgress` is never invoked.
 *
 * @returns the value returned by `search`
 */
async function withSearchProgress(documentUri, title, search) {
    // A click may beat the edit-event debounce. Synchronize the originating
    // dirty document before consulting the index so newly typed declarations
    // are immediately searchable without requiring a save.
    syncOpenDocument(documentUri);
    const roots = resolveSearchRoots(documentUri);

    const work = (async () => {
        await Promise.all(roots.map((root) => workspaceIndex.ensureBuilt(root)));
        return search();
    })();

    let settled = false;
    work.then(
        () => {
            settled = true;
        },
        () => {
            settled = true;
        }
    );

    let timer;
    const delay = new Promise((resolve) => {
        timer = setTimeout(resolve, PROGRESS_DELAY_MS);
    });

    // Wait for either the work to finish quickly, or the delay to elapse.
    await Promise.race([work.catch(() => {}), delay]);

    if (settled) {
        // Finished within the delay window: no progress bar shown.
        clearTimeout(timer);
        return work;
    }

    // Still running after the delay: show a progress notification that lives
    // until the work completes.
    return vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: false },
        () => work
    );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function showImplementations(interfaceName, documentUri) {
    log(`showImplementations: ${interfaceName}`);
    const items = await withSearchProgress(documentUri, `Searching ${interfaceName} implementations...`, () => {
        const found = workspaceIndex.findImplementations(interfaceName, documentUri.fsPath);
        return found
            .filter((r) => !shouldExclude(r.file, r.name))
            .map((r) => ({
                label: `$(symbol-struct) ${r.name}`,
                description: `${path.basename(path.dirname(r.file))}/${path.basename(r.file)}`,
                filePath: r.file,
                line: r.line,
            }));
    });

    if (items.length === 0) {
        vscode.window.showInformationMessage(`No implementations found for ${interfaceName}`);
        return;
    }
    await pickAndNavigate(items, `${items.length} implementation(s) of ${interfaceName}`);
}

async function showMethodImplementations(interfaceName, methodName, documentUri) {
    log(`showMethodImplementations: ${interfaceName}.${methodName}`);
    const items = await withSearchProgress(documentUri, `Searching ${methodName} implementations...`, () => {
        const found = workspaceIndex.findMethodImplementations(interfaceName, methodName, documentUri.fsPath);
        return found
            .filter((r) => !shouldExclude(r.file, r.name))
            .map((r) => ({
                label: `$(symbol-method) ${r.name}.${methodName}`,
                description: `${path.basename(path.dirname(r.file))}/${path.basename(r.file)}:${r.line + 1}`,
                detail: r.signature,
                filePath: r.file,
                line: r.line,
            }));
    });

    if (items.length === 0) {
        vscode.window.showInformationMessage(`No implementations found for ${methodName}`);
        return;
    }
    await pickAndNavigate(items, `${items.length} implementation(s) of ${interfaceName}.${methodName}`);
}

async function gotoInterface(receiverType, methodName, documentUri) {
    log(`gotoInterface: ${receiverType}.${methodName}`);
    const items = await withSearchProgress(documentUri, `Searching interfaces with ${methodName}...`, async () => {
        const found = await workspaceIndex.findInterfaces(receiverType, methodName, {
            receiverFile: documentUri.fsPath,
        });
        return found.map((r) => ({
            label: `$(symbol-interface) ${r.name}${r.external ? ' $(package)' : ''}`,
            description: `${path.basename(path.dirname(r.file))}/${path.basename(r.file)}:${r.line + 1}`,
            filePath: r.file,
            line: r.line,
        }));
    });

    if (items.length === 0) {
        vscode.window.showInformationMessage(`No interfaces found declaring ${methodName}`);
        return;
    }
    await pickAndNavigate(items, `${items.length} interface(s) declaring ${methodName}`);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
function activate(context) {
    output = vscode.window.createOutputChannel('Go Interface Lens');
    context.subscriptions.push(output);
    log('Go Interface Lens activated');

    workspaceIndex = new WorkspaceIndex(getConfiguration, log);
    context.subscriptions.push({ dispose: () => workspaceIndex.dispose() });

    const provider = new GoInterfaceLensProvider();
    const gotoInterfaceProvider = new GoGotoInterfaceLensProvider();
    // Match Go documents regardless of URI scheme. Restricting to `scheme: 'file'`
    // meant the CodeLens providers were never invoked in remote environments
    // (Remote-SSH, dev containers, WSL), where editor documents use the
    // `vscode-remote` scheme instead of `file`, so no lenses appeared at all.
    // Language-only matching covers local `file` and every remote scheme.
    const selector = { language: 'go' };

    // Shift the first workspace scan into idle background time. The timer keeps
    // activation and CodeLens rendering synchronous, while ensureBuilt's own
    // promise guard prevents this and provider-triggered prewarming from doing
    // duplicate work.
    const prewarmTimer = setTimeout(
        () => prewarmWorkspace(undefined, 'activation'),
        WORKSPACE_PREWARM_DELAY_MS
    );
    if (typeof prewarmTimer.unref === 'function') prewarmTimer.unref();

    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(selector, provider),
        vscode.languages.registerCodeLensProvider(selector, gotoInterfaceProvider),
        vscode.commands.registerCommand('go-interface-lens.showImplementations', showImplementations),
        vscode.commands.registerCommand(
            'go-interface-lens.showMethodImplementations',
            showMethodImplementations
        ),
        vscode.commands.registerCommand('go-interface-lens.gotoInterface', gotoInterface),
        vscode.commands.registerCommand('go-interface-lens.clearCache', () => {
            workspaceIndex.clear();
            provider._onDidChangeCodeLenses.fire();
            gotoInterfaceProvider._onDidChangeCodeLenses.fire();
            vscode.window.showInformationMessage('Go Interface Lens: index cleared');
        }),
        // When the index is invalidated by background Go file changes, recompute
        // lenses. The "goto interface" lens is conditional on a matching
        // interface existing, so an edit that adds/removes an interface must be
        // reflected without requiring the file to be reopened.
        workspaceIndex.onDidChange(() => {
            provider._onDidChangeCodeLenses.fire();
            gotoInterfaceProvider._onDidChangeCodeLenses.fire();
        }),
        vscode.workspace.onDidChangeTextDocument((event) => scheduleDocumentOverlay(event.document)),
        vscode.workspace.onDidSaveTextDocument((document) => {
            if (document.languageId !== 'go' || !document.uri.fsPath) return;
            cancelOverlayTimer(document.uri.fsPath);
            workspaceIndex.updateFileText(document.uri.fsPath, document.getText());
        }),
        vscode.workspace.onDidCloseTextDocument((document) => {
            if (document.languageId !== 'go' || !document.uri.fsPath) return;
            cancelOverlayTimer(document.uri.fsPath);
            workspaceIndex.clearOverlay(document.uri.fsPath);
        }),
        {
            dispose: () => {
                clearTimeout(prewarmTimer);
                for (const timer of overlayTimers.values()) clearTimeout(timer);
                overlayTimers.clear();
            },
        }
    );

    log('All components registered');
}

function deactivate() {
    if (workspaceIndex) workspaceIndex.dispose();
    log('Go Interface Lens deactivated');
}

module.exports = { activate, deactivate };

// Exposed for tests only; not part of the extension's public surface.
module.exports._test = {
    withSearchProgress,
    getProgressDelay: () => PROGRESS_DELAY_MS,
    setProgressDelay: (ms) => {
        PROGRESS_DELAY_MS = ms;
    },
    setWorkspaceIndex: (idx) => {
        workspaceIndex = idx;
    },
    GoGotoInterfaceLensProvider,
    GoInterfaceLensProvider,
    resolvePrewarmRoots,
    prewarmRoots,
};
