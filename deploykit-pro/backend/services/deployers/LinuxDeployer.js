/**
 * LinuxDeployer - Linux/macOS 服务器部署器
 * 使用 SSH/SFTP 进行文件传输和命令执行
 */

const BaseDeployer = require('./BaseDeployer');
const { Client } = require('ssh2');
const SftpClient = require('ssh2-sftp-client');
const path = require('path');
const fs = require('fs');

class LinuxDeployer extends BaseDeployer {
    constructor(config) {
        super(config);
        this.ssh = null;
        this.sftp = null;
    }

    /**
     * 获取 SSH 连接配置
     */
    getConnectionConfig() {
        const { host, port, username, authType, password, privateKey } = this.config.connection;

        const config = {
            host,
            port: port || 22,
            username,
            readyTimeout: 30000,
            keepaliveInterval: 10000
        };

        if (authType === 'privateKey' && privateKey) {
            config.privateKey = Buffer.from(privateKey, 'base64').toString();
        } else if (password) {
            config.password = Buffer.from(password, 'base64').toString();
        }

        return config;
    }

    /**
     * 建立连接
     */
    async connect() {
        const connConfig = this.getConnectionConfig();

        this.log('info', `正在连接 ${connConfig.host}:${connConfig.port}...`);

        // 建立 SFTP 连接
        this.sftp = new SftpClient();
        await this.sftp.connect(connConfig);

        // 建立 SSH 连接
        this.ssh = new Client();
        await new Promise((resolve, reject) => {
            this.ssh.on('ready', () => {
                this.log('success', '✓ SSH 连接已建立');
                resolve();
            });
            this.ssh.on('error', (err) => {
                reject(new Error(`SSH 连接失败: ${err.message}`));
            });
            this.ssh.connect(connConfig);
        });
    }

    /**
     * 断开连接
     */
    async disconnect() {
        if (this.sftp) {
            try {
                await this.sftp.end();
            } catch (e) {
                // 忽略断开连接的错误
            }
            this.sftp = null;
        }
        if (this.ssh) {
            this.ssh.end();
            this.ssh = null;
        }
        this.log('info', '连接已断开');
    }

    /**
     * 测试连接
     */
    async testConnection() {
        try {
            await this.connect();
            const result = await this.execCommand('echo "连接测试成功" && uname -a');
            await this.disconnect();
            return {
                success: true,
                message: '连接成功',
                details: result.trim()
            };
        } catch (error) {
            return {
                success: false,
                message: error.message
            };
        }
    }

    /**
     * 执行远程命令
     */
    async execCommand(command, options = {}) {
        return new Promise((resolve, reject) => {
            this.ssh.exec(command, (err, stream) => {
                if (err) return reject(err);

                let stdout = '';
                let stderr = '';

                stream.on('data', (data) => {
                    const text = data.toString();
                    stdout += text;
                    if (!options.silent) {
                        text.split('\n').filter(l => l.trim()).forEach(line => {
                            this.log('info', line);
                        });
                    }
                });

                stream.stderr.on('data', (data) => {
                    const text = data.toString();
                    stderr += text;
                    if (!options.silent) {
                        text.split('\n').filter(l => l.trim()).forEach(line => {
                            this.log('warning', line);
                        });
                    }
                });

                stream.on('close', (code) => {
                    if (code === 0) {
                        resolve(stdout);
                    } else {
                        reject(new Error(stderr || `命令退出码: ${code}`));
                    }
                });
            });
        });
    }

