# Tasks: Workspace Discovery Performance Optimization & Skip Dirs Configuration

## Task 1: 扫描器内置默认过滤与时间预算熔断

**Description:** 在 `src/host/repos.ts` 中，将硬编码的私有常量 `SKIP_DIRS` 扩展为包含 `.svn` 及通用重型目录（`db`, `res`, `assets`, `data`, `logs` 等）的默认名单；为 `findNestedRepos` 增加单个工作区扫描的时间预算（例如 800ms 熔断超时，超时立即 fail-soft 截断返回已发现的仓库列表，防止长时间占用 Node.js 异步 I/O 线程池）；支持传入动态 `extraSkipDirs`。

**Acceptance criteria:**
- [ ] 内置跳过名单默认包含 `'.svn'` 及常见大型目录名称
- [ ] `findNestedRepos` 接受可选的自定义跳过目录集合 `extraSkipDirs?: ReadonlySet<string>`
- [ ] 单个工作区扫描耗时超过时间预算（800ms）时自动截断退出，不抛异常，fail-soft 返回已收集的结果
- [ ] 补充/更新单元测试，验证 `.svn` 阻断、自定义 skip 目录阻断以及超时熔断逻辑

**Verification:**
- [ ] Tests pass: `npx vitest run tests/repos.spec.ts`
- [ ] Build succeeds: `npm run typecheck`

**Dependencies:** None

**Files likely touched:**
- `src/host/repos.ts`
- `tests/repos.spec.ts`

**Estimated scope:** Small (2 files)

---

## Task 2: 工作区探测分层短路逻辑与并发限流

**Description:** 在 `src/host/routes.ts` 的 `workspaceRepos` 逻辑中实现分层短路判断（Fast-path）：
1. 若根目录检测到是普通 Git 仓库（`rootRepo === true`），且第一层未检测到多仓特征，默认直接认定 `repoCount = 1`，跳过无谓的 3 层子目录深搜；
2. 若根目录下存在 `.svn` 目录，直接认定 `gitAvailable = false, repoCount = 0`，不进行任何子目录扫描；
3. 将全量工作区并发从无限制的 `Promise.all` 改为受控批处理（并发度 ≤ 4），避免打满 Node.js `UV_THREADPOOL_SIZE`。

**Acceptance criteria:**
- [ ] 单 Git 根仓库命中快检路径，不再触发深度递归扫描
- [ ] SVN 仓库秒级识别并短路退出，耗时降至 1ms 级别
- [ ] 多工作区批量检测使用并发限制（concurrency control），消除 libuv 线程池饥饿
- [ ] 单元测试验证短路逻辑及 `workspaces` 路由返回的数据结构与行为一致

**Verification:**
- [ ] Tests pass: `npx vitest run tests/routes.spec.ts`
- [ ] Build succeeds: `npm run typecheck`

**Dependencies:** Task 1

**Files likely touched:**
- `src/host/routes.ts`
- `tests/routes.spec.ts`

**Estimated scope:** Medium (2-3 files)

---

## Checkpoint: Host Core
- [ ] Task 1 与 Task 2 完成
- [ ] `npx vitest run tests/repos.spec.ts tests/routes.spec.ts` 全绿
- [ ] 现场实测 34 个工作区无缓存探测耗时从 60s+ 降至 0.05s 以内

---

## Task 3: 共享协议与数据校验扩展

**Description:** 在 `src/shared/protocol.ts` 的 `BoardSettings` 类型中增加 `skipDirs?: string[]` 字段，并在 `asBoardSettings` 中实现校验与清洗（去重、去首尾空格、过滤路径斜杠、限制数量 ≤ 100）。在 `src/host/store.ts` 与相关测试中完善支持。

