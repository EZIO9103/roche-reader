# Roche 小红书读取后端（Cloudflare 免费版）

这是 Roche 小红书转发插件的读取服务。它使用 Cloudflare Browser Run 打开小红书页面，再使用 Workers AI 识别配图文字。

## 用 GitHub 一键部署

1. 在 GitHub 新建一个仓库，例如 `roche-xhs-reader-cloudflare`。
2. 把本压缩包里的 `package.json`、`wrangler.jsonc`、`src` 上传到仓库根目录。
3. 登录 Cloudflare，进入 **Workers & Pages → Create application → Import a repository**。
4. 选择刚才的 GitHub 仓库。
5. Build command 留空；Deploy command 使用 `npx wrangler deploy`。
6. 保存并等待第一次部署完成。

`wrangler.jsonc` 已经声明：

- `BROWSER`：Browser Run 浏览器绑定。
- `AI`：Workers AI 绑定。

部署完成后，可以在 Worker 的 **Settings → Bindings** 确认这两个名字都存在。

## 设置访问密钥

1. 打开 Worker 的 **Settings → Variables and Secrets**。
2. 新建一个加密 Secret：
   - 名称：`GATEWAY_KEY`
   - 值：自己生成的一段长密码。
3. 保存后重新部署一次。

把 Worker 地址记下来，格式通常是：

`https://roche-xhs-reader.你的子域名.workers.dev`

## 检查服务

打开：

`https://你的Worker地址/health`

应看到 `browser`、`ocr` 和 `gatewayKeyConfigured` 都为 `true`。

直接用浏览器打开 `/health` 时，`gatewayKeyValid` 显示 `false` 是正常的，因为浏览器没有附带密钥。Roche 插件里的“测试连接”会携带密钥，届时它应当显示为有效。

## 免费额度与缓存

- Cloudflare Browser Run 免费计划目前每天提供 10 分钟浏览器时间。
- Workers AI 免费计划目前每天提供 10,000 Neurons。
- 相同链接、相同设置的成功结果会缓存 6 小时，避免反复消耗额度。

如果出现浏览器额度不足，需要等次日额度恢复。关闭插件里的“识别配图文字”或减少配图数量可以节省 Workers AI 额度。

## 本地命令（可选）

```bash
npm install
npm run dev
```

本地测试 Browser Run 时需要 Cloudflare 账号，因此 `dev` 使用远程模式。
