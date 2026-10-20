# DSH XD Pool

<p align="center">
  <a href="https://github.com/dawanglaohu/dsh-xdpool"><img src="https://img.shields.io/badge/install%20source-GitHub-181717?style=flat-square&logo=github" alt="install source"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/dawanglaohu/dsh-xdpool?style=flat-square" alt="MIT license"></a>
  <a href="https://github.com/dawanglaohu/dsh-xdpool/stargazers"><img src="https://img.shields.io/github/stars/dawanglaohu/dsh-xdpool?style=flat-square" alt="GitHub stars"></a>
  <a href="https://www.npmjs.com/package/dsh-xdpool"><img src="https://img.shields.io/npm/v/dsh-xdpool?style=flat-square&label=npm%20%28upstream%29&color=cb3837" alt="upstream npm version"></a>
  <a href="https://www.npmjs.com/package/dsh-workbuddy-xdpool"><img src="https://img.shields.io/badge/downloads-9k%2F%E6%9C%88%20%28%E6%97%A7%E5%90%8D%29-cb3837?style=flat-square" alt="npm downloads under the previous name"></a>
</p>

<p align="center">
  <sub>安装源是本仓库 <code>github:dawanglaohu/dsh-xdpool</code>；npm 上的 <code>dsh-xdpool</code> 归上游维护者，只发上游代码，不含本仓库的修复。下载量统计沿用旧包名 <code>dsh-workbuddy-xdpool</code>（截至 2026-10-12 为 8,976 次/月，改名前的全部下载；shields 的实时徽章常被 npm 上游限流，所以这里用了快照数字）。</sub>
</p>

[English](./README.en.md) | 中文

**把你手上所有能白嫖的模型额度，接进 DSH 的同一个模型池。**

它从一件事开始——把本机 WorkBuddy 桌面 App 里登录过的**所有账号**合成一个自动容错的池子，哪个号被限流了、积分用光了，请求自动换到下一个能用的号上去。你不用挑号，不用手动导入。

然后它长成了七页：账号池之外，还能扫码登录十三家厂商的免费模型、把 **76 家**厂商的免费额度聚合成一条通道、看用量账本、把几个模型串成链、把池子开成一个本地 OpenAI 兼容网关。

| 页面 | 干什么 |
| --- | --- |
| **账号池** | 本机 WorkBuddy 账号、池健康、实时用量、积分自动化 |
| **扫码登录** | 十三家支持网页 / 扫码登录的厂商，登一次，它们的免费模型就进选择器 |
| **聚合渠道** | 76 家厂商的免费额度接进同一个池（默认一家都不开，填了 key 才亮） |
| **数据看板** | 今天的轮次、调用、失败、换号救回、token、缓存命中、速度 |
| **billion-context** | 只读观测本机 billion-context 压缩器的运行状态 |
| **路由** | 把多个模型串成一条链，按顺序或轮换使用 |
| **网关** | 把池子开成本地 OpenAI 兼容接口，可转发给局域网其它设备 |

**另外附送一整套「积分自动化」**：签到、领任务奖励、连登兑换、开猫猫旅行……这些每天都要手动点一遍的活儿，插件在后台替你干完了。

> **和单账号连接插件的区别**：`dsh-workbuddy-connect` 那类插件是「一次一个账号」。XD Pool 把**多账号当默认情况**——不挑号、不手动导入，你在桌面 App 换登过的每个号都被池记下并跨重启保存，对外用一个 `xdpool` provider 分组，池内自动容错。

