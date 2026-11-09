# webdav4mygo

把 NAS 或网盘上的 WebDAV 音乐目录接入 [MyGo Music](https://music.egoist.dev/zh/plugins/)。

[![安装到 MyGo Music](docs/install.svg)](https://iko233.github.io/webdav4mygo/)

## 安装

1. 在安装页点击「打开 MyGo Music 安装」。安装页会调用 `mygo-music://install-plugin?repo=iko233/webdav4mygo`。
2. 也可以在 MyGo Music 0.1.22 或更新版本中进入「设置 → 插件 → +」，从 GitHub 安装并输入 `iko233/webdav4mygo`，或选择本地 ZIP。
3. 在插件设置中填写音乐目录的完整 WebDAV URL，例如 `https://nas.example.com/dav/Music/`。需要认证时填写用户名和密码。匿名服务器将两项留空。
4. 切换到 WebDAV 音源，打开「音乐文件夹」。

## 使用

- 「全部音乐」递归列出音乐，每页 50 首。「音乐文件夹」列出当前目录的直属子文件夹和歌曲。
- 歌曲以去掉扩展名的文件名显示。插件读取少量音频数据获取时长。缺少帧数信息的 MP3 和独立 AAC 文件按码率估算。服务器拒绝读取或文件缺少足够信息时，时长可能留空。
- 搜索按文件名和目录名匹配。多个关键词以空格分开。全部音乐和搜索最多扫描 512 个文件夹，目录列表缓存约 2 分钟。修改设置后立即清除缓存。
- 直接播放 MP3、FLAC、WAV、M4A、AAC 和 Ogg Vorbis。文件内的编码须受 MyGo Music 支持。
- 使用 `PROPFIND` 读取目录，由播放器使用 `GET` 读取音频。服务器须支持匿名访问或 HTTP Basic 认证。请填写可直接访问的 WebDAV 目录，避开会跳转的登录页或分享链接。
- MyGo Music 在插件设置中以明文显示和保存密码。建议使用 HTTPS 和专用只读账号或应用密码。

由 [iko233](https://github.com/iko233) 与 Codex 协作开发。
