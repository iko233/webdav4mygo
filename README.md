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
- 插件优先分段读取音频来获取时长。服务器拒绝分段读取时，改用普通请求读取有限的文件开头数据。缺少帧数信息的 MP3 和独立 AAC 文件按码率估算。列表未取得时长时，点播后由播放器尝试计算进度条时长。
- 搜索按文件名和目录名匹配。多个关键词以空格分开。全部音乐和搜索最多扫描 512 个文件夹，目录列表缓存约 2 分钟。修改设置后立即清除缓存。
- 播放时自动加载 WebDAV 同目录、同文件名的 `.lrc` 歌词。文件名以音频原文件名为准。
- 直接播放 MP3、FLAC、WAV、M4A、AAC 和 Ogg Vorbis。文件内的编码须受 MyGo Music 支持。
- 使用 `PROPFIND` 读取目录，由播放器使用 `GET` 读取音频。服务器须支持匿名访问或 HTTP Basic 认证。请填写可直接访问的 WebDAV 目录，避开会跳转的登录页或分享链接。
- MyGo Music 在插件设置中以明文显示和保存密码。建议使用 HTTPS 和专用只读账号或应用密码。

### 文件夹与封面

- 左侧「我的歌单」列出 WebDAV 根目录的直属文件夹。点开可播放文件夹内的歌曲。侧栏入口和目录卡片会选用目录内有封面的歌曲。这些目录入口是只读的。「音乐文件夹」可逐级浏览。
- 歌曲优先显示音频标签中的曲名、歌手和专辑，缺少曲名时使用文件名。点击歌手名可查看歌手图和当前文件夹内识别到的同一歌手歌曲。
- 封面优先使用内嵌图片，其次是同名图片或目录里的 `cover`、`folder`、`front`。歌手图片来自音频中的歌手图，或同目录里的 `artist`、`performer`、`band` 图片。没有图片时沿用播放器默认图。
- 内嵌封面和需要登录才能读取的图片使用本地缓存。请在插件设置中点击「允许程序」，启用安装包内的封面缓存助手。助手只接收图片字节，支持 1 MB 以内的 JPEG、PNG、GIF。

由 [iko233](https://github.com/iko233) 与 Codex 协作开发。
