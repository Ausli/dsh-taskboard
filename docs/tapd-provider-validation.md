# 通用 Provider 与 TAPD 补齐验证

分支：`codex/issue-48-external-task-sync`。用户已授权继续跳过本轮看板认领，沿用本地模拟验证范围。

## 补齐内容

| 内容 | 当前实现 |
|---|---|
| 通用契约 | `src/host/external-provider.ts`；测试、列表、单项详情、可选项目发现与账号识别 |
| 注册机制 | `ExternalProviderRegistry` 与 `src/host/external-providers.ts`，注册定义包含描述、工厂及专有校验 |
| 通用配置 | `src/host/external-config.ts`；平台/认证方式、声明的 credentials/settings、工作项类型和任意项目 ID；平台自行约束项目 ID |
| 公共模型 | `src/shared/external.ts`；状态、能力和公共配置与 host 实现分离，凭据只以存在标记返回 |
| 共享 HTTP | `src/host/external-http.ts`；重试、超时、取消、错误脱敏和富文本转换 |
| TAPD | `src/host/tapd.ts`；Bug/Story/Task，Basic/Bearer、字符串 ID、精确多处理人、可配置状态/优先级、游标遍历、详情查询、项目发现 |
| 禅道兼容 | 旧顶层 Token 自动读取并保留连接 ID；保存后转 credentials；补充产品发现与 Bug 详情接口 |
| 界面 | 来源选择、认证字段、工作项类型和发现动作由注册描述驱动；卡片/详情按实际来源显示，无固定 ZenTao 品牌 |
| 来源身份 | 切换认证方式需重新提供凭据，但不更改同一平台/地址/处理人的来源 ID；切换平台/地址/处理人创建新身份 |
| 写入保护 | 校验 Provider 返回的项目、类型与工作项结构，整轮失败不写入部分结果 |

`accountDiscovery` 已纳入契约与界面能力判断；两个内置 Provider 均明确声明 false，要求用户指定真实处理人，不把企业 API 身份误判为开发者。`incremental` 均为 false：目前全量读取、按内容增量写入，无修改时间水位协议。扩展注册属于 host 编译集成点，未增加动态第三方代码加载或独立版本的 npm 子路径 API。

## 本地验证范围

- `tests/tapd.spec.ts`：Basic/Bearer 请求头、三种类型、长 ID、游标边界、重复页拒绝、状态/优先级、HTTP 200 业务失败、详情和项目发现。
- `tests/external-registry.spec.ts`：自定义 Provider 使用不同凭据、非数字 scope 和自定义类型，验证同步引擎无需平台分支；另覆盖重复注册和旧配置迁移。
- `tests/external-http.spec.ts`：模拟 TAPD HTTP 服务经过真实注册表、适配器、host 路由和 TaskStore，验证账号匹配、类型去重、认证切换、来源关闭、失败不写入、脱敏及配置恢复。
- `tests/external-ui.spec.tsx`：切换来源/认证、动态字段/类型、发现项目、通用保存载荷、来源显示及冲突操作。
- `tests/execution.spec.ts`：两平台 × 原目录/Worktree，使用现有 ExecutionService 和模拟 Agent/Git 完成执行并进入待验收。
- Chrome 模拟页面：1000px/520px 宽度，TAPD Basic/Bearer 切换、三种类型、同步按钮、切回禅道；无页面脚本错误、窄屏无水平溢出。截图由本机临时目录保存，不进入 npm 包。

全量回归使用 `npm test -- --maxWorkers=2`。默认高并发与构建同时运行时，两项既有调度生命周期测试曾失败；单独复测及低并发全量回归均通过，未修改调度测试。

最终结果：**35 个测试文件、453 项测试通过**；类型检查、host/client 构建、host smoke（`SMOKE OK`）、npm 打包预检和 `git diff --check` 均通过。发布包包含 TAPD、注册表、通用配置模块和扩展文档。

## 边界与工作区状态

未使用真实禅道/TAPD 凭据，未运行真实模型调用，未启动或更新全局 DSH。真实企业权限、自定义工作流、OAuth Token 生命周期和部署路由仍需目标环境联调。凭据仍为 host 专用明文配置，未改为系统密钥库。当前仅一个活动连接，不包含双向回写、附件、Webhook 和多连接聚合。

本次执行期间，同一分支出现已有提交 `d9117f7`（#49 会话回退修复）；已保留，并在该当前代码基础上验证。本轮未创建提交、推送、发布或调整版本。
