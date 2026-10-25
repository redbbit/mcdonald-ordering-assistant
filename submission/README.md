# 提交材料

| 文件 | 说明 |
|---|---|
| `SUBMISSION.md` | 作品说明全文（使用方式 / 亮点 / 实现思路），可逐段粘贴到表单 |
| `cover.png` | 作品封面，1600×1200（4:3），318 KB |
| `DEMO_SCRIPT.md` | 演示拍摄脚本：16 个分镜 + 旁白文案 + 隐私红线 + 导出规格 |
| `demo-walkthrough-captioned.mp4` | 演示走查视频（74 秒，字幕已烧进画面），覆盖 13 类功能 + 全场单点彩蛋 |
| `demo-captions.srt` | 字幕文件（VLC / PotPlayer 同名自动加载；自行配音时可复用时间轴） |

## 在线体验

https://mcd-order-advisor.app.workbuddy.host/?sharecode=TC2HD3HTE5

无需登录、无需配置：直接就是离线预演模式。若想看到官方实时数据，在本机运行
`python server.py` 后页面的「在线模式」按钮可直接连接。

## 录像说明

`demo-walkthrough-captioned.mp4` 由无头浏览器自动走查录制：1440×900 视口，
未配音，字幕已烧进画面。因无头渲染限制，视频为 800×500，且滚动到页面下半部分时
右侧「今日菜单灵感」栏偏暗。需要更高质量时，按 `DEMO_SCRIPT.md` 自行配音重录即可。
