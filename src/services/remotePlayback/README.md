# Remote 路线（平台自己的桌面应用代播）

桌面版的故障转移：平台说这个账号的音频在 Folia 里根本放不了（Spotify 不给这个账号音频密钥，或这台系统没有播放组件），本次运行里这个平台的歌改由它自己的桌面应用播放，Folia 只显示（歌词、封面、进度）和遥控（播放、暂停、跳转、音量）。没有任何音频经过 Folia。当前这首走哪条路线记在 `usePlaybackStore` 的 `playbackRoute`（`'web' | 'hifi' | 'remote'`）。

只有在线平台的歌、且平台在 omni 里提供了 `remotePlayer`（目前只有 Spotify）才可能走这条路线；本地、Navidrome、别的平台的歌都不受影响。设置里只有一个开关（默认开），存在 `folia_remote_playback_mode`（`'off'` 关，`'auto'` 开；早先版本的 `'always'` 读作开）。

## 结构

```text
src/services/onlinePlayback.ts（取音频失败）
  -> remoteRoute.ts noteRemoteTakeover：平台的 remotePlayer.takesOver(error) 认了 → 本次运行接管这个平台
src/components/app/playback/start/usePlaybackQueueController.ts / restore/restorePlaybackSource.ts
  -> remoteRoute.ts remoteRouteFor(song) → remotePlayback.ts beginRemoteTrack
       -> omni.getRemotePlayer → src/services/onlineMusic/spotify/spotifyRemotePlayer.ts
            ──window.electron.spotifyRequest（remote_play / remote_control / remote_state / remote_stop）──>
            electron/spotify/spotifyApiBridge.cjs -> remote.cjs ──spclient connect-state 命令──> Spotify 桌面应用
                                                    <── dealer.cjs（websocket 推送账号的播放状态）──┘
```

### 主进程 `electron/spotify/`

- `remote.cjs`：连 dealer、以隐藏观察者（`hobs_<id>`）登记、在账号的设备里找这台电脑上的应用（按电脑名；找不到就打开应用，取打开后新加入的那台）、发命令、把状态整理成渲染端要的形状（`remote_state` 长轮询，版本号变了就回）。
- `dealer.cjs`：Spotify 推送账号状态的 websocket，第一条消息给出登记要用的 connection id。
- `desktopApp.cjs`：打开应用（macOS `open -g -a Spotify`，Windows `spotify:` 链接，Linux `spotify` 或 flatpak），列出这台电脑可能的设备名。

### 渲染端

- `remoteRoute.ts`：判一首歌走不走这条路线（`remoteRouteFor`）、记下平台的接管（`noteRemoteTakeover`）、退回 Folia 自己播放（`disengageRemote`）。
- `remotePlayback.ts`：路线本身：把歌交给应用、跟随应用的状态、走带、音量跟随 Folia 的滑块、别的路线接手时暂停应用（路线守卫）、给观察者的媒体 shim。
- `remoteClock.ts`：应用只在改变走向时报位置，中间按 `Date.now()` 往前数；把一次报告读成"还在这首 / 结束了 / 去了别处 / 还没接上"。
- `remoteTrackStore.ts`：当前交给应用的歌、应用最近一次报告、本次运行接管了哪些平台、要告诉用户的提示。
- `src/components/remote-playback/`：App 里挂一次的桥（结束时下一首、提示）、进度条旁的徽标、智能过渡的闸门。
- `src/services/onlineMusic/spotify/spotifyRemotePlayer.ts`：Spotify 的 `OnlineRemotePlayer` 实现，按主进程的句子分辨失败种类。

## 实测（Spotify）

