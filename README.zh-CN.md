# pi-kiro-connector

一个为 [Pi](https://pi.dev) 提供 Kiro Runtime 原生访问、模型发现、流式输出、思考、图片和工具能力的扩展包。

[English](README.md)

## 功能

- 通过专用 `kiro` Provider 支持 Kiro 模型目录返回的全部兼容模型
- 调用 Kiro 区域数据面，并解析 AWS EventStream 响应
- 支持文本、思考内容、图片、Pi 工具、工具结果、流式输出和取消
- 从 Kiro 区域模型目录发现模型及 Token 限制
- 离线启动时使用内置回退模型目录
- 通过 `/login kiro` 支持 AWS Builder ID 与 AWS IAM Identity Center（公司 SSO）登录和 Token 自动刷新
- 通过 `/login kiro` 或 `KIRO_API_KEY` 支持 Kiro API Key
- 提供 `/kiro-status`、`/kiro-use` 和模型可调用的 `kiro_connection` 工具
- 不返回或主动记录凭据
- 除 Pi 的 peer package 外没有运行时 npm 依赖

## 前置条件

1. Node.js 22.19.0 或更高版本
2. Pi 0.84.4 或更高版本
3. 已获 Kiro 使用权限的 AWS Builder ID 或 IAM Identity Center 账号，或通常以 `ksk_` 开头的 Kiro API Key

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

Pi 会提供账号登录或 API Key 认证。选择账号登录后，可以继续选择：

- **AWS Builder ID**：Pi 显示设备代码和 AWS 验证地址。使用你登录 Kiro 的账号完成授权。
- **AWS IAM Identity Center**：适用于公司的 AWS Access Portal。输入 Portal Start URL（例如 `https://company.awsapps.com/start`）及其 SSO Region，在浏览器中完成公司 SSO。浏览器随后会跳转到 `http://127.0.0.1/oauth/callback`；无需运行本地服务器，请从地址栏复制完整 URL 并按提示粘贴到 Pi。
- **Kiro API Key**：在 API Key 登录选项中输入 `ksk_...` 或 `ksk_...|区域`。

Pi 会把所选凭据保存在标准 Provider 凭据存储中，并自动刷新 OAuth Access Token。`kiro` Provider 同一时间只使用一份已保存的凭据；再次执行 `/login kiro` 会替换原凭据。连接器不会创建额外凭据文件。

IAM Identity Center 的 SSO Region 是公司 AWS Access Portal 配置中显示的区域，仅用于 AWS OIDC 认证。连接器会根据账号的 Kiro Profile 单独选择 Kiro 数据面区域。

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

不要把 API Key、OAuth Token、授权回调 URL/授权码、设备代码、注册客户端 Secret 或 Pi 认证文件写入源代码仓库、Issue、截图或会分享给他人的 Shell 历史。

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

状态命令和工具只报告凭据来源、端点、状态和模型数量，不会返回 API Key 或 OAuth Token。

## 工作原理

连接器把 Pi 消息转换为 Kiro 原生会话格式。API Key 请求使用区域 Kiro Runtime：

```text
https://runtime.<region>.kiro.dev/
```

AWS Builder ID 使用 AWS OIDC 设备授权。IAM Identity Center 使用公司 AWS Access Portal issuer，并通过受 PKCE 和 `state` 保护的授权码流程登录。Pi 会把 Access Token、Refresh Token、注册客户端元数据、认证元数据及可选的 Kiro Profile ARN 作为一份 OAuth 凭据保存，并在到期前自动刷新 Access Token。身份提供方类型和公司 Start URL 都不会随推理请求发送。

模型元数据通过账号对应的区域模型目录获取。服务返回受容量限制和空闲超时保护的二进制 AWS EventStream；连接器会增量校验帧 CRC，并将文本、思考、用量和交错工具事件映射为 Pi 原生流协议。模型发现和流开始前的请求使用有界响应读取、超时及针对瞬时故障的有限重试。

Pi 通过 `/settings`、Shift+Tab 或 `--thinking` 控制思考级别。只有启用 Pi reasoning level 时，连接器才会加入 Kiro 思考提示。当前连接器将 Kiro 协议视为开关控制，因此 `minimal` 到 `max` 目前都会产生相同的启用行为。

Pi 会通过 Provider 模型存储缓存成功发现的模型目录，缓存仅包含模型元数据。内置小型目录可确保离线启动时仍能看到 Provider。

## 常见问题

### 认证失败

重新执行 `/login kiro`。使用 Builder ID 时，请通过你登录 Kiro 的同一账号完成设备授权。使用 IAM Identity Center 时，请向管理员确认准确的 AWS Access Portal Start URL 和 SSO Region，并把完整 loopback 回调 URL 粘贴到 Pi。使用 API Key 时，请确认 `KIRO_API_KEY` 包含有效的 Kiro API Key。`/kiro-status` 会报告认证失败，但不会显示凭据。

### 区域端点失败

使用 API Key 时，检查 `KIRO_REGION`，它应是 `us-east-1`、`eu-central-1` 之类的区域标签。使用 AWS 账号认证时，连接器会优先从账号的 Kiro Profile 选择数据面区域。IAM Identity Center 的 SSO Region 只用于认证，不会被当作 Kiro 数据面区域。

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
