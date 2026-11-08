# 贡献指南

先谢谢你有兴趣。这个项目只有一个硬性原则：**一个功能 = 一个子插件，删掉它不影响任何其它功能**。

---

## 一分钟了解结构

```
index.js            微内核：入站五阶段、工具门、出站唯一出口
kernel/             dsh-driver（会话）/ config-store / format / napcat-adapter …
plugins/<id>/       每个目录 = 一个独立功能（自动发现，不用注册）
  index.js          { id, title, order, configSchema, setup(bot) }
admin/              控制台后端（schema / endpoints / host）
client.js           控制台前端（页签、卡片）
test/               node --test，零网络、零真实 NapCat
```

子插件之间的规则：

- **不许互相 import**（现在实测 0 处）——要共享能力就挂到 `bot` 契约上；
- 加载失败只记日志、不影响其它插件；
- 每个插件自己声明 `configSchema`，控制台自动多一页（分组名决定它归到哪个分类）。

## 加一个子插件（最小例子）

```js
// plugins/weather/index.js
export default {
  id: 'weather',                 // 必须等于目录名
  title: '天气查询',
  order: 75,                     // 管线里插在哪（见 docs/开发指南.md §五）
  configSchema: {
    enabled: { type: 'bool', default: true, group: '聊天', label: '天气查询' },
  },
  setup(bot) {
    bot.on('before-turn', (ev) => {
      if (!bot.cfg.enabled) return
      ev.hint.push('[天气:要查天气就用 web_search]')
    })
  },
}
```

建好目录就能用：控制台「子插件」页会多一行，「5 聊天」分类下会多一页。
**删功能 = 删这个目录。**

## 提交之前

```bash
npm run verify     # 语法 + 测试 + 私密信息扫描 + 打包清单，四道闸
```

- `check:secrets` 会扫描私有路径 / QQ 号 / 凭据字面量 —— **别用真实号码当测试数据**（用 `10001` 这类合成值）；
- `node --test` 必须全绿，红了**不要改断言让它们变绿**（改动要么修代码，要么在 PR 里说明这是真实缺陷）。

## 代码风格

- ESM、无 TypeScript、无构建步骤（`client.js` 也是纯 JS 直接加载）；
- 注释写**为什么**，不写"这是什么"；
- 中文注释 + 英文标识符混排是常态，不用统一；
- 新增行为请带一条测试，测试名用中文描述行为。

## 报问题

- Bug：带上 `npx dsh-onebot-qq doctor` 的输出，**不要贴 `config.json`**（里面有 token）；
- 安全问题：见 [SECURITY.md](SECURITY.md)，不要开 public issue。
