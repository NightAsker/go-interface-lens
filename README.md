# Go Interface Lens

[![Version](https://img.shields.io/badge/version-1.1.5-blue.svg)](https://github.com/NightAsker/go-interface-lens)
[![VSCode](https://img.shields.io/badge/VSCode-1.60+-green.svg)](https://code.visualstudio.com/)

一个面向大型 Go 工程的 VS Code / Cursor 接口导航扩展。它在接口、接口方法和具体实现之间提供双向 CodeLens，同时使用轻量候选索引和按需 AST 校验兼顾响应速度与查找准确性。

不依赖 gopls，也不会在启动时构建整个工程的语法树。

## 工程特色

### 快速启动，按需精确查找

- 启动阶段只建立轻量的方法名候选索引，不扫描依赖目录，也不构建全工程 AST。
- 点击 CodeLens 后，仅解析接口所在包和可能包含实现的候选包。
- 优先使用接口中出现频率最低的方法缩小候选范围。
- 已完成的查询直接使用内存缓存，未变化的文件可从持久化 AST 缓存恢复。

### 自己完成 Go 接口匹配

扩展内置声明级 Go lexer 和 AST，不通过 VS Code LSP API 或 gopls 查询实现。当前支持：

- Go 的隐式接口实现和完整方法签名校验。
- 值接收者、指针接收者及其不同的方法集。
- 本地或跨包嵌入的 struct、interface 和类型别名。
- 标准库接口、`go.mod` 锁定依赖、local replace、module replace 和 GOROOT 源码。
- import 别名、包内别名、跨包别名链和复合别名。
- `byte`/`uint8`、`rune`/`int32`、`any`/`interface{}` 等价关系，并尊重包级同名声明遮蔽。
- 多行声明、分组参数、泛型实例、匿名接口和嵌套函数类型。
- 指针、切片、数组、map、可变参数、channel、包限定类型和 Unicode 参数名的签名归一化。
- Go build tags、GOOS/GOARCH 文件约束和未保存编辑内容。

### 双向导航

```go
implementations
type UserRepository interface {
    → implementations
    FindByID(ctx context.Context, id string) (*User, error)

    → implementations
    Save(ctx context.Context, user *User) error
}
```

```go
← goto interface
func (r *PostgresUserRepository) FindByID(
    ctx context.Context,
    id string,
) (*User, error) {
    // ...
}
```

- `implementations`：查看完整实现该接口的类型，并跳转到类型声明。
- `→ implementations`：查看某个接口方法的实现，并跳转到具体方法。
- `← goto interface`：从接收者方法反向查找匹配的接口。

### 为大型工程控制开销

- 候选包 AST 使用 1-4 个 Worker Thread 并发解析，默认并发数为 2。
- 相同文件的并发解析请求会自动合并。
- 依赖接口只在工作区查找不到结果时按需搜索，不全量索引 module cache。
- 外部依赖中的 concrete type 不会混入工作区实现结果。
- 文件监听、未保存 overlay 和查询结果都支持增量失效。
- 支持 multi-root workspace，并保持同名包、同名接口和同名类型相互隔离。

## 使用方法

### 查看接口实现

1. 打开包含 Go interface 的文件。
2. 在 `type InterfaceName interface` 上方点击 `implementations`。
3. 在 Quick Pick 中选择目标实现。
4. 编辑器会跳转到对应 struct 或类型声明。

### 查看接口方法实现

1. 打开包含 Go interface 的文件。
2. 在目标方法上方点击 `→ implementations`。
3. 选择具体实现。
4. 编辑器会直接跳转到该方法的声明位置。

### 从实现跳转到接口

1. 打开带接收者方法的 Go 文件，例如 `func (s *Service) Run()`。
2. 点击方法上方的 `← goto interface`。
3. 选择匹配的接口。
4. 编辑器会跳转到接口声明。

查找结果会自动排除配置中的 mock、测试、生成文件和其他不需要的类型。

## 环境要求

- VS Code 1.60+，或兼容 VS Code 扩展的 Cursor 版本。
- 使用 `.go` 文件；Go module 工程可以获得最完整的跨包和依赖解析能力。
- 实现匹配不依赖 gopls。解析 GOROOT 或 module cache 中的源码时，需要本机存在相应 Go 源码或依赖缓存。

## 配置

打开 VS Code / Cursor 设置并搜索 `Go Interface Lens`，或直接编辑 `settings.json`。

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| `goInterfaceLens.astConcurrency` | `2` | 候选包 AST Worker 数量，可设置为 `1-4` |
| `goInterfaceLens.excludedFolders` | `mocks, mock, testdata, vendor` | 排除指定目录 |
| `goInterfaceLens.excludedFilePatterns` | `_mock.go, mock_, .pb.go, _test.go` | 排除文件名中包含指定文本的文件 |
| `goInterfaceLens.excludedTypePatterns` | `Mock, mock, Stub, Fake` | 排除名称中包含指定文本的类型 |
| `goInterfaceLens.searchDependencies` | `true` | 反向查找无本地结果时，按需搜索依赖接口 |
| `goInterfaceLens.goModCache` | 空 | 手动指定 Go module cache；为空时自动探测 |

示例：

```json
{
  "goInterfaceLens.astConcurrency": 2,
  "goInterfaceLens.searchDependencies": true,
  "goInterfaceLens.goModCache": "",
  "goInterfaceLens.excludedFolders": [
    "mocks",
    "mock",
    "testdata",
    "vendor",
    "generated"
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
    "Fake"
  ]
}
```

类型名以 `_` 开头时始终从实现结果中排除。

## 性能基线

开发环境中的合成测试包含 402 个 Go 文件：

- 启动候选索引约 `38ms`。
- 首次 AST 查询约 `21ms`。
- 缓存查询约 `0ms`。
- 一次稀有方法查询只解析 2 个候选文件。

实际耗时取决于工程规模、磁盘、文件系统类型和候选方法的常见程度。

## 命令

| 命令 | 作用 |
| --- | --- |
| `Go: Show Implementations` | 查看接口的完整实现 |
| `Go: Show Method Implementations` | 查看接口方法实现 |
| `Go: Goto Interface` | 从接收者方法跳转到接口 |
| `Go: Clear Implementation Lens Cache` | 清除索引和查询缓存 |

前三个命令通常由对应 CodeLens 携带上下文调用。清理缓存命令可以直接从 Command Palette 执行。

## 常见问题

### 看不到 CodeLens

1. 确认文件语言模式是 Go，且扩展已启用。
2. 确认接口不是只能用于约束的泛型接口。
3. 执行 `Developer: Reload Window`。
4. 查看 `Output -> Go Interface Lens` 和 Extension Host 日志。

VS Code 会合并同一文件上所有扩展提供的 CodeLens。如果 Go 扩展或 gopls 的 CodeLens 请求很慢，本扩展已经生成的 CodeLens 也可能延迟显示。

### 找不到实现

1. 确认实现具有接口要求的全部方法及一致的参数、返回值类型。
2. 检查值接收者和指针接收者的方法集差异。
3. 检查排除目录、文件和类型配置。
4. 执行 `Go: Clear Implementation Lens Cache` 后重试。

### 依赖中的接口找不到

1. 确认 `goInterfaceLens.searchDependencies` 为 `true`。
2. 确认依赖出现在 `go.mod` 中，或配置了有效 replace。
3. 必要时通过 `goInterfaceLens.goModCache` 指定 module cache 的绝对路径。

## License

[MIT](LICENSE)

版本记录见 [CHANGELOG.md](CHANGELOG.md)。问题反馈请提交到 [GitHub Issues](https://github.com/NightAsker/go-interface-lens/issues)。
