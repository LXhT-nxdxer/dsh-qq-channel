# 安全策略

## 报告漏洞

**不要开 public issue。** 用 GitHub 的 [Private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
（仓库 → Security → Report a vulnerability），或者直接找维护者私下说。

请在报告里写清：影响版本、复现步骤、你预期会发生什么、实际发生了什么。

## 这个项目里"敏感"的东西

| 东西 | 在哪 | 说明 |
|---|---|---|
| `napcat.wsToken` / `httpToken` | `config.json` | 协议端鉴权，泄露 = 别人能冒充你的机器人收发消息 |
| 模型 `apiKey`（生图 / 识图） | `config.json` 的 `credentials` / `vision` | 泄露 = 别人能刷你的额度 |
| 聊天记录 | `logs/qq_chat/*.jsonl` | 私聊内容，属于隐私 |
| 表情包库 | `qq-stickers/` | 里面是别人发过的图 |
| 人设文件 | `workspace/AGENTS.local.md` | 可能写了主人 QQ、生活习惯 |

**这些都不在仓库里**（`.gitignore` 已排除 `config.json` / `data/` / `*.log`），
`npm run check:secrets` 会挡私有路径、QQ 号、凭据字面量。

## 已经做的防护

- **工具门（代码级）**：群聊 / 陌生人私聊只放行 QQ 聊天工具 + 联网，碰不到文件与命令；
  记忆写入只认主人回合。这一道不依赖模型"听话"。
- **出站脱敏**：QQ 号 / IP / 端口 / root 凭据 / 密码 / apiKey 六类自动打码（主人私聊豁免）。
- **路径白名单**：发图 / 图生图读文件前先 `realpath`，软链穿不出去。
- **提示注入隔离**：群消息里的"忽略上面的指令"之类，按数据对待，不按命令处理。

## 已知边界

- 防攻略里的"话术检测"是正则：**绕法一定存在**。真正的底是上面那道代码级工具门。
- 机器人跑在宿主进程里，**信任宿主**：能改 `config.json` 的人就能改它的一切行为。
