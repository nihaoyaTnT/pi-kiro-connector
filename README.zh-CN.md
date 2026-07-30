# pi-kiro-connector

一个为 [Pi](https://pi.dev) 提供 Kiro Runtime 原生访问、模型发现、流式输出、思考、图片和工具能力的扩展包。

[English](README.md)

## 功能

- 通过专用 `kiro` Provider 支持 Kiro 模型目录返回的全部兼容模型
- 调用区域 Kiro Runtime，并解析 AWS EventStream 响应
- 支持文本、思考内容、图片、Pi 工具、工具结果、流式输出和取消
- 从 Kiro 区域模型目录发现模型及 Token 限制
- 离线启动时使用内置回退模型目录
- 支持 Pi 的 `/login kiro` 凭据存储或 `KIRO_API_KEY`
- 提供 `/kiro-status`、`/kiro-use` 和模型可调用的 `kiro_connection` 工具
- 不返回或主动记录 API Key
- 除 Pi 的 peer package 外没有运行时 npm 依赖

## 前置条件

1. Node.js 22.19.0 或更高版本
2. Pi 0.83.0 或更高版本
3. Kiro API Key，通常以 `ksk_` 开头

请只使用你有权使用的凭据与服务。

## 安装

从 GitHub 安装：

```bash
pi install git:github.com/nihaoyaTnT/pi-kiro-connector
```

固定 Release 版本：

```bash
pi install git:github.com/nihaoyaTnT/pi-kiro-connector@v0.1.0
```

发布 npm 后安装：

```bash
pi install npm:pi-kiro-connector@0.1.0
```

本地开发：

```bash
git clone https://github.com/nihaoyaTnT/pi-kiro-connector.git
cd pi-kiro-connector
npm ci
pi install .
```

## 配置

### 推荐：通过 Pi 登录

启动 Pi 后执行：

```text
/login kiro
```

输入 `ksk_...` 或 `ksk_...|区域`。Pi 会将凭据保存在标准 Provider 凭据存储中；连接器不会创建额外凭据文件。

### 环境变量

也可以在启动 Pi 前配置环境变量。

PowerShell：

```powershell
$env:KIRO_API_KEY = "ksk_..."
$env:KIRO_REGION = "us-east-1"
pi
```

Windows CMD：

```bat
set KIRO_API_KEY=ksk_...
set KIRO_REGION=us-east-1
pi
```

Linux / macOS：

```bash
export KIRO_API_KEY='ksk_...'
export KIRO_REGION='us-east-1'
pi
```

`KIRO_REGION` 默认是 `us-east-1`。也可以把区域附加到 Key 后，例如 `KIRO_API_KEY='ksk_...|eu-central-1'`。单独设置的 `KIRO_REGION` 优先级更高。

不要把真实 Key 写入 `.env.example`、源代码仓库、Issue、截图或会分享给他人的 Shell 历史。

## 使用

安装后重新加载 Pi，然后检查并选择 Provider：

```text
/reload
/kiro-status
/kiro-use claude-sonnet-4.6
```

也可以在启动时指定模型：

```bash
pi --provider kiro --model claude-sonnet-4.6
```

`kiro_connection` 工具支持：

- `status`：检查认证、区域连接和模型发现
- `models`：列出已注册的 Kiro 模型 ID
- `use`：切换到 Kiro 模型

状态命令和工具只报告凭据来源、区域端点、状态和模型数量，不会返回 Key。

## 工作原理

连接器把 Pi 消息转换为 Kiro 原生会话格式，并直接发送到：

```text
https://runtime.<region>.kiro.dev/
```

模型元数据通过 Kiro 区域 CodeWhisperer 模型目录操作获取。Runtime 返回二进制 AWS EventStream；连接器会增量校验帧 CRC，并将文本、思考、用量和工具事件映射为 Pi 原生流协议。

Pi 通过 `/settings`、Shift+Tab 或 `--thinking` 控制思考级别。只有启用 Pi reasoning level 时，连接器才会加入 Kiro 思考提示。

Pi 会通过 Provider 模型存储缓存成功发现的模型目录，缓存仅包含模型元数据。内置小型目录可确保离线启动时仍能看到 Provider。

## 常见问题

### 认证失败

重新执行 `/login kiro`，或确认 `KIRO_API_KEY` 包含有效的 Kiro API Key。`/kiro-status` 会报告 HTTP 401/403，但不会显示凭据。

### 区域端点失败

检查 `KIRO_REGION`，它应是 `us-east-1`、`eu-central-1` 之类的区域标签。

### 模型没有刷新

在有网络且已配置凭据时运行 `/reload` 或重启 Pi。发现接口不可用时，Pi 会保留缓存元数据或使用内置回退目录。

### 扩展修改没有生效

```bash
pi list
pi config
```

然后运行 `/reload` 或重启 Pi。

## 开发与验证

```bash
npm ci
npm run validate
```

验证包括 TypeScript 检查、协议与单元测试、Pi 离线加载冒烟测试和 `npm pack --dry-run`。CI 覆盖 Node.js 22.19.0 和 24。

## 安全与隐私

请求会包含推理所需的对话上下文，并发送至 Kiro 区域服务。凭据处理、安全报告及审查建议见 [SECURITY.md](SECURITY.md)。

## 许可证

本项目使用 [MIT](LICENSE) 许可证。

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。
