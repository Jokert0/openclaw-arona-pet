# 阿洛娜桌宠渲染页

Electron 使用 `loadFile` 打开 `index.html`。页面通过 `window.pet` 订阅状态、请求模型地址、发送消息及打开菜单。`cubism.bundle.js` 已构建，可直接随页面运行。运行时资源全部来自本地。

## 依赖与重建

- 渲染器采用 Live2D 官方 Cubism Web Framework `5-r.4`，提交 `8df84780f2aa1298f3b30965cdae143e049f3c8e`。此版本把 WebGL 着色器嵌在脚本内，适合 `loadFile`。源码见 <https://github.com/Live2D/CubismWebFramework/tree/5-r.4>。
- 构建使用桌宠包的开发依赖 `esbuild`（当前锁定 `0.27.4`）。在已安装桌宠依赖的工作区运行以下 PowerShell 命令。已有 `.deps/framework` 时只需运行最后一行。

```powershell
Set-Location 'C:/web/openclaw-2026.10.10/arona/openclaw-arona-pet/view'
New-Item -ItemType Directory -Force .deps/framework | Out-Null
Invoke-WebRequest 'https://codeload.github.com/Live2D/CubismWebFramework/tar.gz/8df84780f2aa1298f3b30965cdae143e049f3c8e' -OutFile .deps/framework.tgz
tar -xzf .deps/framework.tgz -C .deps/framework --strip-components=1
node ./build.mjs
```

如已有相同版本的 SDK，可将 `CUBISM_FRAMEWORK` 设为含 `src` 的 `Framework` 目录后构建。生成的 bundle 与 `CubismFramework-LICENSE.md` 一起分发。

## 本地 Cubism Core 与模型

使用可读取 MOC3 版本 5 的 Cubism 5 Web Core。请从 [Live2D 官方 Cubism SDK for Web](https://www.live2d.com/en/sdk/download/web/) 按许可获取 `Core/live2dcubismcore.min.js`。宿主可通过 `ARONA_CUBISM_CORE` 指定绝对路径，默认使用桌宠项目内的 `assets/live2dcubismcore.min.js`，同时兼容 `.runtime/live2dcubismcore.min.js`。Core 由 `pet.model()` 的 `core` URL 加载，与 Framework 构建产物分开提供。

宿主以 `petasset://local/model/entry.model3.json` 提供入口，并按清单的相对路径提供 MOC、PNG 和物理文件。当前模型用真实参数驱动呼吸、眨眼、视线、转头及抚摸表情，物理文件驱动头发和配饰。模型随附说明限定个人使用，禁止商用或再分发。
