# dsh-peak-balance

**中文** · [English](README.md)

DeepSeek 峰谷计费时钟 · 实时余额 · 每轮花费 · `/hist` 历史用量方格图，显示在 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 里。

```
⚡ 峰时 09:00-12:00 · 距谷时 1h23m · 余额 ¥42.10 · 本轮 ¥0.0234
```

开启峰时警告模式后，处于高峰时段时这一行会变成一个按所选颜色脉动闪烁的边框：

```
╭──────────────────────────────────────────────────────────╮
│ ⚡ 峰时 · 距谷时 1h23m · 余额 ¥42.10 · 本轮 ¥0.0234   ▂▃▄▅▆▇ │
╰──────────────────────────────────────────────────────────╯
```

输入 `/hist`（或 `/tokenhistory`；`/th` 也行但要带个空格，见下文）打开历史看板——一个占满终端的场景，形状像 GitHub 的贡献图：

```
╭─ 🐋 Token 历史  总 token  26w  子代理 计入 ────────────────────────────── ✕ ─╮
│ 更新于 12:04:11 · 341 会话 · 6,706 事件 · 9 活跃天数                          │
│ ───────────────────────────────────────────────────────────────────────────── │
│      6月      7月      8月      9月                                           │
│ Mon  ▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢                                               │
│ Wed  ▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢                                               │
│ Fri  ▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢                                               │
│                       ▲                                                       │
│ 总 token 少 ▢▢▢▢▢ 多 · 峰值 251,442,584                                       │
  ╭─ 2026-09-11 周五 ───────────────────────────────────────────────────────╮
  │ token       未命中输入 2,065,340 · 缓存读 224.3M · 输出 1.5M              │
  │ 花费        ¥18.8494                                                      │
  │ 缓存命中    99.1% · 子代理占比 12.4%                                      │
  │ 模型        deepseek-flash 227.9M · deepseek-v4-pro 3.2M                  │
  ╰───────────────────────────────────────────────────────────────────────────╯
│ 总计        1,079,834,040 · 总花费(估) ¥64.6867 · 缓存命中 99.0%              │
│ 子代理      36/341 会话 · 945 事件 · 峰值日 2026-09-11                        │
│ ───────────────────────────────────────────────────────────────────────────── │
│ 模型                             总 token    花费(估)   命中率 费率来源       │
│ ───────────────────────────────────────────────────────────────────────────── │
│ deepseek-flash                     587.3M      ¥33.94    99.3% 内置价目       │
│ deepseek-v4-flash-vision-exp       412.6M      ¥24.53    98.8% 内置价目       │
│ deepseek-v4.1-flash-expires…        68.2M           —    98.5%     未知       │
│ deepseek-v4-pro                      8.0M       ¥4.28    95.4% 内置价目       │
│ deepseek-v4-flash                  457.2k     ¥0.0975    90.1% 内置价目       │
│ ←/→ 前后周 · ↑/↓ 前后天 · t 今天 · m 指标 · w 跨度 · s 子代理 · r 刷新 · q/Esc │
╰───────────────────────────────────────────────────────────────────────────────╯
```

## 功能

| 功能 | 说明 |
| --- | --- |
| 峰谷时钟 | 显示当前计价时段与切换到下一时段的倒计时（北京时间周一至周五 `09:00-12:00`、`14:00-18:00` 为高峰，周末全天谷时）。 |
| 实时余额 | DeepSeek 账户余额，**每轮对话结束后自动刷新**，另有每分钟一次的后台刷新。 |
| 每轮花费 | 刚结束那一轮对话的估算花费（人民币）；高峰与谷时的用量按各自请求发生的时刻分别计价。数字跟着你**当前聚焦的对话**走，而不是「最后一个往里写事件的对话」。 |
| 峰时警告 | 可选。高峰时段生效时，状态行变成圆角边框，边框、时段标签与右侧波形按设定颜色脉动。 |
| 历史方格图 `/hist` | 全屏场景：一天一格、按当天用量深浅着色，鼠标悬停出当日明细；键盘按**方格**挪动（`←/→` 前后一周、`↑/↓` 前后一天、`t` 回到今天），另有 `m` 指标、`w` 跨度、`s` 子代理、`r` 刷新、`q`/`Esc` 返回。 |
| 总计与模型维度 | 总计：总 token、总花费（估）、缓存命中率、活跃天数、会话数、子代理占比、峰值日；模型表：每个模型的总用量、总花费、总缓存命中率与费率来源。 |
| 自定义费率 `/hist price` | 内置价目表没收录的模型由你自己补单价；未设置前只显示 token 并标注「费率未知」，绝不猜金额。 |
| 跟随界面语言 | 与 dsh-tui 的 `/lang` **即时联动**：状态行、历史场景、命令回执都跟着切（宿主把选择写进 `dsh-tui` 设置命名空间，插件监听 `settings/updated` 事件；没挂该命名空间的宿主由 1 秒轮询 `~/.dsh-tui/lang.json` 兜底）。设置卡片与命令补全描述本来就中英双语。 |
| 设置子页 | `/settings` 的 **Peak & Balance（峰谷与余额）** 卡片新增 **Token history（历史用量）** 子页，共 10 个选项（含场景版式与色阶）。 |

