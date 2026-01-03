#!/bin/bash
#
# DeployKit Pro - Linux 服务器初始化脚本
# 此脚本用于准备目标 Linux 服务器的部署环境
#

set -e

echo "╔═══════════════════════════════════════════════════════════╗"
echo "║     DeployKit Pro - Linux 服务器初始化脚本                ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""

# 检测操作系统
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$NAME
    VER=$VERSION_ID
else
    OS=$(uname -s)
    VER=$(uname -r)
fi

echo "📋 系统信息: $OS $VER"
echo ""

# 更新包管理器
echo "📦 更新包管理器..."
if command -v apt-get &> /dev/null; then
    apt-get update -y
    PKG_MGR="apt-get"
elif command -v yum &> /dev/null; then
    yum update -y
    PKG_MGR="yum"
elif command -v dnf &> /dev/null; then
    dnf update -y
    PKG_MGR="dnf"
else
    echo "❌ 不支持的包管理器"
    exit 1
fi

# 安装基础工具
echo ""
echo "🔧 安装基础工具..."
$PKG_MGR install -y curl wget unzip git

# 安装 Node.js (v18+)
echo ""
echo "📦 安装 Node.js..."
if command -v node &> /dev/null; then
    NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VER" -ge 18 ]; then
        echo "✅ Node.js $(node -v) 已安装"
    else
        echo "⚠️  Node.js 版本过低，正在升级..."
        curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
        $PKG_MGR install -y nodejs
    fi
else
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
    $PKG_MGR install -y nodejs
fi

# 安装 PM2
echo ""
echo "📦 安装 PM2..."
if command -v pm2 &> /dev/null; then
    echo "✅ PM2 已安装"
else
    npm install -g pm2
    pm2 startup
fi

# 安装 Nginx
echo ""
echo "📦 安装 Nginx..."
if command -v nginx &> /dev/null; then
    echo "✅ Nginx 已安装"
else
    $PKG_MGR install -y nginx
    systemctl enable nginx
    systemctl start nginx
fi

# 创建部署目录
echo ""
echo "📁 创建部署目录..."
mkdir -p /www
chmod 755 /www

# 配置防火墙 (可选)
echo ""
echo "🔥 配置防火墙..."
if command -v ufw &> /dev/null; then
    ufw allow 22/tcp
    ufw allow 80/tcp
    ufw allow 443/tcp
    ufw allow 3000:9000/tcp
    echo "y" | ufw enable || true
elif command -v firewall-cmd &> /dev/null; then
    firewall-cmd --permanent --add-port=22/tcp
    firewall-cmd --permanent --add-port=80/tcp
    firewall-cmd --permanent --add-port=443/tcp
    firewall-cmd --permanent --add-port=3000-9000/tcp
    firewall-cmd --reload
fi

# 安装 Docker (可选)
echo ""
read -p "是否安装 Docker? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "📦 安装 Docker..."
    if command -v docker &> /dev/null; then
        echo "✅ Docker 已安装"
    else
        curl -fsSL https://get.docker.com | sh
        systemctl enable docker
        systemctl start docker
        usermod -aG docker $USER
    fi
fi

# 安装 Python 环境 (可选)
echo ""
read -p "是否安装 Python 环境? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "📦 安装 Python..."
    $PKG_MGR install -y python3 python3-pip python3-venv
fi

# 安装 Java 环境 (可选)
echo ""
read -p "是否安装 Java 环境? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "📦 安装 Java..."
    if [ "$PKG_MGR" = "apt-get" ]; then
        $PKG_MGR install -y openjdk-17-jdk maven
    else
        $PKG_MGR install -y java-17-openjdk java-17-openjdk-devel maven
    fi
fi

# 显示安装结果
echo ""
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║                    ✅ 初始化完成                          ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""
echo "已安装的组件:"
echo "  • Node.js: $(node -v 2>/dev/null || echo '未安装')"
echo "  • npm: $(npm -v 2>/dev/null || echo '未安装')"
echo "  • PM2: $(pm2 -v 2>/dev/null || echo '未安装')"
echo "  • Nginx: $(nginx -v 2>&1 | cut -d'/' -f2 || echo '未安装')"
echo "  • Docker: $(docker -v 2>/dev/null | cut -d' ' -f3 | tr -d ',' || echo '未安装')"
echo ""
echo "📁 默认部署目录: /www"
echo ""
echo "🔐 请确保 SSH 服务已启动并可访问"
echo ""