> **从旧名升级**：这个插件以前叫 `dsh-workbuddy-xdpool`。改名后**旧数据会自动接过来**（你的 API key、忽略名单、账号 pin 都还在）；唯一需要你动手的是「默认模型」如果指向旧 id，见[从旧版升级](#从旧版升级)。


## 先看几张图

**账号池（卡片首页：品牌栏 + 七个页面标签，顶部就是用量）**

![账号池：顶栏显示 XD Pool 与版本号、七个页面标签、用量面板在页面最上方、下方是 WorkBuddy 国内版账号卡与「已接入」状态](assets/account-pool.png)

**扫码登录（十三家支持网页或扫码登录的厂商，登一次就能用它们的免费模型）**

![扫码登录：十三家厂商列表，CodeArts 华为云、WorkBuddy 国内版与国际版各带说明与登录按钮](assets/login-channels.png)

**聚合渠道（把各家的免费额度接进同一个模型池，76 家厂商按分类筛选）**

![聚合渠道：聚合开关、搜索框、全部分类 76 / API Key 60 / 免费 1 / 有免费额度 10 / 本地 3 / 需授权 2 的分类筛选](assets/aggregate-channels.png)

**账号积分详情（池中账号：积分包、连签天数、今日已签、保留积分）**

![账号积分详情：当前使用的账号展开后显示合计积分、连签 16 天、每日 +100 积分、今日已签按钮、CodeBuddy 积分包余额与到期时间，以及保留积分输入框](assets/account-credits.png)

**积分自动化面板**

![积分自动化：总开关、立即运行按钮、每个任务的上次执行时间与当轮具体领取到的任务清单、连登解锁倒计时](assets/automation-panel.png)

**模型选择器（国内版 / 国际版 两个独立分组）**

![模型选择器：国内版与国际版各占一个分组，每个模型名后显示积分倍率与促销标签](assets/model-picker.png)

**国内版 / 国际版 双供应商（各自独立账号、积分与模型，可同时使用）**

![切换国内版与国际版：未登录的一侧给出该区域的登录步骤](assets/region-tabs.png)

## 功能

### 一、多账号池

- **零配置**：装上、打开，就完事了。WorkBuddy 桌面 App 里每个登过的账号都会被自动发现、持久保存并入池（重启不丢），不需要在插件里录任何东西。

- **自动容错换号**：池子记着每个账号的限流状态。某个号触发 429 就冷却它，后面的请求自动落到下一个健康的号上；冷却结束自动恢复。所有号都在冷却时，请求才排队等待。
- **四种账号分配方式**：`priority` 先用完一个号；`round-robin` 按顺序轮换；`balanced` 随机抽、偏向闲置久的；`sticky` 让**一个对话只用一个账号，新对话才换下一个**——上游缓存按账号隔离，中途换号等于把整段对话的缓存作废，`sticky` 就是为这件事准备的。卡片上点一下即可切换，默认仍是 `priority`。

- **池健康一眼看清**：卡片显示「几个账号 / 几个在冷却」「下一个会轮到谁」，以及每个账号的令牌有效期和冷却倒计时。

- **剩余积分实时可见**：按账号列出积分包（`套餐名 · 剩余 / 总量`）和大字合计，跟着上游实时刷新。

- **模型目录带标注**：列出池里能用的模型，附带积分倍率（如 `GLM-5.2 · x0.79`）、免费 / 限时免费 / 夜间折扣标签、能否收图和上下文窗口大小，全部跟随上游实时更新。

- **被限流时告诉你退路**：免费档被 429 冷却时，卡片和报错都会点名**同名的付费行**（如国际版 `deepseek-v4.1-flash` 对 `deepseek-v4.1-flash-sg`、国内版 `hy3` 对 `hy3-x`）。上游按「行」分别限流，所以免费行被关小黑屋时，收费行通常还是通的。

- **国内版 / 国际版自动适配**：按账号凭据里的登录域名自动选上游——国际版登录（`workbuddy.ai`）走 `www.workbuddy.ai`，国内版（默认）走 `copilot.tencent.com`。两种账号可以混在同一个池里。

- **每个账号可以有自己的出口 IP**：给单个账号填一条有序代理链，第 0 项是主出口，后面的按顺序顶替；一条都不填就是直连，行为和以前完全一样。

- **代理挂了不会偷偷回退直连**：链上每一跳都失败时请求直接报错，绝不改用本机 IP——静默回退正是封号的场景。

- **想手动做点啥也行**：卡片和命令行都提供「重新检测账号」「清除所有冷却」「每日签到」三个操作。

### 二、积分自动化

卡片上一个开关，插件在后台把你成长中心的日常动作全做掉。**默认全自动，也可以随时点「立即运行」手动跑一轮。**

它管这五件事：

| 任务 | 默认时间 | 干什么 |
| --- | --- | --- |
| 每日签到 | 09:00 | 领取当天签到奖励 |
| 活跃上报 | 10:00 | 报个到，让成长中心知道你还在用 |
| 任务奖励 | 11:00 | 把任务中心的奖励该报名的报名、该领的领掉 |
| 连登奖励 | 12:00 | 连登档位兑换 + 抽奖 |
| 猫猫旅行 | 09:00 · 21:00 | 把猫派出去、回来领奖励 |

**「任务奖励」这一项覆盖了 13 个任务**，包括那些看起来非得本人坐在电脑前点鼠标才能完成的：

> 探索优秀灵感 · 使用 5 个模板 · 尝鲜热门技能 · 换「和平精英」主题 · 逛资料库 · 召唤 5 次专家 · 召唤 3 次专家团 · 体验腾讯轻量云专家 · 进入任一小助手应用 · 进入企鹅教师助手 · 设计创意模式建画布 · 创建定时任务 · 猫猫对话

实测一轮跑下来，四个账号合计领到 **3300 积分 + 135 能量**。

**卡片上会告诉你这一轮具体领到了什么**——不是只写「领了 8 个任务」，而是把任务名字列出来。连登还差几天解锁也会写清楚（比如「还差 4 天解锁 7 天档」），免得你以为是坏了。

**关于「今日收益」**：卡片按来源分四行显示——任务奖励、签到、连登、旅行。今天赚了多少一眼看到，跨天自动清零。

**关于保留积分**：可以给每个账号设一个积分下限，余额低于这个数的账号就不派活了，省着点用。

> **国际版不显示这个面板**——那边的网关压根没有积分系统。

## 安装

前置条件：装好 WorkBuddy 桌面 App 并登录（插件复用它存在本机的登录状态）。多账号 = 在桌面 App 里换着登几次，每次登录都会被自动吸进池里。

> 兼容 host `0.1.1-rc.2` 起的整个 0.1.x 系列，以及 `0.2.0-rc.2`。安装设置节时会按 host 能力自动选择 `settings.installSection`（0.1.2-rc.1+）或更早的自由函数写法；卡片在 0.2.0 上作为设置面板里一个**平级标签页**渲染。

> **卡片在哪儿打开**：DSH 设置面板本身。开法是**侧边栏左下角的齿轮**，或者快捷键 `Ctrl+Alt+,`。
> 面板顶部是平级标签：`通用设置 / 模型 / 内置插件 / Agent 预设 / XD Pool` —— 本插件就是最后那个 **XD Pool**。
> （0.1.x 时代它叫「设置 → 插件 → DSH WorkBuddy XD Pool」，0.2.0 起改成了平级标签，按老路径找不到。）

**方式一：从本仓库安装（推荐）**

```sh
# dsh 不在 PATH 时，用 node ~/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js 代替 dsh
dsh plugin --profile desktop add github:dawanglaohu/dsh-xdpool
```

> 本仓库就是安装源。`lib/` 构建产物已随仓库提交，所以装的时候不需要任何安装期脚本，也不会弹 pnpm 那句「构建脚本被拦截，请放行」。
> 代价是会连带拉取开发依赖（构建器、测试框架等几百个包），第一次装比 npm 慢。

**方式二：从 npm 安装（上游包，不含本仓库的改动）**

```sh
dsh plugin --profile desktop add dsh-xdpool
```

> npm 上的 `dsh-xdpool` 归上游 `XDTrees` 所有，发布的是上游代码。本仓库在上游之上做了修复（网关 400 / code 11128 的会话标识头、模型饱和 14003 不再误冷却整池），**那些改动只存在于 GitHub 源**。要本仓库的行为就走方式一。
> 好处是只拉插件自己一个包，几秒搞定。

**方式三：手动注册 bundle**

```sh
# 1) 先装包（GitHub 或 npm 任选，见上）
dsh plugin --profile desktop add github:dawanglaohu/dsh-xdpool

# 2) 注册 bundle：编辑 ~/.dsh/profiles/desktop/package.json，
#    在 "dsh" → "profile" → "bundles" 数组末尾加上 "dsh-xdpool"

# 3) 重启 DSH Desktop
```

**本地构建（开发者）**

```sh
pnpm install
pnpm build              # 产出 lib/index.js + lib/index.d.ts + lib/bin.js + lib/client.js
pnpm test               # 967 项测试
pnpm typecheck          # 宿主侧类型检查
pnpm typecheck:client   # 客户端类型检查
```

> **构建产物已随仓库提交**（`lib/` 不在 gitignore 里），所以从 GitHub 装不需要任何安装期脚本，也不会弹 pnpm 那句「构建脚本被拦截，请放行」。**改了 `src/` 记得重新 `pnpm build` 并把 `lib/` 一起提交**，否则用户拿到的是旧产物。

> 注意：`pnpm install` 要用 pnpm 11（`npx pnpm@11`），必要时加 `--config.confirmModulesPurge=false --config.minimumReleaseAge=0`——pnpm 11 默认的 `minimumReleaseAge` 供应链年龄策略会拦下刚发布的 rc 包。

装完以后：模型选择器里会出现 **XD Pool（国内版）** 和 **XD Pool（国际版）** 两个分组（另有「聚合渠道」和「XD Pool · 免费模型」按需出现）；打开设置面板（左下角齿轮或 `Ctrl+Alt+,`）切到 **XD Pool** 一栏，能看池健康、各账号的令牌 / 积分 / 签到 / 冷却状态，还有「重新检测账号」「清除所有冷却」按钮和每个账号的签到按钮。

Web / TUI profile 也能用（`--profile web` / `--profile dsh-tui`）。

## 从旧版升级

这个插件以前叫 **`dsh-workbuddy-xdpool`**（显示名 `DSH WorkBuddy XD Pool`）。从 2.1.0 起改名为 **`dsh-xdpool`**。

**你的数据不会丢。** 插件自己的目录从 `~/.dsh/.workbuddy-xdpool` 变成了 `~/.dsh/.xdpool`，启动时会**自动把旧目录复制过来**——你填过的第三方 API key、忽略名单、账号 pin、启动日志，都在。旧目录**只复制、不删除**，所以想退回旧版、或者两个版本并存，都还能用。

唯一需要你动手的地方：**如果你的「默认模型」指向旧 id**，它不会自己改。旧 id 是宿主配置里的一个字符串，插件不去改宿主的配置文件（那等于插件改自己的加载器配置）。

| 旧 id | 新 id |
| --- | --- |
| `workbuddy-xdpool` | `xdpool` |
| `workbuddy-xdpool-global` | `xdpool-global` |
| `workbuddy-xdpool-aggregate` | `xdpool-aggregate` |
| `workbuddy-xdpool-free` | `xdpool-free` |

要改两处（都在 profile 目录里）：

```yaml
# ~/.dsh/profiles/desktop/home/settings.yaml
agent-default-model:
  provider: xdpool        # 原来是 workbuddy-xdpool
  model: hy3
```

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: agent-default-model
  config:
    provider: xdpool-global   # 原来是 workbuddy-xdpool-global
```

插件每次启动都会把这件事写进 `~/.dsh/.xdpool/startup.log`，所以忘了改也能在日志里找到确切该改什么。

## 命令行

统一用 `dsh plugin --profile desktop exec dsh-xdpool <子命令>` 调用：

```sh
dsh plugin --profile desktop exec dsh-xdpool status    # 池里几个号 / 几个冷却 + shim 状态（--credits 查积分、--json 机器可读、--rates 看倍率）
dsh plugin --profile desktop exec dsh-xdpool accounts  # 已发现的账号（--json）
dsh plugin --profile desktop exec dsh-xdpool doctor    # 诊断发现 / 冷却 / 上游连通性
dsh plugin --profile desktop exec dsh-xdpool reset     # 立刻清掉所有 429 冷却
dsh plugin --profile desktop exec dsh-xdpool checkin   # 查每个账号今天签到了没（--json 机器可读）
dsh plugin --profile desktop exec dsh-xdpool checkin all
                                                                 # 领掉所有账号今天的签到奖励；也可以只传一个账号标签领单个
dsh plugin --profile desktop exec dsh-xdpool login     # 教你怎么在桌面再加一个号进池
```

## 池里怎么多账号？

桌面 App 同一时间只保留**当前登录账号**的凭据（每次换号都会覆盖同一个文件），所以 XD Pool 自己把账号记下来：你在桌面 App 里换着登几个号，每个号在切走的瞬间就被池收进 `~/.dsh/.xdpool/accounts.json` 持久保存——**重启 DSH 也不会丢**。之后点卡片上的「重新检测账号」，或者直接开始用，池都会带着全部历史账号服务。

如果你想给桌面 App 之外的一次登录做个**显式快照**（比如临时固定某个号做验证），也可以手动导入：

```sh
# 在 WorkBuddy 桌面 App 登录账号后（key 自己起名）：
dsh plugin --profile desktop exec dsh-xdpool import myKey
# 查看 / 删除已导入的快照：
dsh plugin --profile desktop exec dsh-xdpool accounts
dsh plugin --profile desktop exec dsh-xdpool remove myKey
```

导入的快照与自动保存的账号存在同一个目录 `~/.dsh/.xdpool/` 下，每次扫描都会被一并收进池——不再是「导入了但没人读」。快照以 key 的 **MD5 前 8 位**命名（key 本身记在文件里），中文、带 `/`、带空格的 key 都安全。长期使用靠 refresh token 自动续期；失效了就回桌面重新登录，再 `import <key> --force` 覆盖。

## 配置

池的配置走插件设置节（`settings.xdpool`），模型设置页里能改，改完立即生效：

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `authFile` | 覆盖 WorkBuddy 桌面 auth 文件路径（跨平台自动探测出问题时用，等同于 `WORKBUDDY_AUTH_FILE`） | 自动探测 |
| `cooldownMs` | 单账号 429 冷却时长（毫秒） | `60000` |
| `distribution` | 账号分配方式：`sticky`（每对话固定一个账号，新对话换下一个）/ `priority`（先用完一个）/ `round-robin`（按顺序轮换）/ `balanced`（随机，偏向闲置久的） | `priority` |

> 上游 prompt 缓存按账号隔离，所以对话中途换号会把缓存整段作废。想让多账号同时分摊额度又不想掉命中率，用 `sticky`。

也可以直接写进 `~/.dsh/settings.yaml`：

```yaml
xdpool:
  cooldownMs: 120000
  distribution: sticky
```

### 每个账号的出口代理

池里的每个账号可以单独指定从哪个 IP 出去。**它是路由状态，不是 `settings.xdpool` 的字段**——所以不在这张配置表里，也不进 `settings.yaml`。

**存在哪**：`~/.dsh/.xdpool/proxies.json`（`DSH_HOME` 可覆盖），形状是「账号 id → 有序代理数组」：

```json
{
  "version": 1,
  "accounts": {
    "0123456789abcdef": [
      "http://user:pass@1.2.3.4:8080",
      "socks5h://user:pass@5.6.7.8:1080"
    ]
  }
}
```

**数组是有序的备选链**，不是集合：第 0 项是主出口，只有它挂了才按顺序往后走。**key 缺失就是直连**，空数组是同一件事的另一种写法，所以空链永远不会被写进文件。文件可以手改，读取是宽容的：非字符串、空串、重复项、解析不出来的条目逐条丢弃——一行坏不能赔掉你配的全部代理；整个文档坏掉则退化成「全部直连」，池子照样启动。写入走「临时文件 + rename」，不会留下半截文件。

**代理挂了绝不回退直连**：链上每一跳都失败时请求直接报错（`every proxy failed: <已脱敏的代理> connect <原因>`），不会静默改用本机 IP。只有响应头还没到达时的失败才会换下一跳；一旦拿到响应头就不再重试，否则会把已经开始流的回答重放一遍。请求体只有是字符串时才能跨跳重放，流式 body 只走第一跳。

**支持的 scheme**：`http:`、`https:`、`socks5:`、`socks5h:`。`socks5` / `socks5h` 一律把**主机名**交给代理去解析（ATYP=0x03），本机不做 DNS——避免 DNS 泄漏把真实出口暴露给上游。连接超时默认 8 秒，覆盖「拨号 + 握手 + 等响应头」；拿到响应头即停表，响应体可以合法地流几分钟。

**熔断**：同一跳连续失败 3 次后打开 60 秒，期间直接跳过、不消耗连接超时预算。熔断按原始代理 URL 做 key，两个账号共用同一个代理就共享判决。

**密码只以 `****` 出现在卡片上**。把带 `****` 的整串再存回去，会按「协议 + 主机 + 端口 + 用户名」全同回查到原来的真实密码——所以「只改端口不改密码」这种编辑不会把密码冲成四个星号。

**在卡片上怎么填**：账号池每个账号那一行末尾有一个多行输入框和一个徽标（`直连` 或 `代理 xN`）。

1. 一行一个代理 URL，**最上面那行优先**；写多行就是备选链。
2. 点「保存」，或按 `Ctrl/Cmd+Enter`（普通 Enter 仍是换行）。保存不会拨号——代理正挂着的时候你正是在修它。
3. 点「测试连通性」逐跳探测，每条显示 `{延迟}ms · via {出口 IP}` 或失败原因。探测慢（一个死跳就是一整个连接超时），所以和保存分开：逐跳单独试才能回答「哪一环死了」。
4. 清空输入框再保存 = 这个账号直连（徽标回到 `直连`）。

账号的健康徽标只看「链是否存在」，不记上次探测的判决——否则代理修好之后卡片还会一直显示失败；实时答案属于「测试连通性」。

> 聚合车道（`src/aggregate.ts`）里你自己配的聚合 provider 保持直连：那是你自配的第三方服务，不是池里的 WorkBuddy 账号。

## 架构

- **宿主侧**（`src/`，跑在 DSH 主进程里）
  - `index.ts` —— 注册 `xdpool` provider、`xdpool` 设置节、各条同源路由（状态 / 重新检测 / 清除冷却 / 签到 / 自动化运行 / 保留积分），以及账号发现与模型目录播种。
  - `accounts.ts` —— `WorkBuddyAccountPool`：发现并持久保存本机 WorkBuddy 账号（`account-store.ts` 落盘）、429 冷却、轮换与 token 刷新；账号停用与积分保留也在这里。
  - `scheduler.ts` —— 积分自动化的调度器：按本地时点跑五个任务（签到 / 上报 / 任务 / 连登 / 旅行），每日收益账本落盘，手动「立即运行」走的是同一套逻辑。
  - `task-events.ts` —— 13 条任务事件链的构造。每条链都是纯数据，外加它该走哪个指纹通道（桌面 / 网页）；需要真实会话的任务（技能、专家）在这里先开一次真对话，拿到服务端 id。
  - `catalog.ts` / `upstream.ts` —— 上游模型目录（含每模型积分倍率、免费 / 图片能力标签）、积分查询、签到、自动化各接口的上游客户端（按凭据域名自动切国内外）。
  - `web-status.ts` / `status-paths.ts` —— 卡片读的同源状态文档与路由。写操作按「POST + 回环来源 + 显式 accountId」把关。
  - `proxy-fetch.ts` —— 出站代理传输：HTTP CONNECT / SOCKS5 隧道、有序备选链、熔断、失败原因分类与凭据脱敏。
  - `proxy-store.ts` —— `proxies.json` 的读写与规范化（宽容读取、原子替换、空链不落盘）。
  - `bin.ts` —— 上面那套 CLI。
- **客户端**（`src/client/`，浏览器卡片，经 `dsh.client` 由宿主加载）
  折叠卡片外壳沿用宿主内置卡的 `dsm-plugin-card*` 样式语言（`--dsw-alias-*` 主题变量），内容类名统一 `dsm-xdpool-*` 前缀，不污染宿主其它卡片；文案命名空间 `settings.xdpool`。
- **构建**
  `tsdown` 产出 `lib/index.js`（宿主入口）+ `lib/index.d.ts`（类型）+ `lib/bin.js`（CLI）+ `lib/client.js`（CJS，用 `window.__ModuleLoader__.load` 包起来的浏览器 bundle）。四个产物都随仓库提交，所以安装时不需要任何构建脚本。

## 已知限制

- **WorkBuddy 主账号的登录仍走桌面 App**：XD Pool 可以为插件自己的十三家扫码登录渠道发起扫码，但 WorkBuddy 本体的 token 由桌面 App 的腾讯 SSO 铸造并和设备绑定，池不会替你登录 WorkBuddy。加号 = 在桌面 App 里登录 / 切换，XD Pool 自动吸收。

- **代理是逐账号的，不是全局的**：没有「让整台机器走代理」这种开关——全局代理会把池里所有账号放回同一个 IP，正是这个功能要避免的事。

- **自动化里有几个任务刻意没做**
  - `Expert_Philanthropy`（公益专家）：需要真捐钱，绕不过去。
  - `black_cat`（夜猫子）：只在 23:00–08:00 计分，而且**没有积分奖励**——熬夜白熬。
  - `Model_chat_GLM5.2`（指定模型对话）与 `wb_wechat_oa_subscribe_task`（关注公众号）：路径已经摸清，留到下个版本。

- **`Expert_team_use_3` 偶发卡在 2/3**：有个号当天用掉两次专家团后，第三次怎么发都不涨（换个没用过的专家团也不涨）。怀疑该任务对单账号有当日额度、跨天恢复，但没验证。**新号不受影响**（实测 0/3 → 3/3）。

- **依赖 WorkBuddy 客户端接口**（不是官方开放 API），WorkBuddy 更新后插件可能得跟着调。某个账号的 refresh token 失效时，回桌面重新登录即可。

- 如果 Windows 和 Linux 用户名不同、且 Windows 环境变量没传进 WSL，请用 `WORKBUDDY_AUTH_FILE` 或配置里的 `authFile` 指定实际位置。

## 免责声明

- 本项目**仅供个人学习和研究使用**，仅驱动使用者自己的 WorkBuddy 账号在本机调用，请勿用于商业用途或超出个人合理使用的场景。
- 使用者需遵守 WorkBuddy 的服务条款；因使用本项目产生的任何后果（包括但不限于账号被限制、额度被清空、服务中断），由使用者自行承担。
- 本项目作者不对任何因使用或滥用本项目产生的直接或间接损失负责。
- 本项目与腾讯、WorkBuddy、DeepSeek 均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，其商标权利归各自所有。

## 致谢

本项目的实现参考了以下已公开的项目，并按其许可证要求保留版权声明。参考方向为**设计思路与既有结论**，代码为独立实现；关键模块在源文件头部注释中也标注了所参考的项目与模式：

- [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT）—— 设置节注册（`settings.installSection`）与 DSH 插件结构、客户端卡片加载机制、桌面端凭据刷新与 loopback shim 加固的核心参照；本项目沿用其「宿主通过 installSection 挂卡片」的打通路径。
- [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)（MIT，Copyright (c) 2026 LaoDing）—— `dsm-plugin-card*` 卡片样式语言与 `--dsw-alias-*` 主题变量的参照实现；**每日签到**（`/v2/billing/meter/checkin-activity-status` 与 `/v2/billing/meter/daily-checkin`）、积分包聚合口径（月度周期套餐 / 一次性礼包区分）与国内 / 国际版按 `domain` 选择上游域名的做法，参考了该项目已验证的接口形态。
- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)（MIT）—— WorkBuddy 上游协议（`copilot.tencent.com` 的 wire behavior）与积分接口的参照实现；**积分自动化**（成长中心签到 / 活跃上报 / 连登兑换 / 猫猫旅行状态机 / 13 条任务事件链 / 专家召唤链）整体照该项目的 Go 版逆向实现移植，每条事件链的判据与实测结论都来自它。

以上项目的版权归各自作者所有。本项目采用**参考设计思路 + 独立实现**的方式，未整体复制任何参考项目的源码。若标注有遗漏或不当之处，欢迎提交 issue 指正。

## 许可证

[MIT](./LICENSE)
