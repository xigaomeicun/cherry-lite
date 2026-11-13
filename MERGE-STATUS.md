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

---

## 2026-11-13 晚 续跑（小白接手 Devin 中断处）

### 已完成（本批提交 `5037d10d9f` / `888d24c8cc`）

- `pnpm install` 收尾 + lockfile 提交（`5037d10d9f`）
- 复活清理（`888d24c8cc`）：
  - 目录删除：`pages/{knowledge,miniApps,marketplace,code}`、`components/MiniApp`、`services/{automation,trash}`、`deepSeekHarness` 相关、`computerUse`、`automationRepl` 工具/MCP server、`trash/computerUse` ipc handlers、`app/marketplace` route
  - 拆线：`serviceRegistry`、`agentMcpServers`（AUTOMATION 块）、`cherryBuiltinTools`（kb_* 工具）、`buildAgentParams`（automationRun）、`aiSdk/context`（automationRun）、`SubWindowAppShell`（MiniAppTabsPool）
- 主人确认：知识库 / 小程序 / DSH 全部退役，与删除方向一致

### ⚠️ 真实拦路虎（Devin 当初也卡在这）

`pnpm typecheck` 全量 **956 错误 / 385 文件**，且**不是**删除目录造成的，而是上游 API 漂移型债务：

- `AgentSessionRuntimeService` 泛型签名漂移（`AgentSessionRuntimeState<TTurn,TPendingTurn>` 要求 2 参、找不到 `@shared/ai/agentSessionFlowParts`）
- `AiService` 多处 `AiToolApprovalRespondResponse` 形状变化、`generateMcpSampling` 消失、`finishReason` 改名
- `data/api/handlers/*` 统一 `ApiHandler` 要求补 `DELETE/PATCH/POST/PUT`（keep-ours 旧文件与上游类型不兼容）
- `skill.marketplace.members` / `ui.marketplace.*` / `CacheMiniAppType` / `agent.skills.external_export.enabled` 等**上游新增 key 的 shared schema 未补**（lite 的 preferenceTypes/cacheSchemas 是旧版）
- `serviceRegistry` 新服务（SkillSubscription/UsageBudget/OfficialAnnouncement 等）import 的 key 在上游 schema 里有、在 lite 里没注册

### 剩余待办

1. 逐包修 typecheck（大头在 `src/main/ai` 481、`src/main/data` 219、`src/main/services` 189）——工作量数小时，须按「keep-ours 旧 API → 上游新 API」逐个适配
2. `src/shared` 的 schema 追平（preferenceTypes / cacheSchemas / apiSchemas / ipcSchemas 的 key 补齐）
3. 定向测试（ChannelMessageHandler/fork/agentSession/迁移 0031–0037）
4. `pnpm build:mac:arm64` → ditto 覆盖安装（**我在 Cherry 里，只构建，安装命令交主人**）
5. 运维文档更新

### 判断

- ✅ 可以收口的：复活清理方向已闭环，删除面与主人指令一致
- ⚠️ 无法本批收口的：全量 typecheck 绿——上游一次性带来 ~15 个新服务 + 大量 API 重构，债务规模超出单次会话可安全消化的范围，建议拆「修 shared schema → 修 main/ai → 修 main/data」三批逐个来

## 2026-11-15 — shared 层收口 (efa9ec2397)

shared/tests 全部清 0。剩余 749 错全在 `src/main`：

| 目录 | 错误数 | 主要形态 |
|---|---|---|
| src/main/ai | 479 | AgentSession* 泛型签名、@shared/ai 模块漂移 |
| src/main/services | 203 | ApiHandler 形状变化 |
| src/main/data | 25 | 新服务适配 |
| src/main/features | 24 | 同上 |
| src/main/ipc | 16 | 路由契约 |

**真身**：上游 `agent-runtime` 重构（#22856 起）把 main 层的
类型管线改了，lite 的 pi-runtime merge 带来 `pi-durable` 后端 +
`agentSessionFlowParts` 等共享模块——shared 已修平，main 层需要
逐文件跟随上游 23800-24200 系 PR 的类型改动做适配。

下一步：按目录分批修 `src/main/ai`（479）→ `src/main/services`（203）。
