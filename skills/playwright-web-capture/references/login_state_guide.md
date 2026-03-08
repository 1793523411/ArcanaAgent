# 登录态使用指南（--storage-state）

## 它是啥

需要登录才能看的页面，用普通方式抓取会得到「未登录」的内容（登录框、引导页等）。**登录态** = 把「已登录的那次访问」里的 **cookies + localStorage** 存成一个文件，之后抓取时先加载这个文件，浏览器就相当于已经登着那个账号，页面会直接给你登录后的内容。

`--storage-state` 就是指定这个「状态文件」的路径，capture 脚本会用 Playwright 在打开页面前先加载它。

---

## 两步流程概览

| 步骤 | 做什么 | 做几次 |
|------|--------|--------|
| 1. 保存登录态 | 用浏览器打开目标站、登录，然后把当前页的 cookies/localStorage 存成 `state.json` | 每个站点/账号做一次，或登录过期时重做 |
| 2. 带登录态抓取 | 运行 `capture.py --storage-state state.json "需要登录的URL"` | 每次抓需要登录的页面时 |

下面用「抖音生活服务学习中心」举例，你可以换成任何需要登录的站点。

---

## 实践步骤

### 第一步：保存登录态（手动登录一次）

1. **进入 skill 目录**（或任意你放脚本的地方），运行「保存登录态」脚本：

```bash
cd /Users/cloud/Desktop/my-skills/.cursor/skills/playwright-web-capture
python3 scripts/save_storage_state.py "https://lifexue.com" -o state_lifexue.json
```

2. **会弹出一个可见的浏览器窗口**，并打开 `https://lifexue.com`。

3. **在浏览器里像平时一样登录**（扫码、账号密码、验证码等都正常操作），直到页面显示「已登录」、能看到学习中心内容。

4. **回到终端**，在运行 `save_storage_state.py` 的那个终端里 **按一次 Enter**。

5. 脚本会把当前页面的登录态写入 `state_lifexue.json`，然后关闭浏览器。终端里会提示类似：`Saved to state_lifexue.json`。

这样你就得到了一份「登录态文件」`state_lifexue.json`，之后只要在抓取时带上它即可。

---

### 第二步：带登录态抓取页面

用同一份状态文件去抓需要登录才能看的 URL，例如规则详情页：

```bash
python3 scripts/capture.py "https://lifexue.com/rule/detail/xxxxx" --storage-state state_lifexue.json -o ./
```

脚本会：

- 先加载 `state_lifexue.json` 里的 cookies/localStorage；
- 再打开你给的 URL；
- 页面会认为「已经登录」，直接展示正文，而不是登录框。

输出还是会进一个新的 `web_capture_YYYYMMDD_HHMMSS` 目录，和平时一样。

---

## 注意事项

- **状态文件里有敏感信息**（cookie 等），不要提交到 git、不要发给别人。建议把 `state_*.json` 加入 `.gitignore`。
- **会过期**：站点一般会定期让登录失效，过期后抓出来又是未登录内容，需要重新执行「第一步」再生成一份新的 state 文件。
- **一个文件对应一个站点/账号**：不同站点、不同账号，可以各存一个文件，例如 `state_lifexue.json`、`state_other_site.json`，抓的时候用对应的 `--storage-state` 即可。
- **只支持 Playwright 的 storage state 格式**：必须是本脚本或 Playwright 的 `context.storage_state(path="...")` 生成的文件，不能随便拿一个「cookie 导出」文件来用。

---

## 不用脚本时：自己写几行代码保存

如果不想用 `save_storage_state.py`，可以用 Playwright 自己写一段「打开页面 → 你手动登录 → 保存状态」的脚本，例如：

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)  # 有界面，方便登录
    context = browser.new_context()
    page = context.new_page()
    page.goto("https://lifexue.com")
    input("在浏览器里登录完成后，回到这里按 Enter 保存状态...")
    context.storage_state(path="state_lifexue.json")
    browser.close()
```

保存后，同样用：

```bash
python3 scripts/capture.py "URL" --storage-state state_lifexue.json -o ./
```

即可带登录态抓取。