## 安装

```sh
# 从 npm 安装
dsh plugin --profile dsh-tui add dsh-peak-balance

# 或直接从本仓库的本地目录安装（pnpm 会把目录打包复制进 profile）
dsh plugin --profile dsh-tui add file:/到本仓库的绝对路径/dsh-peak-balance
```

该命令会把 bundle 行追加进 profile 的 `dsh.profile.bundles`。之后在 dsh-tui 内执行 `/restart` 让 profile 载入新行；重启后 `/settings` 即可看到设置卡片。

> 不建议用符号链接（`link:` 或目录联接）方式安装：Node 会按插件的真实路径解析依赖，`@deepseek-ai/*` 必须能从该路径向上找到。`file:` 与 npm 安装都会在 profile 内留下真实目录，这正是宿主期望的布局。
>
> 更新本地 `file:` 安装：pnpm 会缓存本地目录依赖，只跑 `add`/`update` **不会**拾取改过的源码。请先升版本号，再卸载重装以刷新 profile 内的副本：
>
> ```sh
> dsh plugin --profile dsh-tui remove dsh-peak-balance
> dsh plugin --profile dsh-tui add file:/到本仓库的绝对路径/dsh-peak-balance
> ```

## 设置项（四项 + 历史用量子页十项）

主卡片：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| Show balance / 显示余额 | boolean | `true` | 状态行是否显示账户余额。 |
| Show per-turn cost / 显示每轮花费 | boolean | `true` | 是否显示上一轮对话的估算花费。 |
| Peak-hour warning / 峰时警告模式 | boolean | `false` | 高峰时段是否把状态行变成闪烁边框。 |
| Warning color / 警告色系 | select | `red` | 边框颜色：红 `red`、橙 `orange`、黄 `yellow`、绿 `green`、青 `cyan`、蓝 `blue`、紫 `purple`。 |

**Token history（历史用量）** 子页：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| Grid metric / 方格图口径 | select | `tokens` | 方格深浅表示什么：`tokens` 总 token、`cost` 花费、`output` 输出 token、`cacheMiss` 缓存未命中输入。 |
| Time span / 时间跨度 | select | `26` | 方格图显示多少周：`13` / `26` / `53`。 |
| Count subagents / 计入子代理 | boolean | `true` | 子代理会话也真实消耗 token；关掉后只统计你自己跑的对话，总计行会写明排除了多少。 |
| Week starts on / 每周起始日 | select | `mon` | 方格图第一行是 `mon` 周一还是 `sun` 周日。 |
| Grid palette / 方格色阶 | select | `github` | `github` GitHub 绿、`blue` 蓝色系、`theme` 跟随当前主题强调色。 |
| Scene layout / 场景版式 | select | `card` | `card` 圆角边框卡片 + 分区辅助线；`plain` 无边框（省 2 行 4 列）。终端太小时 `card` 自动退化为 `plain`。 |
| Hover: tokens / 悬停：token 分项 | boolean | `true` | 当日明细是否显示 未命中输入 / 缓存读 / 输出 分项。 |
| Hover: cost / 悬停：花费 | boolean | `true` | 是否显示当天估算花费。 |
| Hover: cache hit rate / 悬停：缓存命中率 | boolean | `true` | 是否显示当天缓存命中率。 |
| Hover: models / 悬停：模型明细 | boolean | `true` | 是否显示当天用了哪些模型。 |

