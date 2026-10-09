# 商店提交指南 — 抖音评论辅助工具

目标平台：先 Edge（免费）→ 再 Chrome（$5 一次性）。

## 提交物清单

| 文件 | 用途 |
|---|---|
| `douyin-comment-assistant_store_v1.9.1.zip` | 商店上传包（不含 .git / README 可保留） |
| `PRIVACY.md` | 隐私政策（上传到可公网访问的位置取 URL，见下） |
| 本文件的「商店文案」章节 | 粘贴到商店表单 |

## 1. 隐私政策 URL（必填）

上传 `PRIVACY.md` 到任一公网位置，推荐直接用 Gitee/GitHub raw：
```
https://gitee.com/jinghui111/douyin-auto-reply-extension/raw/master/PRIVACY.md
```
（GitHub raw 同理：`https://raw.githubusercontent.com/personal82555/douyin-auto-reply-extension/master/PRIVACY.md`）
raw 页面是纯文本，商店可接受；如要求 HTML，可把 md 转 html 传 Gitee Pages。

## 2. Edge 商店（推荐先投，免费，通常 1~3 天）

1. https://partner.microsoft.com/dashboard/microsoftedge → 注册开发者（个人，免费）
2. Overview → New extension → 上传 zip
3. 填 Store listing：
   - 名称：抖音评论辅助工具
   - 描述：见下方文案
   - 隐私：选 "This extension does not collect user data" + 填 Privacy policy URL（因实际调用了用户自填的第三方LLM接口，稳妥起见仍填 URL）
4. 权限说明（required justification）如实填：见「权限理由」
5. 提交审核

## 3. Chrome Web Store（$5 注册费）

1. https://chrome.google.com/webstore/devconsole 注册（一次性 $5）
2. Item → New → Upload zip
3. 商店详情：名称/描述/截图/类别(工具)/语言(中文简体)
4. 隐私标签（Privacy practices）：
   - "Single purpose": 说明=在抖音网页内辅助生成与填入评论文案
   - 三个 Yes/No 均选 No（不处理支付/不改新标签页/不收集用户数据）
   - Privacy policy URL 同上
5. Human interaction：勾选 "user is told how to interact"（辅助模式里文案由用户审阅后发送）
6. 提交审核，拒审一般会给原因，改后可重投

## 商店文案（可直接粘贴）

**短描述（Edge 1024 字符内 / Chrome 132 字符优先）：**
```
抖音网页版评论辅助工具：搜索热门视频、AI 生成候选评论，一键填入评论框，由你审阅后发送。支持固定城市搜索、关键词筛选、评论记录统计。
```

**长描述：**
```
抖音评论辅助工具 —— 在抖音网页版里帮你更高效地写评论、管评论。

主要功能：
• 搜索热门视频：关键词搜索 / 一键抓取当前页视频，可固定城市前缀（如「杭州 宽带」）
• AI 候选文案：每条视频生成 3 条候选评论，选中后一键填入评论框，最终由你审阅并点击发送
• 关键词筛选：配置关注的关键词，自动筛出匹配标题的视频，可用自定义文字或图片回复
• 评论记录统计：总数 / 月 / 周 / 今日 四级统计与明细，点击明细可跳回对应视频
• 固定侧边栏：助手常驻浏览器右侧，切换标签不丢数据
• 热门榜单：实时展示今日前 10 热门话题，点击直达视频列表

隐私说明：
本扩展没有开发者服务器，你的 API Key、配置与评论记录全部保存在本地浏览器存储，可一键清空。AI 文案仅请求你自己填写的接口地址。

使用前请在浏览器正常登录抖音。评论发送是否自动由你自己在设置中决定，发送行为由你的账号承担平台规则后果，请遵守抖音社区自律公约。
```

**权限理由（Edge justification / Chrome 权限说明）：**
```
storage: 保存用户的 LLM 配置、关键词规则与评论统计（全本地）。
activeTab/scripting: 在用户当前打开的抖音标签页内抓取可见的视频标题并把生成的文案填入评论输入框。
tabs: 打开抖音视频页以执行填入操作并读取其地址用于评论记录。
sidePanel: 提供常驻侧边栏主界面。
host_permissions: 请求用户自行配置的 OpenAI 兼容 LLM 接口（可为任意 http/https 地址）。
```

## 4. 截图清单（商店要求，Edge≥1张，Chrome≥1张 1280×800 或 640×400）

准备这些截图（用你自己的浏览器实际截，别 P 图）：
1. 侧边栏全貌（含热榜+统计徽章）
2. 搜索结果列表（带「命中」角标）
3. LLM 候选文案 3 条 + 「选这条」状态
4. 全自动监视器运行中（黑底彩色日志滚动）
5. 关键词自动回复配置区（关键词+文字+附图预览）

## 5. 审核注意事项（踩过的坑）

- **描述里别出现**：批量刷评、自动发评、爬虫、绕过风控——一律写"辅助/由你审阅后发送"
- 全自动开关保留在功能里可以，但**别在商店描述和截图里强调"无人值守自动发送"**
- Chrome 首审可能要求录屏演示核心流程（用户如何触发、如何确认发送）
- 名称「抖音评论辅助工具」含"抖音"是品牌词，Edge/Chrome 一般允许（描述为"适用于抖音网页版"），若被要求改名可用「网页评论辅助工具」
