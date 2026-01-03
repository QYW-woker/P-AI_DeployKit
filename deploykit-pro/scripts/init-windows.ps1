#
# DeployKit Pro - Windows Server 初始化脚本
# 此脚本用于准备目标 Windows 服务器的部署环境
# 请以管理员身份运行 PowerShell
#

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "╔═══════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║     DeployKit Pro - Windows Server 初始化脚本             ║" -ForegroundColor Cyan
Write-Host "╚═══════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# 检查管理员权限
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "❌ 请以管理员身份运行此脚本" -ForegroundColor Red
    exit 1
}

# 系统信息
$os = Get-CimInstance Win32_OperatingSystem
Write-Host "📋 系统信息: $($os.Caption) $($os.Version)" -ForegroundColor Gray
Write-Host ""

# 创建部署目录
Write-Host "📁 创建部署目录..." -ForegroundColor Yellow
$deployPath = "C:\inetpub\wwwroot"
if (-not (Test-Path $deployPath)) {
    New-Item -ItemType Directory -Path $deployPath -Force | Out-Null
}
Write-Host "   ✅ 部署目录: $deployPath" -ForegroundColor Green

# 安装 Chocolatey (包管理器)
Write-Host ""
Write-Host "📦 检查 Chocolatey..." -ForegroundColor Yellow
if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
    Write-Host "   正在安装 Chocolatey..." -ForegroundColor Gray
    Set-ExecutionPolicy Bypass -Scope Process -Force
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
    Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://chocolatey.org/install.ps1'))
    refreshenv
}
Write-Host "   ✅ Chocolatey 已安装" -ForegroundColor Green

# 安装 OpenSSH Server
Write-Host ""
Write-Host "📦 安装 OpenSSH Server..." -ForegroundColor Yellow
$sshCapability = Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'
if ($sshCapability.State -ne 'Installed') {
    Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
}
Start-Service sshd
Set-Service -Name sshd -StartupType 'Automatic'
Write-Host "   ✅ OpenSSH Server 已启用" -ForegroundColor Green

# 配置防火墙
Write-Host ""
Write-Host "🔥 配置防火墙..." -ForegroundColor Yellow
$rules = @(
    @{Name="SSH"; Port=22},
    @{Name="HTTP"; Port=80},
    @{Name="HTTPS"; Port=443},
    @{Name="Node.js"; Port=3000}
)
foreach ($rule in $rules) {
    $existing = Get-NetFirewallRule -DisplayName "DeployKit-$($rule.Name)" -ErrorAction SilentlyContinue
    if (-not $existing) {
        New-NetFirewallRule -DisplayName "DeployKit-$($rule.Name)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $rule.Port | Out-Null
    }
}
Write-Host "   ✅ 防火墙规则已配置" -ForegroundColor Green

# 安装 Node.js
Write-Host ""
Write-Host "📦 安装 Node.js..." -ForegroundColor Yellow
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    choco install nodejs-lts -y
    refreshenv
} else {
    $nodeVersion = node -v
    Write-Host "   ✅ Node.js $nodeVersion 已安装" -ForegroundColor Green
}

# 安装 PM2
Write-Host ""
Write-Host "📦 安装 PM2..." -ForegroundColor Yellow
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
    npm install -g pm2
}
Write-Host "   ✅ PM2 已安装" -ForegroundColor Green

# 安装 Git
Write-Host ""
Write-Host "📦 安装 Git..." -ForegroundColor Yellow
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    choco install git -y
    refreshenv
}
Write-Host "   ✅ Git 已安装" -ForegroundColor Green

# 安装 IIS (可选)
Write-Host ""
$installIIS = Read-Host "是否安装 IIS? (y/n)"
if ($installIIS -eq 'y') {
    Write-Host "📦 安装 IIS..." -ForegroundColor Yellow
    Install-WindowsFeature -Name Web-Server -IncludeManagementTools
    Install-WindowsFeature -Name Web-Asp-Net45
    Write-Host "   ✅ IIS 已安装" -ForegroundColor Green
}

# 安装 Docker (可选)
Write-Host ""
$installDocker = Read-Host "是否安装 Docker? (y/n)"
if ($installDocker -eq 'y') {
    Write-Host "📦 安装 Docker..." -ForegroundColor Yellow
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        choco install docker-desktop -y
        Write-Host "   ⚠️  请重启后完成 Docker 安装" -ForegroundColor Yellow
    } else {
        Write-Host "   ✅ Docker 已安装" -ForegroundColor Green
    }
}

# 安装 Python (可选)
Write-Host ""
$installPython = Read-Host "是否安装 Python? (y/n)"
if ($installPython -eq 'y') {
    Write-Host "📦 安装 Python..." -ForegroundColor Yellow
    if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
        choco install python -y
        refreshenv
    }
    Write-Host "   ✅ Python 已安装" -ForegroundColor Green
}

# 安装 Java (可选)
Write-Host ""
$installJava = Read-Host "是否安装 Java? (y/n)"
if ($installJava -eq 'y') {
    Write-Host "📦 安装 Java..." -ForegroundColor Yellow
    if (-not (Get-Command java -ErrorAction SilentlyContinue)) {
        choco install openjdk17 -y
        choco install maven -y
        refreshenv
    }
    Write-Host "   ✅ Java 已安装" -ForegroundColor Green
}

# 显示结果
Write-Host ""
Write-Host "╔═══════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║                    ✅ 初始化完成                          ║" -ForegroundColor Green
Write-Host "╚═══════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "已安装的组件:" -ForegroundColor White

$components = @(
    @{Name="Node.js"; Cmd="node -v"},
    @{Name="npm"; Cmd="npm -v"},
    @{Name="PM2"; Cmd="pm2 -v"},
    @{Name="Git"; Cmd="git --version"},
    @{Name="Docker"; Cmd="docker -v"},
    @{Name="Python"; Cmd="python --version"},
    @{Name="Java"; Cmd="java -version"}
)

foreach ($comp in $components) {
    try {
        $version = Invoke-Expression $comp.Cmd 2>&1 | Select-Object -First 1
        Write-Host "  • $($comp.Name): $version" -ForegroundColor Gray
    } catch {
        Write-Host "  • $($comp.Name): 未安装" -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host "📁 默认部署目录: $deployPath" -ForegroundColor Cyan
Write-Host ""
Write-Host "🔐 SSH 服务已启动，端口: 22" -ForegroundColor Cyan
Write-Host ""
Write-Host "⚠️  如果安装了 Docker，请重启系统完成安装" -ForegroundColor Yellow
Write-Host ""
