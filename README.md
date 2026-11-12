# 我的课表 · 静态加密版

- 地址：https://rayn-star.github.io/timetable/
- 纯静态托管在 GitHub Pages：没有后端、没有账号数据库。
- 首页是一个密码输入页；课表页面（含课程数据）以 **AES-256-GCM 密文**放在 `assets/payload.js` 里，密码经 **PBKDF2-SHA256（600,000 次）** 派生密钥，密码正确才能解密并显示。
- 课表与待办仍保存在**当前浏览器的 localStorage**（`timetable.v2`、`timetable.term.v1`），与以前的静态版相同；同一浏览器里的旧数据会自动沿用。
- 忘记密码不会丢课表数据：重新生成本页即可（密码只决定能不能打开页面，不影响浏览器里的数据）。

## 文件

```text
index.html                     # 密码输入页
assets/payload.js              # 加密后的课表页面（密文）
assets/unlock.js               # PBKDF2 + AES-GCM 解密与界面逻辑
assets/login.css               # 登录/解锁页样式
assets/school-of-athens.jpg    # 拉斐尔《雅典学院》（压缩后）
assets/pinyon-script.ttf       # Pinyon Script 花体字
assets/CREDITS.md / OFL-*.txt  # 图片与字体来源、许可证
404.html                       # 其它路径的提示页
```

## 更新方式

页面由本地脚本从课表应用源码重新生成（源码与构建脚本不在本仓库）。修改课表内容或更换密码后，重新生成 `index.html`、`assets/payload.js` 并推送即可；密文文件名带版本查询参数，浏览器会拉取新版本。

## 安全边界

- 页面内容确实加密，密码不对无法查看；但密文是公开的，强密码很重要。
- 这是个人工具的静态门禁，不是多用户账号系统；不要把敏感信息放进页面源码。
- 课表数据本身就在访客自己的浏览器里；清空浏览器数据会丢失，可用课表右上角「导出」备份 JSON。

## 图片来源

拉斐尔《雅典学院》（1509–1511），公有领域，来源见 `assets/CREDITS.md`。字体 Pinyon Script 为 SIL Open Font License。
