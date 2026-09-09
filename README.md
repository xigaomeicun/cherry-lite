# Cherry Lite

私人定制的 [Cherry Studio](https://github.com/CherryHQ/cherry-studio) 源码分叉。

| | |
|---|---|
| **本仓** | https://github.com/xigaomeicun/cherry-lite |
| **上游** | https://github.com/CherryHQ/cherry-studio (`upstream`) |
| **安装目标** | `/Applications/Cherry Studio.app` |

功能以**本仓 TypeScript 源码**为准：改代码 → 本地打包 → 覆盖安装。不要对 lite 包再跑 asar 热补丁。

运维细节（打包、回滚、白名单、TG 能力清单）见本机 skill：`cherrystudio-ops` → `references/cherry-lite.md`。

---

## 与上游的主要差异（摘要）

- Telegram：中文扩展菜单、忙时排队、Plan / AskUser / 工具审批卡；`/status` 用模型 `contextWindow`
- 滚动跟随、幽灵 Tooltip、Dock 单击、完成/审批音、空 SYSTEM 仍可预览 MD
- 去 BabelDOC / 商业 MCP Seeder；数据设置侧栏去掉坚果云 / S3 / 语雀 / Joplin / 思源
- 内置 `code-cli-skills` 只留 5 个白名单目录
- Composer 输入框高度可拖拽并持久化

---

## 开发

```bash
pnpm install
pnpm dev
```

约定与架构：[`CLAUDE.md`](./CLAUDE.md)（同 [`AGENTS.md`](./AGENTS.md)）。  
UI 样式：[`DESIGN.md`](./DESIGN.md)。  
内部参考文档：[`docs/`](./docs/README.md)。

常用检查：

```bash
pnpm lint          # format + typecheck + i18n
pnpm test:renderer # 或 test:main / vitest 单文件
pnpm docs:check    # 仅改文档时
```

---

## 打包与安装（默认本地）

```bash
pnpm build:mac:arm64

osascript -e 'quit app "Cherry Studio"' || true
rm -rf "/Applications/Cherry Studio.app"
ditto "dist/mac-arm64/Cherry Studio.app" "/Applications/Cherry Studio.app"
xattr -cr "/Applications/Cherry Studio.app"
open -a "Cherry Studio"
```

Gatekeeper「已损坏」时：

```bash
sudo xattr -r -d com.apple.quarantine "/Applications/Cherry Studio.app"
```

云端 workflow（`build-lite.yml` / `ci.yml`）均**仅** `workflow_dispatch`，push / tag 不会自动跑。

```bash
gh workflow run build-lite.yml -R xigaomeicun/cherry-lite   # 可选云端 DMG
gh workflow run ci.yml -R xigaomeicun/cherry-lite           # 可选完整测试
```

---

## 上游同步

```bash
git fetch upstream
git merge upstream/main   # 或 cherry-pick
# 本地验证 / 打包后再
git push origin main
```

---

## License

继承上游 [AGPL-3.0](./LICENSE)。本仓为私人分叉，不以社区贡献入口为目标。