    /**
     * 执行部署
     */
    async deploy(projectPath, options) {
        const { deployPath, projectType, projectName, appPort } = options;
        const remoteZipPath = '/tmp/deploy-package.zip';

        // 构建本地 zip 路径
        const projectDir = path.basename(projectPath);
        const zipPath = path.join(path.dirname(projectPath), `${projectDir}.zip`);

        this.startTimer();
        this.log('info', `开始部署到 ${this.getPlatformName()}`);
        this.log('info', `项目类型: ${projectType}, 目标路径: ${deployPath}`);

        try {
            // 1. 检查 ZIP 文件
            if (!fs.existsSync(zipPath)) {
                throw new Error(`ZIP 文件不存在: ${zipPath}`);
            }

            // 2. 上传文件
            this.log('info', '📤 正在上传文件...');
            const stats = fs.statSync(zipPath);
            this.log('info', `文件大小: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

            await this.sftp.put(zipPath, remoteZipPath);
            this.log('success', '✓ 文件上传完成');

            // 3. 执行部署脚本
            const script = this.getDeployScript(projectType, deployPath, appPort, projectName);

            this.log('command', `执行部署脚本 (${projectType})`);
            await this.execCommand(script);

            // 4. 获取访问地址
            const ip = this.config.connection.host;
            const port = appPort || this.getDefaultPort(projectType);
            const url = `http://${ip}:${port}`;

            this.log('success', `\n🎉 部署成功！耗时: ${this.getElapsedTime()}`);
            this.log('success', `🌐 访问地址: ${url}`);

            return {
                success: true,
                url,
                deployPath,
                elapsedTime: this.getElapsedTime()
            };
        } catch (error) {
            this.log('error', `❌ 部署失败: ${error.message}`);
            throw error;
        }
    }

    /**
     * 获取默认端口
     */
    getDefaultPort(projectType) {
        const ports = {
            'static': 80,
            'vue': 80,
            'react': 80,
            'node': 3000,
            'java': 8080,
            'python': 5000,
            'custom': 80
        };
        return ports[projectType] || 80;
    }

    /**
     * 获取部署脚本
     */
    getDeployScript(projectType, deployPath, appPort, projectName) {
        const scripts = {
            // 静态前端
            'static': `
set -e
echo "📁 准备部署目录..."
mkdir -p ${deployPath}
cd ${deployPath}
rm -rf * 2>/dev/null || true

echo "📦 解压文件..."
unzip -o /tmp/deploy-package.zip

# 处理可能的子目录
SUBDIR=$(ls -d */ 2>/dev/null | head -1)
if [ -n "$SUBDIR" ] && [ -f "\${SUBDIR}index.html" ]; then
    echo "📂 检测到子目录，移动文件..."
    mv \${SUBDIR}* . 2>/dev/null || true
    rmdir "$SUBDIR" 2>/dev/null || true
fi

# 配置 Nginx
echo "⚙️ 配置 Nginx..."
cat > /etc/nginx/sites-available/${projectName} << 'NGINX'
server {
    listen ${appPort || 80};
    server_name _;
    root ${deployPath};
    index index.html index.htm;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # 静态资源缓存
    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Gzip 压缩
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;
}
NGINX

ln -sf /etc/nginx/sites-available/${projectName} /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
nginx -t && systemctl reload nginx

echo "✅ 静态站点部署完成"
`,

            // Vue/React 项目
            'vue': `
set -e
echo "📁 准备部署目录..."
mkdir -p ${deployPath}
cd ${deployPath}
rm -rf * .* 2>/dev/null || true

echo "📦 解压文件..."
unzip -o /tmp/deploy-package.zip

# 处理可能的子目录
SUBDIR=$(ls -d */ 2>/dev/null | head -1)
if [ -n "$SUBDIR" ] && [ -f "\${SUBDIR}package.json" ]; then
    echo "📂 检测到子目录，移动文件..."
    shopt -s dotglob
    mv \${SUBDIR}* . 2>/dev/null || true
    rmdir "$SUBDIR" 2>/dev/null || true
fi

echo "📥 安装依赖..."
npm install --legacy-peer-deps --no-audit --no-fund

echo "🔨 构建项目..."
npm run build

# 确定输出目录
DIST_PATH="${deployPath}"
[ -d "dist" ] && DIST_PATH="${deployPath}/dist"
[ -d "build" ] && DIST_PATH="${deployPath}/build"
[ -d ".output/public" ] && DIST_PATH="${deployPath}/.output/public"

echo "📂 构建输出目录: $DIST_PATH"

# 配置 Nginx
echo "⚙️ 配置 Nginx..."
cat > /etc/nginx/sites-available/${projectName} << NGINX
server {
    listen ${appPort || 80};
    server_name _;
    root $DIST_PATH;
    index index.html;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location / {
        try_files \\$uri \\$uri/ /index.html;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/${projectName} /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
nginx -t && systemctl reload nginx

echo "✅ Vue/React 项目部署完成"
`,

            // React (与 Vue 相同)
            'react': `
set -e
echo "📁 准备部署目录..."
mkdir -p ${deployPath}
cd ${deployPath}
rm -rf * .* 2>/dev/null || true

echo "📦 解压文件..."
unzip -o /tmp/deploy-package.zip

# 处理可能的子目录
SUBDIR=$(ls -d */ 2>/dev/null | head -1)
if [ -n "$SUBDIR" ] && [ -f "\${SUBDIR}package.json" ]; then
    shopt -s dotglob
    mv \${SUBDIR}* . 2>/dev/null || true
    rmdir "$SUBDIR" 2>/dev/null || true
fi

echo "📥 安装依赖..."
npm install --legacy-peer-deps --no-audit --no-fund

echo "🔨 构建项目..."
npm run build

# 确定输出目录
DIST_PATH="${deployPath}"
[ -d "dist" ] && DIST_PATH="${deployPath}/dist"
[ -d "build" ] && DIST_PATH="${deployPath}/build"

# 配置 Nginx
cat > /etc/nginx/sites-available/${projectName} << NGINX
server {
    listen ${appPort || 80};
    server_name _;
    root $DIST_PATH;
    index index.html;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location / {
        try_files \\$uri \\$uri/ /index.html;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/${projectName} /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
nginx -t && systemctl reload nginx

echo "✅ React 项目部署完成"
`,

            // Node.js 项目
            'node': `
set -e
echo "📁 准备部署目录..."
mkdir -p ${deployPath}
cd ${deployPath}
rm -rf * .* 2>/dev/null || true

echo "📦 解压文件..."
unzip -o /tmp/deploy-package.zip

# 处理可能的子目录
SUBDIR=$(ls -d */ 2>/dev/null | head -1)
if [ -n "$SUBDIR" ] && [ -f "\${SUBDIR}package.json" ]; then
    shopt -s dotglob
    mv \${SUBDIR}* . 2>/dev/null || true
    rmdir "$SUBDIR" 2>/dev/null || true
fi

echo "📥 安装依赖..."
npm install --production --legacy-peer-deps

echo "🔄 重启服务..."
pm2 delete ${projectName} 2>/dev/null || true
PORT=${appPort || 3000} pm2 start npm --name "${projectName}" -- start
pm2 save

echo "✅ Node.js 项目部署完成"
`,

            // Java 项目
            'java': `
set -e
echo "📁 准备部署目录..."
mkdir -p ${deployPath}
cd ${deployPath}
rm -rf * 2>/dev/null || true

echo "📦 解压文件..."
unzip -o /tmp/deploy-package.zip

# 查找 JAR 文件
JAR_FILE=$(find . -name "*.jar" -type f | head -1)

if [ -z "$JAR_FILE" ] && [ -f "pom.xml" ]; then
    echo "🔨 Maven 构建..."
    mvn clean package -DskipTests
    JAR_FILE=$(find target -name "*.jar" -type f | head -1)
fi

if [ -z "$JAR_FILE" ]; then
    echo "❌ 未找到 JAR 文件"
    exit 1
fi

echo "🚀 启动应用..."
pkill -f "${projectName}" 2>/dev/null || true
nohup java -jar $JAR_FILE --server.port=${appPort || 8080} > app.log 2>&1 &

echo "✅ Java 项目部署完成"
`,

            // Python 项目
            'python': `
set -e
echo "📁 准备部署目录..."
mkdir -p ${deployPath}
cd ${deployPath}
rm -rf * 2>/dev/null || true

echo "📦 解压文件..."
unzip -o /tmp/deploy-package.zip

echo "🐍 创建虚拟环境..."
python3 -m venv venv
source venv/bin/activate

echo "📥 安装依赖..."
if [ -f "requirements.txt" ]; then
    pip install -r requirements.txt
fi
pip install gunicorn

echo "🚀 启动应用..."
pkill -f "gunicorn.*${projectName}" 2>/dev/null || true

# 检测 Django 或 Flask
if [ -f "manage.py" ]; then
    # Django
    gunicorn -w 4 -b 0.0.0.0:${appPort || 5000} $(basename $(find . -name "wsgi.py" | head -1) .py | sed 's/\\//./g'):application --daemon
else
    # Flask
    gunicorn -w 4 -b 0.0.0.0:${appPort || 5000} app:app --daemon
fi

echo "✅ Python 项目部署完成"
`,

            // 自定义脚本
            'custom': `
set -e
echo "📁 准备部署目录..."
mkdir -p ${deployPath}
cd ${deployPath}

echo "📦 解压文件..."
unzip -o /tmp/deploy-package.zip

if [ -f "deploy.sh" ]; then
    echo "🔧 执行自定义部署脚本..."
    chmod +x deploy.sh
    ./deploy.sh ${appPort || 80}
else
    echo "❌ 未找到 deploy.sh 脚本"
    exit 1
fi

echo "✅ 自定义部署完成"
`
        };

        return scripts[projectType] || scripts['static'];
    }
}

module.exports = LinuxDeployer;