- 公开的 Web API 对这种登录一律答 429（2026-10-08，见 `src/services/onlineMusic/UPSTREAMS.md`），所以只能走 Spotify 自己应用用的 spclient connect-state + dealer。
- Spotify 对每条命令都答 200 和一个 `ack_id`，应用有没有照做都一样。所以 `play` 要等应用报告它拿到了这首（命令之后的新报告）才算成功，8 秒内没有就报"应用没有开始播放"。2026-10-29 应用 1.3.6 上，context 没写 uri 的 `play`（早先探测用的内联列表）就是这样被收下又丢掉的。
- `play` 用这首歌自己当 context（`spotify:track:<id>`），起始位置放在 `options.seek_to`，一条命令就从那里开始。
- 歌放完时，应用里开着自动播放（Autoplay）的话会接着放一首它自己挑的。在 Folia 的计数到了这首结尾时应用换了歌，就当这首结束了：先暂停应用，再放 Folia 自己的下一首（下一首的 `play` 等这次暂停回来再发）。关掉 Autoplay 时结尾的样子没有实测。
- 应用自己换了歌（用户在应用里点的、或别的设备接走），Folia 不跟随：停在这首、提示"应用换到了别的歌或别的设备"，按播放把这首交回应用。

## 被这条路线接管的核心功能

走这条路线时 `<audio>` 里没有歌，下面这些地方都得改问应用。每一处都紧挨着 HiFi 路线的同类判断，不和它合并成共用的帮手：那样会改上游的 HiFi 调用点，每次同步上游都要解冲突。

| 位置 | 接管了什么 | 为什么需要 |
| --- | --- | --- |
| `src/components/app/playback/start/usePlaybackQueueController.ts` | 起播：不取音频地址，交给应用；取地址失败而平台刚接管时也改走这里；`pauseWhatIsSounding` 也暂停应用 | 歌在应用里放 |
| `src/components/app/playback/restore/restorePlaybackSource.ts` | 恢复上次的歌：停在原位置等按播放 | 同上，恢复的歌 |
| `src/services/onlinePlayback.ts` | 取音频失败时问平台要不要接管 | 故障转移的入口，只有这一处 |
| `src/services/prefetchService.ts` | 走这条路线的歌不预取地址 | 问了也只会再被拒 |
| `src/components/app/playback/bridges/usePlaybackTransportController.ts` | 播放、暂停 | `<audio>` 里没有歌 |
| `src/components/app/playback/bridges/usePlaybackInteractionBridge.ts` | 空格键、点歌词切换播放；方向键跳转 | 同上 |
| `src/App.tsx` 的 `seekDuringTransitionRef`、`useElectronPlaybackBridge.ts` 的两处跳转 | 进度条、托盘/遥控器的跳转 | 每条跳转的入口都要到达应用 |
| `src/components/app/playback/bridges/usePlaybackVisualizerBridge.ts` | 歌词时钟读应用的位置；频谱保持空闲 | 歌词跟应用走；没有音频可分析 |
| `src/components/app/presentation/buildPlayerViewFlags.ts` | 没有 `audioSrc` 时播放键也可用 | 同上 |
| `src/components/remote-playback/useRemoteAutomixGate.ts`（`App.tsx` 并进 `useAutomixDecks` 的 `isEnabled`） | 这首或下一首走这条路线时关掉智能过渡 | 过渡要 Folia 自己的两个播放器同时出声 |
| `restore/useElectronWindowPlaybackHandoff.ts`、`useStagePlaybackController.ts` 的快照 | 位置取应用的 | 窗口重建、Stage 往返后位置不丢 |
| `src/hooks/useElectronVideoExportController.ts` | 拦下视频导出 | 应用的声音录不进来 |
| `src/services/hifi/hifiMediaShim.ts` 的 `registerRouteMedia` | Media Session、Discord、听歌上报、scrobble 看这条路线的 shim | 观察者看到应用里的播放 |
| `src/components/FloatingPlayerControls.tsx` | 进度条旁的徽标（"在 Spotify 应用里"，点开设置） | 唯一看得见的标记 |
| `src/types/hifi.ts` | `PlaybackRoute` 加上 `'remote'` | 路线本身 |

## 测试

- 单元测试：`test/unit/remotePlayback/`（路线、时钟、路线守卫、闸门）和 `test/unit/spotify/spotifyRemote.test.ts`（主进程对着一个假的 Spotify：找设备、命令的形状、应用没照做时失败）。
- 手动：`test/manual/spotifyRemoteProbe.mjs` 自己登录、对真的应用跑一遍命令并记下报告（2026-10-27 的探测，其中内联列表的 `play` 在应用 1.3.6 上已不再生效）。