设置写入 `dsh-peak-balance` 命名空间，改完立即生效，无需重启。**场景内的 `m` / `w` / `s` 就是改设置**（会写回 `dsh/settings.yaml` 并立即生效，重开 TUI 仍然有效）：按下去先本地翻转，写入失败时只保留本次会话内的改动并记一条日志。

## `/hist` 历史用量与花费

```sh
/hist                                 # 打开方格图（推荐，不会与内置命令冲突）
/tokenhistory                         # 同上（长别名）
alt+h                                 # 同上（不用打字；聊天状态下生效）
/th                                   # 也行，但要打「/th 」带一个空格，见下
/hist price                           # 列出已自定义的费率 + 费率未知的模型
/hist price set <model> <hit> <miss> <out> [peakHit peakMiss peakOut]
/hist price rm <model>
/hist price clear
```

### 为什么 `/th` 单独回车会去切主题

这是**宿主行为，插件改不了**，如实说明：dsh-tui 的输入框在斜杠补全菜单打开时，回车执行的是**当前高亮的那条建议**，不是你打的那行字（`PromptInput.js` 的 `handleEnter`）；而补全列表是「内置命令在前、插件命令追加在后」，且打字时选中项固定回到第 0 条。打 `/th` 时匹配到 `theme`、`thinking` 和我们的 `th`，高亮落在 `theme` → 回车就切了配色。

可用的四条路：

| 入口 | 说明 |
| --- | --- |
| `/hist` | **推荐**。`hist` 不是任何内置命令的前缀，打 `/hist` 时菜单里只有它自己，回车直接执行。 |
| `/tokenhistory` | 同样不冲突。 |
| `alt+h` | 聊天状态下直接打开场景，不用打字。 |
| `/th ` + 回车 | `/th` 后面跟一个**空格**：菜单会因为「已经是子命令位置」而关闭，回车就走 `th` 命令。 |

> 注意：如果将来装了名字以 `hist` 开头的**技能**（skill），它也会以同样的方式抢 `/hist` 的回车——那是同一套宿主补全逻辑，届时换个名字即可（代码里是一个常量）。

### 键盘

| 按键 | 作用 |
| --- | --- |
| `←` / `→` | 挪到**左边/右边那一格**（同一星期几，前后一周） |
| `↑` / `↓` | 挪到**上边/下边那一格**（同一列，前后一天） |
| `t` | 回到今天 |
| `m` / `w` / `s` | 切换 指标 / 跨度 / 子代理（会闪烁对应徽章并写回设置） |
| `r` | 重新扫描 |
| `q` / `Esc` | 返回对话 |

到方格图边界或「未来」的格子会**停住**（不绕回）。上下左右都是纯几何挪动，不再按「天/周」两个维度跳。选中格会被提亮，并在方格图下方用 `▲` 指出所在列。

**子代理开关的反馈**：场景标题栏有常驻徽章（`子代理 计入` / `子代理 不计入`，计入时是绿色），按下 `s` 会反色闪烁 1.2 秒；关掉时总计行还会写明「已排除 N 会话 / M 次上报」，而不是只让数字变小。

**数据来源是本机会话日志**（`$DSH_HOME/sessions/`）。日志里每一个 `assistant/message` 事件都带着 DeepSeek 为该次请求返回的用量（`inputTokens` / `cacheReadTokens` / `outputTokens` / `cacheWriteTokens`），插件按**事件自身的时间戳**落到北京时间的自然日与高峰/空闲档，再按模型归档。因此：

- **token 是官方上报的真实数字**，不是本地估算；
- **金额是估算**（官方 API 只返回 token，不返回钱），用内置价目或你自定义的单价换算，并明确标注；
- 只覆盖**本机 dsh 的用量**，其他客户端或网页版的调用不在其中；
- 覆盖范围随本机日志保留策略而定（本机现有日志从 2026-09-04 起）。

