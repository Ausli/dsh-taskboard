# Implementation Plan: Workspace Discovery Performance Optimization & Skip Dirs Configuration

## Overview
彻底解决 `dsh-taskboard` 工作区多仓库扫描打爆 Node.js `libuv` 线程池导致 `/dsh-taskboard/workspaces` 超时及 DSH 全局卡顿的问题。核心策略为：
1. **分层短路评估（Fast-path Short-circuiting）**：根 Git 仓库默认为单仓（0.001s），跳过盲目深搜；识别 `.svn` 及非 Git 目录直接退出，消除对大型游戏代码库（如 mhxy）数十万小文件的无效遍历。
2. **扫描器安全加固与超时熔断**：扩展内置 `DEFAULT_SKIP_DIRS`（默认跳过 `.svn`、重型数据目录等），为单项目扫描增加时间预算兜底（fail-soft 截断，防卡死），并发控制保护 libuv 线程池。
3. **用户自定义跳过目录配置**：在 `BoardSettings` 与看板设置界面提供 `skipDirs` 配置输入，兼顾极端自定义需求。

## Architecture Decisions
1. **快检优先原则（Fast-path First）**：
   - 根目录为 Git 仓库且无多仓标记时，直接返回 `gitAvailable = true, repoCount = 1`，不再无脑递归遍历 3 层子目录。
   - 根目录下发现 `.svn` 时，直接判定 `gitAvailable = false, repoCount = 0`，不进入子目录。
2. **多仓扫描仅在容器工作区（Container Workspaces）按需受控执行**：
   - 当根目录不是 Git 仓库时，仅在第一层探测到可能存在 Git 子仓的目录下受控浅搜；
   - 单工作区扫描设定 800ms 超时熔断，超时立即返回已发现结果并记录警告，绝不长时间挂死事件循环。
   - 34 个工作区并发从 `Promise.all` 改为限流批处理（并发度 ≤ 4），防止瞬时占满 Node.js `UV_THREADPOOL_SIZE`。
3. **配置系统扩展**：
   - `BoardSettings` 增加 `skipDirs?: string[]`，支持用户在设置弹窗中输入纯目录名列表（如 `db, npc, prot, taskedit`），与默认跳过名单合并为 `Set<string>`，O(1) 快速排除。
4. **前端接口弹性与容错**：
   - 前端 `api.ts` 请求超时适度放宽至 15s，且在异常时平滑降级，不阻断看板主界面加载。

## Task List

### Phase 1: Scanner Hardening & Fast-Path Short-Circuiting (Host Core)
- [ ] Task 1: 扫描器内置默认过滤与时间预算熔断 (`src/host/repos.ts` & `tests/repos.spec.ts`)
- [ ] Task 2: 工作区探测分层短路逻辑与并发限流 (`src/host/routes.ts` & `tests/routes.spec.ts`)

### Checkpoint: Host Core
- [ ] 单元测试验证：根 Git 仓单仓快检、SVN 仓秒级跳过、单仓超时熔断、深层目录过滤。
- [ ] 性能验证：现场 34 个工作区扫描耗时从 60s+ 降至 0.05s 以内。

### Phase 2: Configuration & Protocol (Settings Layer)
- [ ] Task 3: 共享协议与数据校验扩展 (`src/shared/protocol.ts`, `src/host/store.ts` & `tests/protocol.spec.ts`)
- [ ] Task 4: 国际化中英文字典补充 (`src/client/i18n/zh.ts`, `en.ts` & `tests/i18n.spec.ts`)

### Checkpoint: Protocol & i18n
- [ ] 协议校验与字典一致性测试全绿。

### Phase 3: GUI & Integration (Settings Modal & End-to-End)
- [ ] Task 5: 看板设置弹窗增加“跳过目录”配置输入与缓存联动 (`src/client/board/SettingsModal.tsx` & tests)
- [ ] Task 6: 前端超时时间调整与端到端实测验证 (`src/client/api.ts`, 实际 DSH 环境热更新验证)

### Checkpoint: Complete
- [ ] 全套测试通过 (`npm run test`)
- [ ] 生产构建成功 (`npm run build`)
- [ ] 现场 curl `/dsh-taskboard/workspaces` 实测响应在毫秒级，无超时报错，DSH 页面加载恢复流畅。

## Risks and Mitigations
| Risk | Impact | Mitigation |
| :--- | :--- | :--- |
| 单仓直接短路可能遗漏特殊的“根也是仓，子也是仓”极端嵌套架构 | Low | 仅在根仓未显式配置多仓模式且第一层未直接显露子仓时快速短路；用户可通过配置明确声明，或仅在需要 mirror 时深搜。 |
| 用户输入的目录名含有特殊字符或路径斜杠 | Medium | `asBoardSettings` 做清洗：过滤路径分隔符 `/` 和 `\`，仅保留有效目录名，去重并截断至上限 100 项。 |
| 超时熔断导致极端超大仓库漏算个别子仓库 | Low | 纯容器超大仓库在 800ms 内一般已可完成前 3 层探测；即使用户目录异常庞大，熔断保证了系统可用性（fail-soft 本身就是该模块的立项设计原则）。 |

## Open Questions
- 无（所有技术细节与权衡已在调研与方案讨论中明确闭环）。
