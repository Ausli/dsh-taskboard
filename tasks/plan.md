# Implementation Plan: 任务看板“已完成”列收起、按需加载与状态持久化

## Overview
在任务看板中为“已完成（done）”列增加整体收起折叠功能，并实现视图状态持久化与后端按需返回数据：
1. **收起状态持久化**：用户收起或展开“已完成”列的状态持久化到浏览器的 `localStorage`（复用现有 `dsh-taskboard-view-v1` 机制），刷新后保持用户偏好。
2. **后端按需过滤（性能优化）**：收起状态下，向后端请求 `/dsh-taskboard/state` 时附带 `excludeDone=true` 参数，后端不返回 `done` 状态的数据条目，避免无谓的网络传输与内存开销；同时返回 `doneCount` 总计数值，确保折叠条依然能直观展示完成数量。
3. **列内竖向折叠与拖拽兼容**：收起时，已完成列收缩为紧凑竖条，显示垂直排布的状态点、文案与计数，并保留作为 Drop Target 的能力，允许拖拽卡片直接放入标记为完成。展开时平滑还原为标准列，并自动拉取全量已完成任务。

## Architecture Decisions
1. **客户端视图偏好持久化（Local Persistence First）**：
   - 收起属于当前用户的个人工作流偏好，保存在客户端 `localStorage` 的 `dsh-taskboard-view-v1` 中（字段 `doneCollapsed: boolean`，默认为 `false` 或用户上次的选择），不污染全局共享的 `BoardSettings`。
2. **条件查询与统计回传（Exclude & Count Protocol）**：
   - 扩展 `GET /dsh-taskboard/state` 接口：支持查询参数 `?excludeDone=true`。
   - 当 `excludeDone=true` 时，后端在过滤任务时剔除 `status === 'done'` 的任务，但计算并回传 `doneCount: number`（有效未进回收站的已完成任务总数）。
   - 当未传或为 false 时，返回全量任务，同时附带 `doneCount`，保持协议前后一致与向后兼容。
3. **Controller 状态机与按需刷新（State & Lifecycle）**：
   - `ControllerState` 记录 `doneCollapsed: boolean` 与 `doneCount?: number`。
   - `refresh()` 根据 `doneCollapsed` 动态决定是否带参请求。
   - 当用户从收起点击“展开”时，切换状态、写入本地存储，并立即触发一次 `refresh()` 补充拉取所有已完成卡片。
4. **UI 布局与拖拽体验（Compact Column & Drag-and-Drop）**：
   - 收起后的已完成列使用 `data-collapsed="true"` 属性，采用紧凑宽度（约 40px~48px），避免看板其余列宽度产生剧烈晃动。
   - 竖向显示折叠条头部、展开按钮与任务计数，保留 `onDragOver` 和 `onDrop` 事件监听，拖拽卡片至折叠条同样能触发任务流转到 `done`。

## Task List

### Phase 1: 协议与后端路由扩展 (Host & Shared API)
- [x] Task 1: 共享类型扩展与 `/dsh-taskboard/state` 路由支持 `excludeDone` 与 `doneCount` (`src/shared/api.ts`, `src/host/routes.ts` & `tests/routes.spec.ts`)

### Checkpoint: Host & API
- [x] 验证后端在 `excludeDone=true` 时返回过滤后的 tasks 以及准确的 `doneCount`。
- [x] 验证不传参数时仍返回全量 tasks 及 `doneCount`。
- [x] 单元测试 `tests/routes.spec.ts` 绿灯。

### Phase 2: 客户端 Controller 状态与数据联动 (Client Core)
- [x] Task 2: 客户端 API 适配、Controller 视图持久化与条件刷新 (`src/client/api.ts`, `src/client/controller.ts` & `tests/client.spec.ts`)

### Checkpoint: Client Core
- [x] 验证 `localStorage` 正常读写 `doneCollapsed`。
- [x] 验证收起时发起带参请求，展开时发起全量刷新。
- [x] 单元测试 `tests/client.spec.ts` 绿灯。

### Phase 3: 看板 UI 紧凑竖条交互与样式 (Client UI)
- [x] Task 3: 看板“已完成”列竖向收起、展开交互与拖拽放置支持 (`src/client/board/TaskBoard.tsx`, `src/client/styles.ts`, `src/client/i18n/zh.ts`, `en.ts`)

### Checkpoint: UI & Interaction
- [x] 看板已完成列具备收起/展开按钮，收起后呈现规整竖条并展示完成总数。
- [x] 拖拽卡片至收起竖条可正确移入“已完成”。
- [x] 中英文字典翻译完整无缺失。

### Phase 4: 端到端验证与构建验收 (Integration & Verification)
- [x] Task 4: 端到端集成验证与全量回归测试 (`tests/` 全量套件, `npm run typecheck`, `npm run build`)

### Checkpoint: Complete
- [x] 全套测试通过 (`npm run test`)
- [x] 类型检查通过 (`npm run typecheck`)
- [x] 前后端构建打包成功 (`npm run build`)

## Risks and Mitigations
| Risk | Impact | Mitigation |
| :--- | :--- | :--- |
| 收起状态下 SSE 推送了新变更，卡片移到 done 后消失但计数未同步 | Medium | 后端 SSE 变更时客户端照常调用 `refresh()`（带 `excludeDone=true`），后端回传最新的 `doneCount`，确保计数实时准确。 |
| 用户在收起状态下搜索已完成的任务找不到 | Low | 在收起状态下的折叠条中高亮显示计数并提供一键展开提示，避免用户误以为任务丢失。 |
| 收起为竖条后拖拽放置判定区过窄 | Medium | 竖条整体作为 dragover 和 drop 容器，并设置明显的边框与背景激活色反馈。 |

## Open Questions
- 默认状态：初始无 localStorage 时默认为展开还是收起？（方案定为默认展开 `doneCollapsed: false`，保证新用户首屏可见性，用户一旦点击收起后持久化生效）。