**子代理**默认计入（它们花的是真钱），表里可分辨，也可以关掉。

**未收录模型**（内置价目表没有的）只显示 token，金额显示「—」，等你在 `/hist price set` 里给定单价后才参与计价。自定义费率立即写入 `~/.dsh-tui/dsh-peak-balance-rates.json`，并同时影响历史看板与状态行的每轮花费。`<hit> <miss> <out>` 是**空闲时段**的三个单价（元/百万 tokens），高峰时段默认按官方规则取两倍；要给高峰单独定价时再补三个数字。

**准确性的两个实现细节**（都能在真实日志上复现）：

1. 会话日志是**多帧 zstd**（每次追加一个独立帧）。`zlib.zstdDecompressSync` 只解第一帧，而"扫魔数切帧"会在压缩块内部偶然命中魔数——此时截断解码仍会「成功」并返回残缺内容，静默丢事件。本插件改为解析 zstd 帧头与块头**精确计算帧长**；在本机 341 份日志上，旧写法丢了 282 个事件，新写法全部取回。
2. fork / rewind 出来的会话日志会**物理携带父会话的事件前缀**。插件按日志头的 `seedLength` 截断（首个 `session/end-seed` 事件即落在此处），否则会把父会话的用量重复计一遍——本机 9 份 seeded 日志里是 292 条用量事件（约 4.5%）。

**缓存**：首次全量扫描约 4~5 秒（本机 341 份日志 / 约 80 MB），期间场景里显示「扫描中 x/y」；之后按 `(路径, 大小, mtime)` 增量，通常 20~30 ms。缓存写在 `~/.dsh-tui/dsh-peak-balance-history.json`（可安全删除，删了会自动重建）。场景打开期间每 60 秒增量刷新一次，关掉即停。

## 数字是怎么来的

**时段**：空闲时段价格为高峰时段的一半；高峰为北京时间（UTC+8）周一至周五 `09:00-12:00`、`14:00-18:00`，其余时间（含周六日全天）为空闲时段。

**花费**：DeepSeek API 只返回 token 用量、不返回金额，因此每轮花费是**估算**：

```
费用 = 未命中输入 token × 未命中单价 + 缓存命中 token × 命中单价 + 输出 token × 输出单价
```

三项输入侧数字是**并列不重叠**的：`inputTokens` 是未命中缓存的提示词，`cacheReadTokens` 是命中缓存的部分，服务商返回的 `totalTokens` 正是二者相加再加输出。若把命中量当成输入的**子集**去相减（旧写法），会把带缓存的轮次价格算低数倍 —— 2026-09-10 用真实余额扣减核对：实际扣 ¥0.20 的一轮，旧写法估 ¥0.03，上式估 ¥0.23。

每条用量按其请求发生的时刻落入高峰或空闲桶，跨时段的一轮不会被整体按当前时段计价。内置价目（元/百万 tokens）核对日期 **2026-09-10**，来源为官方[模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)页：`deepseek-flash` 空闲 0.02 / 1 / 4，高峰 0.04 / 2 / 8；`deepseek-v4-pro` 空闲 0.15 / 4.5 / 13.5，高峰 0.30 / 9 / 27。旧模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 按 Flash 价计费；`deepseek-v4-pro` 自北京时间 2026-09-14 12:00 起路由到 V4.1-Flash，按 Flash 价计费。价目表未收录的模型显示「费率未知」，只显示 token 而不给错误金额。

**余额**：`GET https://api.deepseek.com/user/balance`（与 dsh-tui 内置 `/balance` 同一只读接口）。密钥经 `credentials` 接缝读取 `DEEPSEEK_API_KEY`（可回退环境变量），仅放入请求头，不写日志、不落盘。

## 兼容性

