# 我的课表 · 旧地址迁移入口

这个仓库的 GitHub Pages 现在只发布一个迁移入口，不再发布课表 HTML 或课表源码。

- 旧地址：https://rayn-star.github.io/timetable/
- 新版地址：https://rayn-timetable-athens.levelhibiscus3.chatgpt.site/

## 旧地址现在做什么

1. 读取当前浏览器里旧版课表留下的两个本地存储键（`timetable.v2`、`timetable.term.v1`）。
2. 如果存在旧数据，先提供一份 v4 JSON 备份下载，再引导你进入新版导入。
3. 如果没有旧数据，直接跳转到新版登录首页。
4. 不会删除、改写或上传旧数据；下载备份每次重新读取，避免导出过时快照。

`404.html` 处理旧地址下的其它路径，同样指向备份入口和新版地址。

## 新版

新版由 Sites 托管（Cloudflare Worker + D1），入口是《雅典学院》主题的登录页，邮箱 + 密码注册登录后才能打开课表。账号与课表数据都在新版里，不再依赖 GitHub Pages。

## 文件

```text
index.html   # 迁移入口（备份 + 跳转）
404.html     # 其它路径的迁移提示
README.md
```

旧版课表页面与本地后端源码仍保留在本仓库历史中，但不再作为页面发布。
