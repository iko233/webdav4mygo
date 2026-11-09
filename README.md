# webdav4mygo

把 NAS 或网盘上的 WebDAV 音乐目录接入 [MyGo Music](https://music.egoist.dev/zh/plugins/)。

## 安装

1. 打开 MyGo Music 0.1.22 或更新版本，进入「设置 → 插件 → +」。
2. 选择从 GitHub 安装，输入 `iko233/webdav4mygo`。也可以在同一菜单选择本地 ZIP。
3. 在插件设置中填写音乐目录的完整 WebDAV URL，例如 `https://nas.example.com/dav/Music/`。需要认证时填写用户名和密码。匿名服务器将两项留空。
4. 切换到 WebDAV 音源，打开「音乐文件夹」。

## 使用

- 浏览多级目录。歌曲以去掉扩展名的文件名显示。
- 搜索按文件名和目录名匹配。多个关键词以空格分开。搜索最多扫描 512 个文件夹，目录列表缓存约 2 分钟。修改设置后立即清除缓存。
- 直接播放 MP3、FLAC、WAV、M4A、AAC 和 Ogg Vorbis。文件内的编码须受 MyGo Music 支持。
- 使用 `PROPFIND` 读取目录，由播放器使用 `GET` 读取音频。服务器须支持匿名访问或 HTTP Basic 认证。请填写可直接访问的 WebDAV 目录，避开会跳转的登录页或分享链接。
- MyGo Music 在插件设置中以明文显示和保存密码。建议使用 HTTPS 和专用只读账号或应用密码。

由 [iko233](https://github.com/iko233) 与 Codex 协作开发。
