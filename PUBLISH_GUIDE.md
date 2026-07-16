# Go Interface Lens 发布指南

## 发布身份

- Marketplace Publisher ID：`xiaoyao`
- 扩展 ID：`xiaoyao.go-interface-lens`
- 仓库：`https://github.com/NightAsker/go-interface-lens`

Publisher ID 必须与 Visual Studio Marketplace 中创建的 ID 完全一致。如果
`xiaoyao` 不可用，需要同步修改 `package.json` 中的 `publisher` 和本文档。

## 发布前检查

```bash
npm test
npx @vscode/vsce package
```

生成的安装包名称为：

```text
go-interface-lens-1.0.3.vsix
```

## 发布到 VS Code Marketplace

1. 打开 `https://marketplace.visualstudio.com/manage/publishers/`。
2. 创建 Publisher，ID 使用 `xiaoyao`。
3. 创建具备 Marketplace Manage 权限的发布凭据。
4. 登录并发布：

```bash
npx @vscode/vsce login xiaoyao
npx @vscode/vsce publish
```

不要把 PAT、访问令牌或其他凭据写入仓库。

## 发布到 Open VSX

```bash
OVSX_TOKEN=<token> npx ovsx publish go-interface-lens-1.0.3.vsix
```

## 后续版本

1. 更新 `package.json` 中的 SemVer 版本。
2. 更新 `CHANGELOG.md`。
3. 运行全部测试。
4. 重新打包并核验 VSIX 内的 Publisher、名称与版本。
5. 创建 Git tag 和 GitHub Release 后再发布市场版本。
