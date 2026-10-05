# Z11 Console — Home Assistant 加载项

把 Z11 家居控制台作为 HAOS 加载项运行：房间设备卡片、温湿度来源、摄像头、天气、扫地机地图，直接内嵌在 Home Assistant 侧边栏。

## 安装

1. 在 Home Assistant 中进入 **设置 → 应用 → 安装应用**，点击右上角菜单选择 **仓库**；
2. 添加仓库地址：`https://github.com/ethan-z11/z11_console_ha`；
3. 在商店中找到 **Z11 Console**，点击安装；
4. 启动加载项后，侧边栏会出现 **Z11 Console** 入口（走 Ingress，无需开放端口）。

## 特点

- 自动使用 Supervisor 注入的令牌连接本机 Home Assistant，**无需手动生成长期令牌**；
- 首次打开默认admin/admin,要求修改账号及密码，可跳过，但每次进入都会强制提示修改，修改后不提示；
- 设置好界面后可设置子账号，登出用子账号登陆，避免管理账号误修改界面；
- 数据保存在加载项 `/data` 目录，随备份一起保存。

## 独立部署版本

Docker / docker-compose 独立部署请见主仓库：<https://github.com/ethan-z11/z11_Console>
