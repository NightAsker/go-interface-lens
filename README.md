# Go Interface Lens

[![Version](https://img.shields.io/badge/version-1.1.0-blue.svg)](https://github.com/NightAsker/go-interface-lens)
[![VSCode](https://img.shields.io/badge/VSCode-1.60+-green.svg)](https://code.visualstudio.com/)

> Show implementation count above Go interfaces with one-click navigation to interface and method implementations.

## ✨ Features

- 🔍 **Visual CodeLens** above every Go interface showing "implementations"
- 🎯 **Method-level CodeLens** - Each method has "→ implementations" for direct navigation
- 🔙 **Goto Interface** Navigate from implementation methods back to their interface declarations with "← goto interface"
- 📊 **Click to navigate** - Opens a quick pick with all implementations
- ⚡ **Fast candidate search** with lazy, worker-based AST validation
- 🚫 **Smart filtering** - Automatically excludes mock implementations
- 🏗️ **Multi-package support** - Works perfectly with Go modules
- 💾 **Persistent AST cache** - Reuses compact declaration data across queries and restarts

## 📸 Screenshots

### Interface with CodeLens
```go
implementations                                    ← Click to see all implementations
type UserRepository interface {
    → implementations                              ← Click to see FindByID implementations
    FindByID(id string) (*User, error)
    → implementations                              ← Click to see Save implementations
    Save(user *User) error
}
```

### Quick Pick with Interface Implementations
```
┌─────────────────────────────────────────────────────┐
│ Select implementation of UserRepository             │
├─────────────────────────────────────────────────────┤
│ ○ PostgresUserRepository                            │
│    in repository/postgres.go                        │
│    Implements 2 method(s)                           │
└─────────────────────────────────────────────────────┘
Note: Mock implementations are automatically filtered out!
```

### Quick Pick with Method Implementations
```
┌─────────────────────────────────────────────────────┐
│ 3 implementation(s) of UserRepository.FindByID      │
├─────────────────────────────────────────────────────┤
│ ○ PostgresUserRepository.FindByID                   │
│    repository/postgres.go:45                        │
│    func (r *PostgresUserRepository) FindByID...     │
├─────────────────────────────────────────────────────┤
│ ○ MemoryUserRepository.FindByID                     │
│    repository/memory.go:23                          │
│    func (r *MemoryUserRepository) FindByID...       │
└─────────────────────────────────────────────────────┘
```

### Goto Interface (Reverse Navigation) ⭐ NEW
```go
// In your implementation file
← goto interface                                       ← Click to see which interfaces declare FindByID
func (r *PostgresUserRepository) FindByID(id string) (*User, error) {
    // implementation
}
```

## 🚀 Usage

### Method 1: Interface CodeLens (Full Implementation)
1. Open any Go file with an interface
2. Look above the `type InterfaceName interface {` declaration
3. Click on **"implementations"**
4. Select the implementation from the list
5. Navigate automatically to the struct declaration!

### Method 2: Method CodeLens (Direct Method Navigation)
1. Open any Go file with an interface
2. Look at each method inside the interface
3. Click on **"→ implementations"** next to any method
4. Select the specific implementation you want
5. Navigate directly to that method implementation!

### Method 3: Goto Interface (Reverse Navigation) ⭐ NEW
1. Open any Go file with a struct method implementation
2. Look above the method declaration with receiver (e.g., `func (r *Type) Method()`)
3. Click on **"← goto interface"**
4. Select the interface that declares this method
5. Navigate automatically to the interface declaration!

### Method 4: Command Palette
1. Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
2. Type: **"Go: Show Implementations"**, **"Go: Show Method Implementations"**, or **"Go: Goto Interface"**
3. Enter the interface/method name
4. Select from the list

## 📋 Requirements

- **VSCode/Cursor**: 1.60.0 or higher
- **Go files**: `.go` extension
- **Project structure**: Works with Go modules and any project structure
- **No gopls required**: Parsing and interface matching run inside the extension

## ⚙️ How It Works

### CodeLens Provider
The extension registers a CodeLens provider that:
1. Parses the open document for interface and receiver-method declarations
2. Shows clickable interface, method, and reverse-navigation lenses
3. Starts precise implementation matching only after click

### Search Strategy
The extension:
1. Builds a broad method-name candidate index during workspace startup
2. Chooses the least-common interface methods to narrow candidate packages
3. Parses only candidate package declarations in a bounded worker pool
4. Resolves aliases, import paths, embedded interfaces/types, and Go pointer method sets
5. Validates the complete interface method set using compact declaration IR
6. Caches file AST summaries and completed queries in memory and on disk

This pattern matches Go's implicit interface implementation:
```go
type UserRepository interface {
    FindByID(id string) (*User, error)
    Save(user *User) error
}

type PostgresUserRepository struct {
    db *sql.DB
}

// These methods are automatically detected!
func (r *PostgresUserRepository) FindByID(id string) (*User, error) {
    // implementation
}

func (r *PostgresUserRepository) Save(user *User) error {
    // implementation
}
```

### Performance
- **Startup**: Broad text indexing only; the workspace AST is never built eagerly
- **First query**: Parses candidate packages in 1-4 worker threads (default: 2)
- **Cached query**: Returns from the in-memory query cache
- **Persistent cache**: Restores unchanged candidate files using file metadata
- **Synthetic baseline**: 402 Go files indexed in ~77ms; a rare-method cold AST query took ~33ms and parsed 2 files on the development machine

## 🎨 Configuration

The extension works out-of-the-box with sensible defaults, but you can customize the filtering behavior to match your project structure.

### 🚫 Filtering Configuration

You can configure which folders, files, and types to exclude from the implementation search. This is useful for filtering out mocks, generated code, test files, and vendor dependencies.

#### Settings

Open VS Code/Cursor settings (`Cmd+,` or `Ctrl+,`) and search for "Go Interface Lens" to configure:

**`goInterfaceLens.astConcurrency`**
- Worker threads used for candidate-package AST parsing
- Range: `1-4`; default: `2`

**`goInterfaceLens.excludedFolders`**
- Array of folder names to exclude from search
- Default: `["mocks", "mock", "testdata", "vendor"]`
- Example: Add custom folders like `["mocks", "mock", "testdata", "vendor", "generated", "third_party"]`

**`goInterfaceLens.excludedFilePatterns`**
- Array of file name patterns to exclude
- Default: `["_mock.go", "mock_", ".pb.go", "_test.go"]`
- Example: Add proto files like `["_mock.go", "mock_", ".pb.go", "_test.go", ".gen.go"]`

**`goInterfaceLens.excludedTypePatterns`**
- Array of type name patterns to exclude
- Default: `["Mock", "mock", "Stub", "Fake"]`
- Example: Add custom patterns like `["Mock", "mock", "Stub", "Fake", "Test", "Dummy"]`

#### Configuration Example

Add to your `settings.json`:

```json
{
  "goInterfaceLens.astConcurrency": 2,
  "goInterfaceLens.excludedFolders": [
    "mocks",
    "mock",
    "testdata",
    "vendor",
    "generated",
    "proto"
  ],
  "goInterfaceLens.excludedFilePatterns": [
    "_mock.go",
    "mock_",
    ".pb.go",
    "_test.go",
    ".gen.go"
  ],
  "goInterfaceLens.excludedTypePatterns": [
    "Mock",
    "mock",
    "Stub",
    "Fake",
    "Test"
  ]
}
```

#### How Filtering Works

The extension checks each potential implementation against your configuration:
1. **Folder Check**: Excludes if file path contains any excluded folder name
2. **File Pattern Check**: Excludes if file name contains any excluded pattern
3. **Type Pattern Check**: Excludes if type name contains any excluded pattern
4. **Underscore Check**: Always excludes types starting with `_` (test helpers)

## 🔧 Commands

| Command | Description |
|---------|-------------|
| `Go: Show Implementations` | Manually search for interface implementations |
| `Go: Show Method Implementations` | Manually search for method implementations |
| `Go: Goto Interface` | Navigate from method implementation to interface declaration |
| `Go: Clear Implementation Lens Cache` | Clear cached search results |

## 🐛 Troubleshooting

### CodeLens not showing?
1. Make sure you're viewing a `.go` file
2. Check that the file contains `type Name interface {` declarations
3. Reload window: `Cmd+Shift+P` → "Reload Window"

### "No implementations found"?
1. Verify the implementation exists
2. Check that all interface methods are implemented
3. Ensure the receiver functions follow Go conventions: `func (r *Type) Method()`
4. Try clearing cache: `Cmd+Shift+P` → "Go: Clear Implementation Lens Cache"

### Extension not loading?
1. Check VSCode/Cursor version (must be 1.60+)
2. View Extension Host logs: `Cmd+Shift+P` → "Developer: Show Logs" → "Extension Host"
3. Look for errors related to `go-interface-lens`

## 📦 Installation

### From Marketplace (Coming Soon)
1. Open Extensions: `Cmd+Shift+X`
2. Search: "Go Interface Lens"
3. Click "Install"

### Manual Installation
1. Download `.vsix` file from [releases](https://github.com/NightAsker/go-interface-lens/releases)
2. Open Extensions: `Cmd+Shift+X`
3. Click `...` → "Install from VSIX..."
4. Select downloaded file

### From Source
```bash
cd ~/.cursor/extensions/
git clone https://github.com/NightAsker/go-interface-lens.git
cd go-interface-lens
npm install
```

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

### Development Setup
```bash
# Clone the repository
git clone https://github.com/NightAsker/go-interface-lens.git
cd go-interface-lens

# Install dependencies (if any)
npm install

# Open in VSCode/Cursor
code .

# Press F5 to launch Extension Development Host
```

## 📝 Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Built for the Go community
- Inspired by VS Code's native implementation lens
- Includes modifications to MIT-licensed software; required notices are retained in [LICENSE](LICENSE)

## 🔗 Links

- [GitHub Repository](https://github.com/NightAsker/go-interface-lens)
- [Issue Tracker](https://github.com/NightAsker/go-interface-lens/issues)
- [VSCode Marketplace](https://marketplace.visualstudio.com/items?itemName=xiaoyao.go-interface-lens)

## 💡 Tips & Tricks

### Keyboard Shortcut
Add a custom keybinding for quick access:
```json
{
  "key": "cmd+shift+i",
  "command": "go-interface-lens.showImplementations"
}
```

### Works with Interfaces
The extension understands Go's implicit interface implementation, so you don't need any special syntax or annotations!

## 🌟 Star History

If you find this extension useful, please consider giving it a ⭐ on [GitHub](https://github.com/NightAsker/go-interface-lens)!

---

**Maintained by xiaoyao**