**Acceptance criteria:**
- [ ] `BoardSettings` 支持可选字段 `skipDirs?: string[]`
- [ ] `asBoardSettings` 严格校验输入数组，非法元素被清洗，保留合法目录名，单项无 `/` 或 `\`
- [ ] 单元测试验证 `asBoardSettings` 对 `skipDirs` 的合法处理与边界异常抛出

**Verification:**
- [ ] Tests pass: `npx vitest run tests/protocol.spec.ts`
- [ ] Build succeeds: `npm run typecheck`

**Dependencies:** None

**Files likely touched:**
- `src/shared/protocol.ts`
- `tests/protocol.spec.ts`

**Estimated scope:** Small (2 files)

---

## Task 4: 国际化中英文字典补充

**Description:** 在中英文字典中增加设置弹窗中“跳过目录”配置项相关的文案键，包括配置区域标题、描述说明、占位符示例、重置按钮文案等。

**Acceptance criteria:**
- [ ] `src/client/i18n/zh.ts` 补充跳过目录相关的翻译键
- [ ] `src/client/i18n/en.ts` 补充对应英文翻译键
- [ ] `tests/i18n.spec.ts` 中英文键一致性测试通过

**Verification:**
- [ ] Tests pass: `npx vitest run tests/i18n.spec.ts`
- [ ] Build succeeds: `npm run typecheck`

**Dependencies:** None

**Files likely touched:**
- `src/client/i18n/zh.ts`
- `src/client/i18n/en.ts`
- `tests/i18n.spec.ts`

**Estimated scope:** Small (3 files)

---

## Checkpoint: Protocol & i18n
- [ ] Task 3 与 Task 4 完成
- [ ] `npx vitest run tests/protocol.spec.ts tests/i18n.spec.ts` 全绿
- [ ] `npm run typecheck` 无类型错误

---

## Task 5: 看板设置弹窗增加“跳过目录”配置输入与缓存联动

**Description:** 在 `src/client/board/SettingsModal.tsx` 中增加“跳过扫描目录（Skip Directories）”输入区。支持逗号或换行分隔的目录名输入，绑定草稿状态，在提交保存时传给 controller 并持久化。服务端在设置变更时自动清理 `repoScanner` 缓存。

**Acceptance criteria:**
- [ ] 设置弹窗渲染“跳过扫描目录”配置区域，展示当前已配置项及内置默认项提示
- [ ] 支持用户编辑、保存及恢复默认
- [ ] 保存设置后，服务端正确更新并重置扫描缓存
- [ ] 对应单元测试通过

**Verification:**
- [ ] Tests pass: `npx vitest run tests/default-settings.spec.ts`
- [ ] Build succeeds: `npm run typecheck`

**Dependencies:** Task 2, Task 3, Task 4

**Files likely touched:**
- `src/client/board/SettingsModal.tsx`
- `tests/default-settings.spec.ts`

**Estimated scope:** Small (2 files)

---

## Task 6: 前端超时时间调整与端到端实测验证

**Description:** 在 `src/client/api.ts` 中将请求超时时间 `TIMEOUT_MS` 从 10s 适当放宽至 15s；在 DSH 真实运行环境下热重载/重启并验证 `/dsh-taskboard/workspaces` 实际加载耗时与稳定性。

**Acceptance criteria:**
- [ ] `src/client/api.ts` 超时阈值优化为 15,000ms
- [ ] 生产打包构建成功 (`npm run build`)
- [ ] 真实环境中通过 curl 与浏览器访问，工作区接口毫秒级返回，无任何 timeout 报错

**Verification:**
- [ ] Build succeeds: `npm run build`
- [ ] E2E check: `curl -s -w "\ntime_total: %{time_total}s\n" http://127.0.0.1:3080/dsh-taskboard/workspaces` 耗时 < 0.1s
- [ ] DSH Web 页面加载流畅，看板无报错卡顿

**Dependencies:** Task 1 至 Task 5

**Files likely touched:**
- `src/client/api.ts`
- 构建打包产物 (`lib/`)

**Estimated scope:** Small (1-2 files)

---

## Checkpoint: Complete
- [ ] 所有单元测试通过 (`npm run test`)
- [ ] 生产构建成功 (`npm run build`)
- [ ] `/dsh-taskboard/workspaces` 接口在无缓存状态下秒开（< 0.05s）
- [ ] 确认 DSH 整体运行流畅，无其他接口排队超时
