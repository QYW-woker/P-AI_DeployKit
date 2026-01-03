# DeployKit Pro

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue.svg" alt="Version">
  <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg" alt="Node">
  <img src="https://img.shields.io/badge/license-MIT-orange.svg" alt="License">
</p>

<p align="center">
  🚀 企业级智能部署平台 - 支持多平台部署、配置管理、AI 智能助手
</p>

---

## 📋 功能特性

- **🌍 多平台部署** - 支持 Linux/Windows/macOS/Docker/Vercel/Netlify/OSS/COS/S3
- **⚙️ 配置管理** - 保存、编辑、删除服务器配置，无需重复填写
- **📦 可视化部署** - 拖拽上传 ZIP → 选择配置 → 一键部署
- **🤖 AI 智能助手** - 分析错误、修改文件、自动修复、兜底部署
- **📋 实时日志** - WebSocket 推送部署进度和日志

## 🏗️ 技术架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                          用户浏览器                                  │
│  ┌──────────────────────────┬──────────────────────────┐            │
│  │       主部署面板          │       AI 助手面板         │            │
│  └──────────────────────────┴──────────────────────────┘            │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼  HTTP / WebSocket
┌─────────────────────────────────────────────────────────────────────┐
│                        Node.js 后端                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐               │
│  │ 部署服务  │ │ 配置管理  │ │ AI 助手  │ │ 文件管理  │               │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘               │
│                        │                                            │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                      部署器 (Deployers)                        │  │
│  │  Linux │ Windows │ Docker │ Vercel │ Netlify │ OSS/COS/S3    │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## 🚀 快速开始

### 1. 安装依赖

```bash
cd deploykit-pro
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件：

```env
PORT=3000
ANTHROPIC_API_KEY=sk-ant-api03-xxxxx  # AI 助手功能需要
```

### 3. 启动服务

```bash
# 开发模式
npm run dev

# 生产模式
npm start
```

访问 `http://localhost:3000` 开始使用。

## 📖 使用指南

### 添加服务器配置

1. 点击「添加服务器」按钮
2. 选择平台类型（Linux/Windows/Docker/Vercel 等）
3. 填写连接信息
4. 点击「测试连接」验证
5. 保存配置

### 执行部署

1. 选择目标平台
2. 选择已保存的服务器配置
3. 填写项目名称和部署路径
4. 上传 ZIP 项目包
5. 点击「开始部署」

### 使用 AI 助手

当部署失败时：
1. 点击「让 AI 帮我分析」
2. AI 会自动读取日志和项目文件
3. 提供修复建议或自动修复
4. 可以一键重新部署

## 📦 支持的平台

| 平台 | 类型 | 连接方式 | 说明 |
|------|------|----------|------|
| 🐧 Linux | 服务器 | SSH | 支持 Ubuntu/CentOS/Debian 等 |
| 🪟 Windows | 服务器 | SSH | 需要安装 OpenSSH Server |
| 🍎 macOS | 服务器 | SSH | 适用于 Mac 服务器 |
| 🐳 Docker | 容器 | SSH | 远程 Docker 主机 |
| ▲ Vercel | PaaS | API | 需要 API Token |
| ◆ Netlify | PaaS | API | 需要 API Token |
| ☁️ 阿里云 OSS | 存储 | SDK | 静态网站托管 |
| ☁️ 腾讯云 COS | 存储 | SDK | 静态网站托管 |
| ☁️ AWS S3 | 存储 | SDK | 静态网站托管 |

## 🔧 服务器准备

### Linux 服务器

运行初始化脚本：

```bash
curl -fsSL https://your-domain/scripts/init-linux.sh | bash
```

或手动安装：

```bash
# 安装 Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 安装 PM2
sudo npm install -g pm2

# 安装 Nginx
sudo apt-get install -y nginx

# 创建部署目录
sudo mkdir -p /www
```

### Windows 服务器

以管理员身份运行 PowerShell：

```powershell
# 启用 OpenSSH
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType 'Automatic'

# 安装 Chocolatey
Set-ExecutionPolicy Bypass -Scope Process -Force
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
iex ((New-Object System.Net.WebClient).DownloadString('https://chocolatey.org/install.ps1'))

# 安装 Node.js 和 PM2
choco install nodejs-lts -y
npm install -g pm2
```

### 获取云平台凭证

#### Vercel
1. 访问 https://vercel.com/account/tokens
2. 创建新的 Token
3. 复制 Token 到配置中

#### Netlify
1. 访问 https://app.netlify.com/user/applications#personal-access-tokens
2. 创建新的 Token
3. 复制 Token 到配置中

#### 阿里云 OSS
1. 访问 RAM 控制台创建用户
2. 授予 OSS 完全权限
3. 创建 AccessKey
4. 创建 Bucket 并启用静态网站托管

#### 腾讯云 COS
1. 访问 CAM 控制台创建用户
2. 授予 COS 权限
3. 创建密钥
4. 创建存储桶并启用静态网站

#### AWS S3
1. 创建 IAM 用户
2. 授予 S3 权限
3. 创建 Access Key
4. 创建 Bucket 并配置静态网站托管

## 📁 项目结构

```
deploykit-pro/
├── backend/
│   ├── server.js                 # Express 主入口
│   ├── services/
│   │   ├── deploy.js             # 部署服务
│   │   ├── serverConfig.js       # 配置管理
│   │   ├── aiAssistant.js        # AI 助手
│   │   └── deployers/            # 各平台部署器
│   └── utils/
│       └── fileManager.js        # 文件操作
├── frontend/
│   └── index.html                # 单文件前端
├── data/
│   ├── servers.json              # 服务器配置
│   └── history.json              # 部署历史
├── workspace/                    # AI 工作区
├── uploads/                      # 上传文件
├── scripts/                      # 初始化脚本
├── package.json
├── .env.example
└── README.md
```

## 🔌 API 接口

### 服务器配置

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/platforms | 获取支持的平台列表 |
| GET | /api/servers | 获取所有服务器配置 |
| POST | /api/servers | 创建服务器配置 |
| PUT | /api/servers/:id | 更新服务器配置 |
| DELETE | /api/servers/:id | 删除服务器配置 |
| POST | /api/servers/:id/test | 测试连接 |

### 部署

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/project/upload | 上传项目 |
| POST | /api/deploy | 执行部署 |
| GET | /api/deploy/:projectId/logs | 获取部署日志 |

### AI 助手

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/ai/chat | AI 对话 |
| POST | /api/ai/diagnose | 快速诊断 |
| POST | /api/ai/autofix | 自动修复 |

## 🔐 安全注意事项

1. **敏感信息加密** - 密码和密钥使用 Base64 编码存储
2. **前端隐藏** - API 返回时隐藏敏感字段
3. **文件验证** - 只接受 ZIP 文件上传
4. **工作区清理** - 自动清理 24 小时前的临时文件
5. **SSH 密钥** - 建议使用私钥认证而非密码

## 🛠️ 开发

```bash
# 安装依赖
npm install

# 开发模式（热重载）
npm run dev

# 生产模式
npm start
```

## 📄 许可证

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

<p align="center">Made with ❤️ by DeployKit Team</p>