| 项 | 值 |
| --- | --- |
| 宿主 | `@deepseek-harness-tui/dsh-tui` 0.10.x（`ctx.tuiStatus.registerView`、`ctx.tuiSettingsSections.register`、`ctx.tuiScenes.register/open`、`ctx.commands.register`、`ctx.tuiCommandTrees.register`、`ctx.tuiShortcuts.register`） |
| Harness | `@deepseek-ai/dsh` 0.1.2-rc.1+（`session/event`、`settings`、`credentials`） |
| 运行时 | Node `^22.19 \|\| >=24`，纯 ESM，无原生依赖（多帧 zstd 用内建 `node:zlib`） |
| Manifest | `manifestVersion` 0.15 · id `com.dsh-tui-ecosystem.dsh-peak-balance` · 契约 `tui.dsh/v1alpha1#DecisionEvents`（optional）+ `commands.dsh/v1alpha1#Command`（required）· 三条命令贡献（`/hist`、`/th`、`/tokenhistory`） |
| 平台 | dsh-tui 能跑的平台（Windows / macOS / Linux） |

所有宿主接缝都是软探测（`ctx.get(name, false)`）：缺少 TUI 扩展服务、缺少 credentials 服务或没有网络时，插件保持静默而不是让宿主失败；注册会在 profile 组合期间重试 30 秒，所有定时器都由 activation 的 effect 清理。

命令注册走**中介面优先**：`ctx.tuiPluginHost.registerCommand`（带已校验的组件身份与调用检查点）→ 拒绝时回退到 `ctx.commands.register`（生态文档里的 C-070 边界）。以普通 profile 行加载的第三方插件没有 verified identity，所以实际生效的是回退路径；两条路径都失败时只记一条日志，插件其余部分照常工作。

`alt+h` 走 `ctx.tuiShortcuts.register`（`ctrl`/`alt` 必需、保留组合会被宿主拒绝并返回 no-op）：宿主只接受非保留组合，`alt+h` 未被 `alt+v`/`alt+up` 等内置键占用。

**语言**：插件按宿主正在显示的语言渲染，解析顺序与 dsh-tui 一致 —— `DSH_TUI_LANG` → 运行时 `dsh-tui.lang` 设置 → `~/.dsh-tui/lang.json` → 系统 locale（locale 缺失时沿用历史默认 `zh`；存在但不支持的语言一律回落到 `en`，与 dsh-tui 相同）。`/lang` 切换通过设置服务的 `settings/updated(ns, next, prev, source)` 事件**即时**重绘状态行与已打开的历史场景；宿主没有提供该命名空间时，退化为每秒轮询持久化文件（用 mtime/size 指纹判断，没变就只做一次 `stat`）。`DSH_PEAK_BALANCE_LANG_FILE` 可覆盖该文件路径，供测试与诊断使用。

## 已知限制

- **输入框边框本身无法由插件改色**：dsh-tui 0.10 的输入框边框由其内部 `EffortInputBorder` 组件独占渲染，没有对插件开放的接缝。因此警告边框是渲染在对话栏正上方的状态贡献——这是不改宿主源码能做到的最接近效果。
- 花费为基于 token 用量的估算，实际扣费以 DeepSeek 平台账单为准。
- 价目表内置在包内，官方调价需要插件更新；未收录的模型需要你自己用 `/hist price set` 补单价。
- 余额接口需要 DeepSeek 官方 API key；其他 provider 会直接不显示余额。
- 富状态视图与其他插件共享 6 行预算，本插件占用 3 行，且仅在警告边框显示时占用。
- 状态行显示的是**宿主当前聚焦的那个对话**：切换对话后它跟着切。已结算的轮次按**对话**记录（不是按会话对象），所以切走再切回来仍然能看到那个对话自己的上一轮花费；只有该对话在本进程内确实还没有已结算的轮次时才显示 `本轮 —`（新开的 `/new` 会话就是这种情况），而不是拿别的对话的数字顶上。子代理（subagent）会话被有意忽略，不会把子会话花费算进你的「本轮」。
- **历史只覆盖本机 dsh 的用量**：日志里没有的调用（网页版、其他客户端、其他机器）不会出现在方格图里。历史起点取决于本机日志文件，现有日志从 2026-09-04 开始。
- **`/th` 单独回车会被宿主的补全菜单抢去切主题**（见上文「命令名与回车行为」）：这是宿主逻辑，插件无法把命令排到补全列表前面；用 `/hist`、`/tokenhistory`、`alt+h` 或 `/th ` 带空格都可以。同理，若日后某个技能名以 `hist` 开头，也会以同样方式抢走 `/hist` 的回车。
- **首次打开需要几秒**（全量扫描会话日志；本机 341 份 / 80 MB 约 4~5 秒），期间显示扫描进度；之后走增量缓存，通常 20~30 ms。
- **鼠标悬停依赖全屏（alternate screen）**：profile 的 `fullscreen: true` 下可用；inline 模式下请用键盘（`←/→/↑/↓`）选中日期，明细卡同样会显示。
- 方格图的深浅按当前可见区间内非零日期的四分位分级，因此数据增长后同一数值的颜色档位可能变化（与 GitHub 一致）；图例里始终标着当前区间的最大值。
- **终端不够宽时裁周而不是缩格**：宽度放不下完整跨度时只显示最近的若干周，标题栏徽章会写「显示 27/53 周」；`←/→` 挪到边缘时窗口跟着滚一格，选中格不会被藏掉。高度不足时按此优先级逐级降级：模型表 → 明细卡的字段（先砍模型行，再砍命中率/花费/token）→ 总计行；`<12` 行或 `<40` 列时改用兜底视图（最近若干天一行一条 + 一行总计），保证不溢出。

