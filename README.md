# MarkItDown Converter

基于微软 `markitdown` 的轻量桌面小工具，当前采用 `Tauri 2 + React + TypeScript` 实现，优先面向 `macOS Apple Silicon`。

## 功能

- 选择单个文件或整个文件夹，批量转换为 Markdown
- 输出目录保持原始层级，统一生成 `.md`
- 转换时显示文件级进度、成功/失败/跳过统计
- 优先复用系统已有或 Codex 共享的 `markitdown`
- 支持在应用内检查和更新运行时

## 运行时策略

按以下顺序查找可用的 `markitdown`：

1. Codex 共享运行时
2. 系统现有运行时
3. 应用私有运行时

当本机不存在可用运行时时，应用会在用户目录按需安装私有运行时，而不是把完整运行时打进安装包。

## 开发

```bash
npm install
npm run dev
```

## 构建

只打 `.app`：

```bash
npm run bundle:app
```

生成 `.dmg`：

```bash
npm run bundle:dmg
```

说明：

- `bundle:app` 使用 Tauri 只生成 `.app`
- `bundle:dmg` 会先生成 `.app`，再通过项目内脚本稳定创建 `.dmg`
- 这样可以绕过 Tauri 自带 `bundle_dmg.sh` 在当前环境里偶发的 Finder AppleScript 失败

## 版本产物

当前仓库已同步 `v1.0.1` 对应发行包：

- `releases/1.0.1/MarkItDown Converter_1.0.1_aarch64.dmg`

## 目录说明

- `src/`: React 前端
- `src-tauri/`: Tauri Rust 后端与打包配置
- `scripts/build-macos-dmg.mjs`: 固化后的 macOS DMG 打包脚本
- `releases/`: 已同步到仓库的发行包
