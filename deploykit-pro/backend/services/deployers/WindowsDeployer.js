/**
 * WindowsDeployer - Windows Server 部署器
 * 使用 SSH/SFTP 进行文件传输，PowerShell 执行命令
 */

const BaseDeployer = require('./BaseDeployer');
const { Client } = require('ssh2');
const SftpClient = require('ssh2-sftp-client');
const path = require('path');
const fs = require('fs');

class WindowsDeployer extends BaseDeployer {
    constructor(config) {
        super(config);
        this.ssh = null;
        this.sftp = null;
    }

    /**
     * 获取 SSH 连接配置
     */
    getConnectionConfig() {
        const { host, port, username, password, privateKey, authType } = this.config.connection;

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
            const result = await this.execCommand('echo "连接测试成功" && hostname');
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
    async execCommand(command) {
        return new Promise((resolve, reject) => {
            this.ssh.exec(command, (err, stream) => {
                if (err) return reject(err);

                let output = '';

                stream.on('data', (data) => {
                    const text = data.toString();
                    output += text;
                    text.split('\n').filter(l => l.trim()).forEach(line => {
                        this.log('info', line);
                    });
                });

                stream.stderr.on('data', (data) => {
                    const text = data.toString();
                    text.split('\n').filter(l => l.trim()).forEach(line => {
                        this.log('warning', line);
                    });
                });

                stream.on('close', (code) => {
                    resolve(output);
                });
            });
        });
    }

    /**
     * 执行 PowerShell 脚本
     */
    async execPowerShell(script) {
        // 将多行脚本转为单行命令
        const escapedScript = script
            .replace(/\r\n/g, '\n')
            .replace(/"/g, '\\"')
            .replace(/\n/g, '; ');

        const command = `powershell -Command "${escapedScript}"`;
        return this.execCommand(command);
    }

    /**
     * 执行部署
     */
    async deploy(projectPath, options) {
        const { deployPath, projectType, projectName, appPort } = options;
        const remoteZipPath = 'C:\\temp\\deploy-package.zip';

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

            // 2. 创建临时目录
            this.log('info', '📁 创建临时目录...');
            await this.execCommand('if not exist C:\\temp mkdir C:\\temp');

            // 3. 上传文件
            this.log('info', '📤 正在上传文件...');
            const stats = fs.statSync(zipPath);
            this.log('info', `文件大小: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

            await this.sftp.put(zipPath, remoteZipPath);
            this.log('success', '✓ 文件上传完成');

            // 4. 执行部署脚本
            const script = this.getDeployScript(projectType, deployPath, appPort, projectName);

            this.log('command', `执行部署脚本 (${projectType})`);
            await this.execPowerShell(script);

            // 5. 获取访问地址
            const domain = this.config.connection.domain;
            const host = domain || this.config.connection.host;
            const port = appPort || this.getDefaultPort(projectType);
            // 如果使用域名且端口为80，则不显示端口号
            const url = (domain && port === 80) ? `http://${host}` : `http://${host}:${port}`;

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
     * 获取部署脚本 (PowerShell)
     */
    getDeployScript(projectType, deployPath, appPort, projectName) {
        const scripts = {
            // 静态前端 (IIS)
            'static': `
$ErrorActionPreference = 'Stop'
$DeployPath = '${deployPath}'
$AppPort = ${appPort || 80}
$ProjectName = '${projectName}'

Write-Host '📁 准备部署目录...'
New-Item -ItemType Directory -Force -Path $DeployPath | Out-Null
Set-Location $DeployPath
Remove-Item -Path * -Recurse -Force -ErrorAction SilentlyContinue

Write-Host '📦 解压文件...'
Expand-Archive -Path 'C:\\temp\\deploy-package.zip' -DestinationPath $DeployPath -Force

# 处理子目录
$subDir = Get-ChildItem -Directory | Select-Object -First 1
if ($subDir -and (Test-Path (Join-Path $subDir.FullName 'index.html'))) {
    Write-Host '📂 移动子目录内容...'
    Get-ChildItem $subDir.FullName | Move-Item -Destination $DeployPath -Force
    Remove-Item $subDir.FullName -Force
}

Write-Host '⚙️ 配置 IIS...'
Import-Module WebAdministration -ErrorAction SilentlyContinue

# 删除已存在的站点
if (Get-Website -Name $ProjectName -ErrorAction SilentlyContinue) {
    Remove-Website -Name $ProjectName
}

# 创建新站点
New-Website -Name $ProjectName -Port $AppPort -PhysicalPath $DeployPath -Force

Write-Host '✅ 静态站点部署完成'
`,

            // Vue/React 项目
            'vue': `
$ErrorActionPreference = 'Stop'
$DeployPath = '${deployPath}'
$AppPort = ${appPort || 80}
$ProjectName = '${projectName}'

Write-Host '📁 准备部署目录...'
New-Item -ItemType Directory -Force -Path $DeployPath | Out-Null
Set-Location $DeployPath
Remove-Item -Path * -Recurse -Force -ErrorAction SilentlyContinue

Write-Host '📦 解压文件...'
Expand-Archive -Path 'C:\\temp\\deploy-package.zip' -DestinationPath $DeployPath -Force

# 处理子目录
$subDir = Get-ChildItem -Directory | Select-Object -First 1
if ($subDir -and (Test-Path (Join-Path $subDir.FullName 'package.json'))) {
    Write-Host '📂 移动子目录内容...'
    Get-ChildItem $subDir.FullName -Force | Move-Item -Destination $DeployPath -Force
    Remove-Item $subDir.FullName -Force -ErrorAction SilentlyContinue
}

Write-Host '📥 安装依赖...'
npm install --legacy-peer-deps --no-audit --no-fund

Write-Host '🔨 构建项目...'
npm run build

# 确定输出目录
$distPath = $DeployPath
if (Test-Path 'dist') { $distPath = Join-Path $DeployPath 'dist' }
elseif (Test-Path 'build') { $distPath = Join-Path $DeployPath 'build' }

Write-Host "📂 构建输出目录: $distPath"

Write-Host '⚙️ 配置 IIS...'
Import-Module WebAdministration -ErrorAction SilentlyContinue

if (Get-Website -Name $ProjectName -ErrorAction SilentlyContinue) {
    Remove-Website -Name $ProjectName
}

New-Website -Name $ProjectName -Port $AppPort -PhysicalPath $distPath -Force

Write-Host '✅ Vue/React 项目部署完成'
`,

            // React (与 Vue 相同)
            'react': `
$ErrorActionPreference = 'Stop'
$DeployPath = '${deployPath}'
$AppPort = ${appPort || 80}
$ProjectName = '${projectName}'

New-Item -ItemType Directory -Force -Path $DeployPath | Out-Null
Set-Location $DeployPath
Remove-Item -Path * -Recurse -Force -ErrorAction SilentlyContinue

Expand-Archive -Path 'C:\\temp\\deploy-package.zip' -DestinationPath $DeployPath -Force

$subDir = Get-ChildItem -Directory | Select-Object -First 1
if ($subDir -and (Test-Path (Join-Path $subDir.FullName 'package.json'))) {
    Get-ChildItem $subDir.FullName -Force | Move-Item -Destination $DeployPath -Force
    Remove-Item $subDir.FullName -Force -ErrorAction SilentlyContinue
}

npm install --legacy-peer-deps --no-audit --no-fund
npm run build

$distPath = $DeployPath
if (Test-Path 'dist') { $distPath = Join-Path $DeployPath 'dist' }
elseif (Test-Path 'build') { $distPath = Join-Path $DeployPath 'build' }

Import-Module WebAdministration -ErrorAction SilentlyContinue
if (Get-Website -Name $ProjectName -ErrorAction SilentlyContinue) {
    Remove-Website -Name $ProjectName
}
New-Website -Name $ProjectName -Port $AppPort -PhysicalPath $distPath -Force

Write-Host '✅ React 项目部署完成'
`,

            // Node.js 项目
            'node': `
$ErrorActionPreference = 'Stop'
$DeployPath = '${deployPath}'
$AppPort = ${appPort || 3000}
$ProjectName = '${projectName}'

Write-Host '📁 准备部署目录...'
New-Item -ItemType Directory -Force -Path $DeployPath | Out-Null
Set-Location $DeployPath
Remove-Item -Path * -Recurse -Force -ErrorAction SilentlyContinue

Write-Host '📦 解压文件...'
Expand-Archive -Path 'C:\\temp\\deploy-package.zip' -DestinationPath $DeployPath -Force

# 处理子目录
$subDir = Get-ChildItem -Directory | Select-Object -First 1
if ($subDir -and (Test-Path (Join-Path $subDir.FullName 'package.json'))) {
    Get-ChildItem $subDir.FullName -Force | Move-Item -Destination $DeployPath -Force
    Remove-Item $subDir.FullName -Force -ErrorAction SilentlyContinue
}

Write-Host '📥 安装依赖...'
npm install --production --legacy-peer-deps

Write-Host '🔄 重启服务...'
pm2 delete $ProjectName 2>$null
$env:PORT = $AppPort
pm2 start npm --name $ProjectName -- start
pm2 save

Write-Host '✅ Node.js 项目部署完成'
`,

            // Java 项目
            'java': `
$ErrorActionPreference = 'Stop'
$DeployPath = '${deployPath}'
$AppPort = ${appPort || 8080}
$ProjectName = '${projectName}'

New-Item -ItemType Directory -Force -Path $DeployPath | Out-Null
Set-Location $DeployPath
Remove-Item -Path * -Recurse -Force -ErrorAction SilentlyContinue

Expand-Archive -Path 'C:\\temp\\deploy-package.zip' -DestinationPath $DeployPath -Force

# 查找 JAR 文件
$jarFile = Get-ChildItem -Path . -Filter '*.jar' -Recurse | Select-Object -First 1

if (-not $jarFile -and (Test-Path 'pom.xml')) {
    Write-Host '🔨 Maven 构建...'
    mvn clean package -DskipTests
    $jarFile = Get-ChildItem -Path 'target' -Filter '*.jar' | Select-Object -First 1
}

if (-not $jarFile) {
    throw '未找到 JAR 文件'
}

Write-Host '🚀 启动应用...'
Get-Process -Name java -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*${projectName}*" } | Stop-Process -Force
Start-Process -FilePath 'java' -ArgumentList "-jar", $jarFile.FullName, "--server.port=$AppPort" -NoNewWindow

Write-Host '✅ Java 项目部署完成'
`,

            // Python 项目
            'python': `
$ErrorActionPreference = 'Stop'
$DeployPath = '${deployPath}'
$AppPort = ${appPort || 5000}
$ProjectName = '${projectName}'

New-Item -ItemType Directory -Force -Path $DeployPath | Out-Null
Set-Location $DeployPath
Remove-Item -Path * -Recurse -Force -ErrorAction SilentlyContinue

Expand-Archive -Path 'C:\\temp\\deploy-package.zip' -DestinationPath $DeployPath -Force

Write-Host '🐍 创建虚拟环境...'
python -m venv venv
.\\venv\\Scripts\\Activate.ps1

Write-Host '📥 安装依赖...'
if (Test-Path 'requirements.txt') {
    pip install -r requirements.txt
}
pip install waitress

Write-Host '🚀 启动应用...'
Start-Process -FilePath '.\\venv\\Scripts\\python.exe' -ArgumentList '-m', 'waitress', '--port=$AppPort', 'app:app' -NoNewWindow

Write-Host '✅ Python 项目部署完成'
`,

            // 自定义脚本
            'custom': `
$ErrorActionPreference = 'Stop'
$DeployPath = '${deployPath}'
$AppPort = ${appPort || 80}

New-Item -ItemType Directory -Force -Path $DeployPath | Out-Null
Set-Location $DeployPath

Expand-Archive -Path 'C:\\temp\\deploy-package.zip' -DestinationPath $DeployPath -Force

if (Test-Path 'deploy.ps1') {
    Write-Host '🔧 执行自定义部署脚本...'
    .\\deploy.ps1 -Port $AppPort
} else {
    throw '未找到 deploy.ps1 脚本'
}

Write-Host '✅ 自定义部署完成'
`
        };

        return scripts[projectType] || scripts['static'];
    }
}

module.exports = WindowsDeployer;