## 开发与验证

```sh
pnpm install --frozen-lockfile
pnpm check:encoding      # 无 UTF-8 BOM / 编码损坏（dsh 崩溃的经典元凶）
pnpm validate:manifest   # 准入形状 + 版本一致性
pnpm test                # node:test 单元测试 + 宿主桩集成测试
pnpm pack:verify         # 入口引用到的模块是否都在 files 内
pnpm verify              # 以上四项依次执行
```

宿主集成探测（无头启动一个一次性 profile，验证宿主是否**接受**注册——单测看不见这一层）：

```sh
node ../../tools/probe-plugin.mjs . --wait 15
```

探测 profile 现在会一并挂载 `scenes` / `plugin-host` / `command-trees` / `extensions`（含 `tuiShortcuts`）四行，因此场景、三条命令与 `alt+h` 快捷键的注册都会被验证；期望输出里能看到 `history scene registered`、三行 `command registered`、`command tree registered roots=3` 与 `shortcut registered alt+h`，退出码 0。

### 校验历史数字（真值校验）

聚合逻辑是纯函数、可单测（`test/history.test.js`），但**数据本身**要看真实日志。想在同机复核：

1. 删除缓存 `~/.dsh-tui/dsh-peak-balance-history.json`，让下一次 `/th` 全量重扫；
2. 用一个**独立实现**（不 import 本包的模块）按同一份字节折叠一遍，比较逐日/逐模型数字；
3. 对比时注意会话日志是**活文件**：一边跑一边写会让总数持续增长，两次快照不可能相等，只有工具与插件对**同一批字节**的一致才有意义。

本仓库开发时用这种方式核对过：341 份日志、116 个 `(模型, 日期, 峰/谷)` 桶，两份实现 **0 处不一致**；同时验证了 0 个重复 seq、0 个乱序 seq、0 行非法 JSON。

### 预览峰时警告效果

警告边框只在真实高峰时段（周一至周五 `09:00-12:00` / `14:00-18:00` 北京时间）出现。想在任意时间预览：

```sh
DSH_PEAK_BALANCE_FORCE_PEAK=1 dsh --profile dsh-tui   # PowerShell: $env:DSH_PEAK_BALANCE_FORCE_PEAK=1
```

该开关只改变呈现方式（倒计时仍按真实时钟显示），不设置该变量时完全不生效。

### 诊断日志

插件在 `~/.dsh-tui/dsh-peak-balance.log` 保留一份有上限的生命周期日志：模块被导入一行、`apply()` 开始一行（含 pid 与实际加载的文件路径）、解析出的配置、可挂载的宿主接缝探测结果、每次注册的结果，以及卸载。有了它就能区分「宿主压根没加载这个文件」和「某个接缝拒绝了注册」，不必给运行中的 TUI 挂调试器。文件超过 128 KiB 时自动裁剪保留最新一半；`DSH_TUI_DEBUG=1` 会追加每次刷新的细节。跑测试时不会写入该文件。

聚焦对话来自两条独立信号，按优先级：

