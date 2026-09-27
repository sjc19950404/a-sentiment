# 云端管道部署指南（GitHub Actions + Pages）

目标：**电脑长期关机，每日数据管道照常运转**。管道（抓取 → 入档 → 构建 → 发布）整体迁到 GitHub 的服务器上，数据以 git 提交持久化——比任何单机存储都可靠。

## 为什么这套方案是"完美"的

| 维度 | 说明 |
|------|------|
| 解耦 | 管道跑在 GitHub 的机器上（ubuntu runner），你的电脑只是开发机 |
| 数据持久 | 每日 `data.json` 自动提交回仓库，git 历史即全量备份 |
| 成本 | 0 元（Public 仓库 Actions 无限额度 + Pages 免费） |
| 可移植 | 管道零第三方依赖（纯 Node 内置模块），任何机器 checkout 即跑 |
| 安全性 | 管道自带熔断：非交易日/空榜/数据量异常自动中止；已在档幂等退出，重跑不会重复入档 |

## 一、前置说明

- 仓库用 **Public**（Pages 免费版要求公开）。仓库内容 = 行情数据 + 构建产物，无隐私；个人数据（权重/预测/笔记/本地标记）存在浏览器 localStorage，**不进仓库**。
- Actions 用 UTC 时区，workflow 已按 `UTC 10:30 = 北京 18:30` 换算，进程时区已设 `TZ=Asia/Shanghai`，交易日判定来自**接口返回的数据时钟**（非本地时钟），无跨日风险。

## 二、三步上线（约 10 分钟）

### 1. 创建仓库
登录 [github.com](https://github.com) → 右上角 `+` → New repository：
- 名称建议 `a-sentiment`；可见性选 **Public**；**不要**勾选 "Add a README"（保持空仓库）。

### 2. 本机推送（在本目录打开终端）
```bash
git init -b main
git add -A
git commit -m "init: A股市场情绪系统 v4.7 + 云端每日管道"
git remote add origin https://github.com/<你的用户名>/a-sentiment.git
git push -u origin main
```
（首次推送会弹 GitHub 登录授权，浏览器确认即可）

### 3. 开启 Pages
仓库页面 → Settings → Pages → Build and deployment → **Source 选 "GitHub Actions"**。

## 三、首跑验证（关键！）

仓库 → **Actions** 标签 → 左侧 `daily-pipeline` → 右上 **Run workflow** → Run。

看日志确认两点：
1. `最近交易日: 20XX-XX-XX · 强势股 N 只` —— N 正常（几十只）说明东财/腾讯/同花顺接口在 GitHub 境外 IP 下可达；
2. 最终绿勾 + Pages URL 可访问：`https://<你的用户名>.github.io/a-sentiment/`。

> ⚠ 若首跑失败在"抓取强势股/龙虎榜"步骤且日志显示被拒/超时——说明境外 IP 被行情源拦截，回来找我，我给 fetch-daily 加备用源或代理出口（方案已预留）。接口对境外 IP 一般是放行的，先验证再说。

## 四、日常运维

| 场景 | 处理 |
|------|------|
| 正常运转 | 无需任何操作：交易日 18:30（±半小时延迟）自动更新 Pages |
| 失败通知 | GitHub 默认邮件通知仓库所有者（Actions 红叉） |
| 某天失败/漏跑 | Actions 页面手动 Run workflow 补跑（管道幂等，重复跑安全） |
| 缺口补数据 | 30 天内缺口 `node fetch-daily.js --backfill` 可补池/额并全档重算（本机跑后 push，或未来把它也做成 workflow input） |
| 本机数据同步 | `git pull` 即可让本机 data.json 与云端一致 |

## 五、本机侧已同步调整

- 本机 WorkBuddy 的 18:30 自动化已**暂停**（2026-09-27 起，避免与云端双跑分叉）；需要恢复时在自动化列表重新启用即可。
- 即使云端迟迟未部署也不丢数据：管道幂等 + `--backfill` 能力意味着**首次云端运行会自动补齐停跑期间的缺口**（龙虎榜/强势股以数据源保留深度为限，见 §6）。
- 本机 `dist/` 与线上 task-tieba-app 链接保留但停止更新；**新的数据家在 github.io**。
- 两处路径的 Windows 硬编码兜底（build.js/fetch-daily.js 的 `SENT_SITE_DIR`）在 workflow 里已用 env 绕开，本机行为不变。

## 六、故障边界（如实说明）

- GitHub 定时触发有 5~30 分钟常见延迟，偶尔高峰更长——数据是收盘后抓取，晚点无碍。
- GitHub 全站故障（罕见）当天不更新；次日手动补跑。
- 管道对"错过多日"的补齐能力：池/额/因子可 backfill；龙虎榜/强势股主数据依赖接口保留深度，缺口过大时以现有 30 天档连续性为限——这与本机方案的能力边界相同，不是云端引入的新短板。
