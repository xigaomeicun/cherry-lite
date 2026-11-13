# 上游合并状态（2026-11-13，git merge 路线）

分支 `feat/pi-runtime-merge`，worktree `/Users/shuaihui/Projects/cherry-lite-pi-merge`。
回滚点：tag `pi-merge-backup-20261113`（= 555ee3daf2 本地 tip）。
废弃路线备份：分支 `cherry-pick-attempt-288df6e5`（24 PR cherry-pick 实验，勿再用）。

## 已完成

- `git merge upstream/main`（5f9e531a2e）→ merge commit `0965a61be6`
- 1540 冲突全解：AA→theirs、DU/UD→rm（保本地删除）、485 个零本地提交 UU→theirs、28 i18n/生成文件→theirs、209 UU→theirs、~40 keep-ours→本地版
- package.json：上游版 + 本地独有 deps（grammy 等 18 个）+ version `6.0.0-lite`
- APFS fork 修复重打：`fa2d230e05`（sameDirectoryIdentity + cleanupPendingReported + 回归测试）
- TG steer 修复：保留在 keep-ours 的 ChannelMessageHandler/ChannelAdapterListener 本地版里（isTopicDone 守卫 + flushSegment 都在）
- 迁移：上游 0034–0037 已随 merge 进来（journal 连续 0031–0037）

## 进行中 / 待办

1. **pnpm install**（后台跑，网络慢）— packageManager 已是 pnpm@12.6.0，全局 npm 装的 pnpm 可跑（实际报 11.8.0 但 lockfileVersion 9.0 兼容）
2. **lite 移除功能复活清理** ⚠️ merge 把上游新增文件带回来了，需重新删除：
   - `src/renderer/pages/{knowledge,miniApps,marketplace,code}`、`src/renderer/components/{MiniApp,knowledge}`、`src/main/services/{automation,trash}`（trash/automation 是上游新增非 lite 移除，可留可删，自行判断）
   - 移除提交清单：4b58e00bc2(知识库) d8c9b5440f(小程序) cbd3e483fd(编码搭档) 5a984da473(OCR) 9d61774804(快捷/选区助手/设备连接) e435db2e64(截图菜单) 993458d8cc+560f9535bf(Yuque/Joplin/Siyuan) 7ee78140c4(小程序通知) 7ec6afc289(MCP 市场) eb177f9561(launchpad)
   - 用 `git show <commit> --name-status` 拿删除清单，照路径在新树里再删 + 清引用（路由/菜单/serviceRegistry/ipcSchemas）
3. `pnpm typecheck`（node+web+aicore）→ 修复 keep-ours 文件的 API 适配错
4. 定向测试：ChannelMessageHandler/ChannelAdapterListener、fork publication、agentSession、迁移 0031–0037 /tmp 库实测
5. `pnpm build:mac:arm64` 打包 → ditto 覆盖安装 `/Applications/Cherry Studio.app`

## 关键注意

- keep-ours 文件是本地旧版，引用的 API 可能已被上游改名 → typecheck 会列出，逐个适配（别整文件换上游，会丢本地 delta）
- `native/system-speech` 与 `packages/system-speech` 并存（上游迁移中）
- pnpm 12.6.0 官方渠道下载失败过（网络），npm -g 装的可用；若再失败可把 packageManager 临时改回 11.8.0