1. 宿主托管的 `tui/session-switched` 决策事件通知——宿主挂载了 plugin-interop 行时可用（日志里 `host=1`）。manifest 把该契约声明为 **optional** 并写清兜底方案，缺少它的宿主只会降级，不会被拒绝准入。
2. 宿主每次切换都会重写的启动器标记 `~/.dsh-tui/resume.txt`，每秒读一次。宿主开始新对话（`/new`）时会把这个标记**清空**——这是「有信息」而不是「读不到」：状态行会放掉原来那个数字，改由第一个"不是刚离开的那个对话"来接手。只有**压根读不到**标记时，才回退到「最后一次会话事件」。

`DSH_PEAK_BALANCE_FOCUS_FILE` 可覆盖该标记路径，供测试与诊断使用——测试运行因此永远不会去读真实标记。

## 发布与版本

仓库 `VviLliAm-qwq/dsh-peak-balance`，MIT 许可。版本遵循 SemVer；npm 的 `version` 与 manifest 的 `version` 始终保持一致，打一个与该版本同号的 `v*` tag 即触发发布工作流。

## 收录

本插件收录在 dsh-tui 插件市场。市场只做链接罗列，**不做代码审查、不代表背书**。

## 给插件作者的坑（本插件踩过的）

- **Cordis 插件入口只能导出 `name`、`Config`、`apply` 三个符号。** 若在同一个模块里额外导出工具函数，宿主对 activation 的包装方式会改变，随后所有 `tuiStatus` / `tuiSettingsSections` 注册都会被拒（`requires a live Cordis activation context`）。这个故障是「半死」的：设置**命名空间**仍会注册成功，于是插件看起来活着，但设置卡片和状态行永远不出现。请把实现放在同目录的另一个模块，入口只做再导出。
- **可选宿主服务要「严格优先」获取**（`ctx.get(name)`）；非严格的 `ctx.get(name, false)` 可能返回影子占位实例，宿主会拒绝其方法调用。非严格形式只作兜底，并且要持续重试 —— 第一拍时接缝行可能仍在激活中。
- **中介式命令注册需要「已校验的组件身份」，普通 profile 行拿不到。** `ctx.tuiPluginHost.registerCommand` 会先 `requireComponentIdentity`，以 `file:` 装进 profile 的第三方插件不是通过宿主的 admission 通道加载的，于是它会抛 `the calling activation has no verified dsh-plugin.json Component identity`。manifest 里照样要如实声明 `commands.dsh/v1alpha1#Command` 与该命令的 contribution id（将来被 admission 接管时才有意义），但代码必须准备好回退到 `ctx.commands.register`，否则命令会静默消失。
- **状态行与全屏场景是两种不同的接缝。** `tuiStatus.registerView` 的富视图**上限 3 行**且拿不到滚轮/键盘；要画多行界面（例如方格图）必须用 `ctx.tuiScenes.register` + `open`，它给的是完整 `ui` 套件（Box/Text/useInput/useTerminalSize/useTheme）和 `close()`。
- **场景里 hooks 必须无条件、按固定顺序调用。** 看起来无害的「`ui.useTheme` 不存在就跳过」会改变 hook 顺序，真实 React 会当场抛 invalid-hook-call。本插件的写法是先取出 `useInput`/`useTerminalSize`/`useTheme`（缺失时给一个返回默认值的桩），再无条件调用。
- **命令名不要是内置命令的前缀。** 宿主的斜杠补全菜单在打开时接管回车，执行的是高亮项，且内置命令排在插件命令之前 —— 名字撞前缀（`/th` vs `theme`/`thinking`）就意味着单独回车永远轮不到你。要么换个不冲突的名字（`/hist`），要么另给一个快捷键（`ctx.tuiShortcuts`，需要 ctrl/alt 且避开保留组合）。
- **全屏场景要自己预算行高。** alternate screen 里溢出不是「被裁剪」而是把整帧推走；每个区块都该先问「还剩几行」，再决定画不画。宽度同理：先算能放几列，再去裁内容，而不是指望宿主截断。

本插件把排查过程写进 `~/.dsh-tui/dsh-peak-balance.log`，上面几条就是这样查出来的（见上文「诊断日志」）。

## 许可

MIT — 见 [LICENSE](LICENSE)。
