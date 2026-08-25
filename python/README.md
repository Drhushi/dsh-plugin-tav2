# 内置 Python 后端（tav2）

本目录是插件随附的 `tav2` Python 翻译后端（TranslateAgent v2 的 `tav2` 包），
随插件一起发布，**用户无需单独下载或配置**。

## 插件如何找到它

插件定位顺序：插件配置 `pythonRepo` → 环境变量 `TAV2_PYTHON_REPO` → 本内置目录
（`<插件安装目录>/python/`）。定位到后，插件会把该目录注入子进程 `PYTHONPATH`，
`python -m tav2` 即可用。

## 运行依赖

需要本机已有 Python 3.10+，且装有第三方依赖：

```powershell
pip install PyYAML requests openpyxl
```

## 何时需要 Python

`tav2_prepare` 只有以下情况才走 Python 后端：

- 游戏脚本是已编译的 `.rpyc`（散文件或打包在 `.rpa` 里）——还需官方 **Ren'Py SDK**
  （在「设置 → 插件 → dsh-plugin-tav2」填 `renpySdk`，或每次 `tav2_prepare --sdk <路径>`）；
- 显式传 `--sdk`；
- 插件配置 `prepareBackend: python` 强制。

`.rpy` 源码游戏默认走插件内置的 TS 原生 prepare，完全不依赖 Python。

## 更新

本目录从 `TranslateAgent_v2/tav2` 同步。改动 Python 后端时请同步此处并更新
`python/requirements.txt`；`tav2` 包无打包元数据，靠 PYTHONPATH 直接运行。
