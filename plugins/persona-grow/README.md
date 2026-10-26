# 人设生长（persona-grow）

在原有角色人设**之上**，让机器人从真实聊天里一点点长出属于它自己的那一层：口癖、新兴趣、不喜欢的东西、小习惯、内部梗、自我想象、慢慢成形的脾气。

和 `persona-evolution`（自主角色养成）互补而不冲突：

| | persona-evolution | persona-grow（本插件） |
|---|---|---|
| 长什么 | 8 个性格维度的数值 | 具体、能说出口的东西 |
| 回弹 | 有（受角色基准 maxDrift 限制） | 无，长出来就一直留着 |
| 触发 | after-response，攒够轮数 | 同左 |
| 注入 | 动态系统提示段 priority 34 | priority 37 |

## 怎么长

1. 每轮真实对话 `after-response` 记一笔（`rounds++`）。
2. 攒够 `evolveEvery` 轮（默认 25），后台起一次模型调用。
3. 模型翻最近 18 条对话，只能提**最多 2 条**变化，每条必须带对话证据（`evidence`）。
4. `store.js` 二次把关：类型/长度/证据校验、同名去重（转强化）、同类上限、总条数上限；成熟度 1~5。
5. 下一次组装系统提示词时，`promptSections` 同步读缓存，把条目渲染成一段追加在末尾。

失败不会影响聊天：错误只写 `lastError`，且下一轮不会立刻重试（计数已清零）。

## 文件

- `index.js` — 加载入口：`setup()` 注册工具，导出 `hooks` 与 `promptSections`。
- `store.js` — `<DATA_DIR>/persona-grow/state.json`，原子写 + `.bak`，按会话裁剪。
- `evolve.js` — 系统提示词 + 提议解析 + 有界应用。
- `prompt.js` — 同步渲染注入段（按强度筛选成熟度）。
- `llm.js` — 自己调 `chat/completions`（插件 API 没有 LLM 能力），关闭 thinking，带重试。

## 工具

- `persona-grow__status` — 查看当前会话长成什么样 + 进度（只读，不门控）。
- `persona-grow__grow_now` — 立刻长一次（写状态，群里需被 @ / 拍一拍）。
- `persona-grow__reset` — 清空当前会话的成长（同上）。

## 设置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 关闭后不记录、不演化、不注入（数据保留） |
| `evolveEvery` | 25 | 每多少轮长一次 |
| `intensity` | 6 | 0 不注入；1-3 淡；4-6 自然；7-10 鲜明 |
| `maxItems` | 18 | 总条数上限，超出按「成熟度低 + 久未强化」淘汰 |
| `allowSelfRename` | true | 允许形成自己的自称（不是改 QQ 昵称） |
| `resetAll` | false | 打开一次清空所有会话（自动关回） |

## 边界（代码兜底，不靠提示词自觉）

- 只允许 `catchphrase / interest / dislike / habit / joke / selfImage / opinion` 七类，**不含身份**。
- 每条必须有 `evidence`，没证据的提议直接丢弃。
- 身份、价值观、安全规则不在生长范围内；注入段末尾固定「事实/工具结果/安全规则优先，与原人设冲突以原人设为准」。
- 群聊里的写操作需要档位 1（被 @ 或拍一拍），私聊放行。

## 落盘位置

`F:\qq agent\data\persona-grow\state.json`

放在 `data/` 而不是 `resources/app/`，这样应用自动更新覆盖代码后，长出来的东西还在。
