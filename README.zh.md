# dsh-peak-balance

DeepSeek 峰谷计费时钟 · 实时余额 · 每轮花费，显示在 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 的对话栏上方。

```
⚡ 峰时 09:00-12:00 · 距谷时 1h23m · 余额 ¥42.10 · 本轮 ¥0.0234
```

开启峰时警告模式后，处于高峰时段时这一行会变成一个按所选颜色脉动闪烁的边框：

```
╭──────────────────────────────────────────────────────────╮
│ ⚡ 峰时 · 距谷时 1h23m · 余额 ¥42.10 · 本轮 ¥0.0234   ▂▃▄▅▆▇ │
╰──────────────────────────────────────────────────────────╯
```

## 功能

| 功能 | 说明 |
| --- | --- |
| 峰谷时钟 | 显示当前计价时段与切换到下一时段的倒计时（北京时间周一至周五 `09:00-12:00`、`14:00-18:00` 为高峰，周末全天谷时）。 |
| 实时余额 | DeepSeek 账户余额，**每轮对话结束后自动刷新**，另有每分钟一次的后台刷新。 |
| 每轮花费 | 刚结束那一轮对话的估算花费（人民币）；高峰与谷时的用量按各自请求发生的时刻分别计价。 |
| 峰时警告 | 可选。高峰时段生效时，状态行变成圆角边框，边框、时段标签与右侧波形按设定颜色脉动。 |
| 设置大类 | `/settings` 页面新增 **Peak & Balance（峰谷与余额）** 卡片，四个开关直接显示在卡片上，无需进入子页面。 |

## 安装

```sh
# 从 npm 安装
dsh plugin --profile dsh-tui add dsh-peak-balance

# 或直接从本仓库的本地目录安装（pnpm 会把目录打包复制进 profile）
dsh plugin --profile dsh-tui add file:/到本仓库的绝对路径/dsh-peak-balance
```

该命令会把 bundle 行追加进 profile 的 `dsh.profile.bundles`。之后在 dsh-tui 内执行 `/restart` 让 profile 载入新行；重启后 `/settings` 即可看到设置卡片。

> 不建议用符号链接（`link:` 或目录联接）方式安装：Node 会按插件的真实路径解析依赖，`@deepseek-ai/*` 必须能从该路径向上找到。`file:` 与 npm 安装都会在 profile 内留下真实目录，这正是宿主期望的布局。

## 设置项（四项）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| Show balance / 显示余额 | boolean | `true` | 状态行是否显示账户余额。 |
| Show per-turn cost / 显示每轮花费 | boolean | `true` | 是否显示上一轮对话的估算花费。 |
| Peak-hour warning / 峰时警告模式 | boolean | `false` | 高峰时段是否把状态行变成闪烁边框。 |
| Warning color / 警告色系 | select | `red` | 边框颜色：红 `red`、橙 `orange`、黄 `yellow`、绿 `green`、青 `cyan`、蓝 `blue`、紫 `purple`。 |

设置写入 `dsh-peak-balance` 命名空间，改完立即生效，无需重启。

## 数字是怎么来的

**时段**：空闲时段价格为高峰时段的一半；高峰为北京时间（UTC+8）周一至周五 `09:00-12:00`、`14:00-18:00`，其余时间（含周六日全天）为空闲时段。

**花费**：DeepSeek API 只返回 token 用量、不返回金额，因此每轮花费是**估算**：

```
费用 = (输入 − 缓存命中) × 未命中单价 + 缓存命中 × 命中单价 + 输出 × 输出单价
```

每条用量按其请求发生的时刻落入高峰或空闲桶，跨时段的一轮不会被整体按当前时段计价。内置价目（元/百万 tokens）核对日期 **2026-09-10**，来源为官方[模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)页：`deepseek-flash` 空闲 0.02 / 1 / 4，高峰 0.04 / 2 / 8；`deepseek-v4-pro` 空闲 0.15 / 4.5 / 13.5，高峰 0.30 / 9 / 27。旧模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 按 Flash 价计费；`deepseek-v4-pro` 自北京时间 2026-09-14 12:00 起路由到 V4.1-Flash，按 Flash 价计费。价目表未收录的模型显示「费率未知」，只显示 token 而不给错误金额。

**余额**：`GET https://api.deepseek.com/user/balance`（与 dsh-tui 内置 `/balance` 同一只读接口）。密钥经 `credentials` 接缝读取 `DEEPSEEK_API_KEY`（可回退环境变量），仅放入请求头，不写日志、不落盘。

## 兼容性

| 项 | 值 |
| --- | --- |
| 宿主 | `@deepseek-harness-tui/dsh-tui` 0.10.x（`ctx.tuiStatus.registerView`、`ctx.tuiSettingsSections.register`） |
| Harness | `@deepseek-ai/dsh` 0.1.2-rc.1+（`session/event`、`settings`、`credentials`） |
| 运行时 | Node `^22.19 \|\| >=24`，纯 ESM，无原生依赖 |
| Manifest | `manifestVersion` 0.15 · id `com.dsh-tui-ecosystem.dsh-peak-balance` |
| 平台 | dsh-tui 能跑的平台（Windows / macOS / Linux） |

所有宿主接缝都是软探测（`ctx.get(name, false)`）：缺少 TUI 扩展服务、缺少 credentials 服务或没有网络时，插件保持静默而不是让宿主失败；注册会在 profile 组合期间重试 30 秒，所有定时器都由 activation 的 effect 清理。

## 已知限制

- **输入框边框本身无法由插件改色**：dsh-tui 0.10 的输入框边框由其内部 `EffortInputBorder` 组件独占渲染，没有对插件开放的接缝。因此警告边框是渲染在对话栏正上方的状态贡献——这是不改宿主源码能做到的最接近效果。
- 花费为基于 token 用量的估算，实际扣费以 DeepSeek 平台账单为准。
- 价目表内置在包内，官方调价需要插件更新。
- 余额接口需要 DeepSeek 官方 API key；其他 provider 会直接不显示余额。
- 富状态视图与其他插件共享 6 行预算，本插件占用 3 行，且仅在警告边框显示时占用。
- 只显示最近活跃会话；子代理（subagent）会话被有意忽略，不会把子会话花费算进你的「本轮」。

## 开发与验证

```sh
pnpm install --frozen-lockfile
pnpm check:encoding      # 无 UTF-8 BOM / 编码损坏（dsh 崩溃的经典元凶）
pnpm validate:manifest   # 准入形状 + 版本一致性
pnpm test                # node:test 单元测试 + 宿主桩集成测试
pnpm pack:verify         # 入口引用到的模块是否都在 files 内
pnpm verify              # 以上四项依次执行
```

## 许可

MIT — 见 [LICENSE](LICENSE)。
