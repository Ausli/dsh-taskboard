# Tasks: 任务看板“已完成”列收起、按需加载与状态持久化

## Task 1: 共享类型扩展与 `/dsh-taskboard/state` 路由支持 `excludeDone` 与 `doneCount`

**Description:** 在 `src/shared/api.ts` 中扩展 `StateResponse` 接口，增加可选字段 `doneCount?: number`。在 `src/host/routes.ts` 的 `GET /dsh-taskboard/state` 路由处理中，读取查询参数 `excludeDone`（支持 `true` 或 `1`）；在返回响应时，计算有效（未软删除）的已完成任务数量为 `doneCount`；若 `excludeDone` 为真，则在 `ledger.tasks` 中过滤掉 `status === 'done'` 的任务条目，并将 `doneCount` 一并返回给客户端。

**Acceptance criteria:**
- [x] `StateResponse` 类型声明 `doneCount?: number`
- [x] `GET /dsh-taskboard/state` 支持 `?excludeDone=true` / `?excludeDone=1` 查询参数
- [x] 当请求携带 `excludeDone` 时，返回的 `tasks` 数组不包含 `status === 'done'` 的条目，且返回的 `doneCount` 为全部有效已完成任务的总数
- [x] 当请求未携带 `excludeDone` 时，返回完整的 `tasks` 数组，且同时返回正确的 `doneCount`
- [x] 在 `tests/routes.spec.ts` 中增加测试用例覆盖上述参数行为与返回字段

**Verification:**
- [x] Tests pass: `npx vitest run tests/routes.spec.ts`
- [x] Build succeeds: `npm run typecheck`

**Dependencies:** None

**Files likely touched:**
- `src/shared/api.ts`
- `src/host/routes.ts`
- `tests/routes.spec.ts`

**Estimated scope:** Small (2-3 files)

---

## Checkpoint: Host & API
- [x] Task 1 完成
- [x] `npx vitest run tests/routes.spec.ts` 全部测试通过

---

## Task 2: 客户端 API 适配、Controller 视图持久化与条件刷新

**Description:** 在 `src/client/api.ts` 中让 `client.state` 方法支持可选入参 `{ excludeDone?: boolean }`，在发起 fetch 时自动拼接查询参数。在 `src/client/controller.ts` 中：
1. 扩展 `VIEW_KEY` (`dsh-taskboard-view-v1`) 本地持久化数据结构，支持读取与保存 `doneCollapsed?: boolean`，默认为 `false`；
2. `ControllerState` 增加 `doneCollapsed: boolean` 与 `doneCount?: number`；
3. 提供 `setDoneCollapsed(collapsed: boolean)` 控制器方法，更新状态、调用 `persistView()`，并在由收起切换到展开时（`!collapsed`）立即触发 `this.refresh()`；
4. 在 `refresh()` 方法中，当 `this.state.doneCollapsed` 为 true 时，向后端传递 `{ excludeDone: true }`；并将接口返回的 `doneCount` 存储到 ControllerState。

**Acceptance criteria:**
- [x] `client.state({ excludeDone: true })` 正确请求 `/dsh-taskboard/state?excludeDone=true`
- [x] `loadView()` 正确从 `localStorage` 中解析 `doneCollapsed` 布尔值
- [x] `controller.setDoneCollapsed(true)` 更新 `doneCollapsed`，写入 `localStorage`
- [x] 在收起状态下，`refresh()` 附带 `excludeDone: true` 请求后端；在展开状态或切换为展开时拉取全量数据
- [x] 在 `tests/client.spec.ts` 中增加测试，验证 `doneCollapsed` 持久化、状态切换与带参刷新行为

**Verification:**
- [x] Tests pass: `npx vitest run tests/client.spec.ts`
- [x] Build succeeds: `npm run typecheck`

**Dependencies:** Task 1

**Files likely touched:**
- `src/client/api.ts`
- `src/client/controller.ts`
- `tests/client.spec.ts`

**Estimated scope:** Medium (3 files)

---

## Checkpoint: Client Core
- [x] Task 1 与 Task 2 完成
- [x] `npx vitest run tests/routes.spec.ts tests/client.spec.ts` 全部测试通过

---

## Task 3: 看板 UI“已完成”列竖向收起、展开交互与拖拽放置支持

**Description:** 在 `src/client/board/TaskBoard.tsx` 中：
1. 在“已完成”列头部增加收起按钮（带折叠图标与提示文案）；
2. 当 `state.doneCollapsed` 为 true 时，“已完成”列渲染为紧凑竖条（带有 `data-collapsed="true"` 属性），垂直居中展示状态点、标题与任务总数（优先取 `state.doneCount`，兜底取 `columnTasks.length`），并带有展开按钮；
3. 收起竖条保留 `onDragOver` 和 `onDrop` 事件处理，支持拖拽任务卡片直接放入标记为已完成；
4. 在 `src/client/styles.ts` 中增加 `.dsh-atb-column[data-collapsed="true"]` 相关的紧凑竖条布局、垂直文本、悬浮与拖拽高亮样式；
5. 在 `src/client/i18n/zh.ts` 和 `en.ts` 中补充收起与展开相关的国际化键（如 `board.column.collapseDone`, `board.column.expandDone`）。

**Acceptance criteria:**
- [x] “已完成”列头部具备收起按钮，点击后触发 `controller.setDoneCollapsed(true)`
- [x] 收起后列宽变为紧凑竖条（约 40-48px），垂直显示“已完成 (N)”及展开按钮，点击可展开
- [x] 任务卡片拖拽到收起的已完成竖条能够触发高亮，并在 drop 时成功调用 `controller.move(id, version, 'done')`
- [x] 中英文字典翻译完整，`tests/i18n.spec.ts` 测试通过

**Verification:**
- [x] Tests pass: `npx vitest run tests/client.spec.ts tests/i18n.spec.ts`
- [x] Build succeeds: `npm run typecheck`

**Dependencies:** Task 2

**Files likely touched:**
- `src/client/board/TaskBoard.tsx`
- `src/client/styles.ts`
- `src/client/i18n/zh.ts`
- `src/client/i18n/en.ts`
- `tests/client.spec.ts`

**Estimated scope:** Medium (4-5 files)

---

## Checkpoint: UI & Interaction
- [x] Task 1、Task 2、Task 3 全部完成
- [x] 看板在收起与展开之间平滑切换，拖拽放置正常运作，国际化全覆盖

---

## Task 4: 端到端验证与全量回归测试

**Description:** 运行完整的测试套件、TypeScript 编译检查和生产环境打包构建，确保没有引入任何回归问题，并验证在 SSE 变更推送与搜索状态下的协同行为。

**Acceptance criteria:**
- [x] 全部单元测试与回归测试通过（无新增失败）
- [x] TypeScript 类型检查 0 报错（`npm run typecheck`）
- [x] 生产打包构建成功（`npm run build`）

**Verification:**
- [x] Tests pass: `npm run test`
- [x] Typecheck: `npm run typecheck`
- [x] Build: `npm run build`

**Dependencies:** Task 1, Task 2, Task 3

**Files likely touched:**
- 无新文件，校验全工程构建产物

**Estimated scope:** Small

---

## Checkpoint: Complete
- [x] 所有 Task 与 Checkpoint 达成
- [x] 交付准备就绪，可以安全移交用户或实施
