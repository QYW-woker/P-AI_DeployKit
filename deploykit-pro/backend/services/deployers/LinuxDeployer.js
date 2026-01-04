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
     * 列出远程目录内容
     */
    async listRemoteDirectory(remotePath) {
        try {
            const list = await this.sftp.list(remotePath);
            return list.map(item => ({
                name: item.name,
                type: item.type === 'd' ? 'directory' : 'file',
                size: item.size,
                modifyTime: item.modifyTime,
                rights: item.rights
            })).sort((a, b) => {
                // 目录排在前面
                if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
        } catch (error) {
            throw new Error(`无法读取目录 ${remotePath}: ${error.message}`);
        }
    }

    /**
     * 创建远程目录
     */
    async createRemoteDirectory(remotePath) {
        try {
            await this.sftp.mkdir(remotePath, true); // recursive
            return { success: true };
        } catch (error) {
            throw new Error(`无法创建目录 ${remotePath}: ${error.message}`);
        }
    }

    /**
     * 删除远程文件或目录
     */
    async deleteRemotePath(remotePath, isDir = false) {
        try {
            if (isDir) {
                await this.sftp.rmdir(remotePath, true); // recursive
            } else {
                await this.sftp.delete(remotePath);
            }
            return { success: true };
        } catch (error) {
            throw new Error(`无法删除 ${remotePath}: ${error.message}`);
        }
    }

    /**
     * 检测远程目录是否为项目（检查特征文件）
     * 包含完整性检测，识别缺失的必要文件
     */
    async detectProjectInfo(remotePath) {
        try {
            const files = await this.sftp.list(remotePath);
            const fileNames = files.map(f => f.name);
            const dirNames = files.filter(f => f.type === 'd').map(f => f.name);
            const regularFiles = files.filter(f => f.type !== 'd').map(f => f.name);

            const info = {
                isProject: false,
                type: null,
                hasPackageJson: fileNames.includes('package.json'),
                hasDist: fileNames.includes('dist'),
                hasBuild: fileNames.includes('build'),
                hasNodeModules: fileNames.includes('node_modules'),
                hasSrc: fileNames.includes('src'),
                hasIndexHtml: fileNames.includes('index.html'),
                hasPomXml: fileNames.includes('pom.xml'),
                hasRequirementsTxt: fileNames.includes('requirements.txt'),
                files: fileNames.slice(0, 30), // 返回前30个文件名
                directories: dirNames,
                // 完整性检测
                isComplete: true,
                missingFiles: [],
                warnings: [],
                completenessScore: 100
            };

            // 判断项目类型并检测完整性
            if (info.hasPackageJson) {
                info.isProject = true;
                // 尝试读取 package.json 判断具体类型
                try {
                    const pkgContent = await this.sftp.get(`${remotePath}/package.json`);
                    const pkg = JSON.parse(pkgContent.toString());
                    info.projectName = pkg.name;
                    info.version = pkg.version;
                    info.scripts = pkg.scripts ? Object.keys(pkg.scripts) : [];

                    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
                    const depNames = Object.keys(deps);

                    // 判断项目类型
                    if (deps.vue || deps['@vue/cli-service'] || deps['vite'] && deps.vue) {
                        info.type = 'vue';
                        info.framework = deps['@vue/cli-service'] ? 'Vue CLI' :
                                        deps.vite ? 'Vite' : 'Vue';
                    } else if (deps.react || deps['react-scripts'] || deps['next']) {
                        info.type = deps['next'] ? 'node' : 'react';
                        info.framework = deps['next'] ? 'Next.js' :
                                        deps['react-scripts'] ? 'Create React App' : 'React';
                    } else if (deps.express || deps.koa || deps.fastify || deps.nest) {
                        info.type = 'node';
                        info.framework = deps.express ? 'Express' :
                                        deps.koa ? 'Koa' :
                                        deps.fastify ? 'Fastify' : 'Node.js';
                    } else {
                        info.type = 'node';
                        info.framework = 'Node.js';
                    }

                    // 检测 Vue 项目完整性
                    if (info.type === 'vue') {
                        await this.checkVueCompleteness(remotePath, info, pkg, fileNames, dirNames);
                    }
                    // 检测 React 项目完整性
                    else if (info.type === 'react') {
                        await this.checkReactCompleteness(remotePath, info, pkg, fileNames, dirNames);
                    }
                    // 检测 Node.js 项目完整性
                    else if (info.type === 'node') {
                        await this.checkNodeCompleteness(remotePath, info, pkg, fileNames, dirNames);
                    }

                } catch (e) {
                    info.type = 'node';
                    info.warnings.push('无法解析 package.json，可能文件损坏');
                    info.completenessScore -= 20;
                }
            } else if (info.hasPomXml) {
                info.isProject = true;
                info.type = 'java';
                await this.checkJavaCompleteness(remotePath, info, fileNames, dirNames);
            } else if (info.hasRequirementsTxt) {
                info.isProject = true;
                info.type = 'python';
                await this.checkPythonCompleteness(remotePath, info, fileNames, dirNames);
            } else if (info.hasIndexHtml) {
                info.isProject = true;
                info.type = 'static';
                await this.checkStaticCompleteness(remotePath, info, fileNames, dirNames);
            }

            // 判断部署状态
            if (info.isProject) {
                if (info.hasDist || info.hasBuild) {
                    info.status = 'built'; // 已构建
                } else if (info.hasNodeModules) {
                    info.status = 'installed'; // 已安装依赖
                } else {
                    info.status = 'uploaded'; // 仅上传
                }

                // 根据缺失文件判断完整性
                if (info.missingFiles.length > 0) {
                    info.isComplete = false;
                    info.completenessScore = Math.max(0, info.completenessScore - info.missingFiles.length * 15);
                }
            }

            return info;
        } catch (error) {
            return { isProject: false, error: error.message };
        }
    }

    /**
     * 检测 Vue 项目完整性
     */
    async checkVueCompleteness(remotePath, info, pkg, fileNames, dirNames) {
        const requiredFiles = [];
        const optionalFiles = [];

        // 检查入口文件
        if (!dirNames.includes('src')) {
            info.missingFiles.push({
                file: 'src/',
                reason: '源代码目录缺失',
                critical: true,
                fix: '请确保上传了完整的 src 文件夹，包含所有 .vue 文件'
            });
        } else {
            // 检查 src 目录内容
            try {
                const srcFiles = await this.sftp.list(`${remotePath}/src`);
                const srcFileNames = srcFiles.map(f => f.name);

                if (!srcFileNames.includes('main.js') && !srcFileNames.includes('main.ts')) {
                    info.missingFiles.push({
                        file: 'src/main.js 或 src/main.ts',
                        reason: '应用入口文件缺失',
                        critical: true,
                        fix: '这是 Vue 应用的入口文件，必须存在'
                    });
                }

                if (!srcFileNames.includes('App.vue')) {
                    info.missingFiles.push({
                        file: 'src/App.vue',
                        reason: '根组件缺失',
                        critical: true,
                        fix: '这是 Vue 应用的根组件文件'
                    });
                }

                // 检查 assets 目录
                if (!srcFileNames.includes('assets')) {
                    info.warnings.push('缺少 assets 目录，如有静态资源请确认已上传');
                }

                // 检查 components 目录
                if (!srcFileNames.includes('components')) {
                    info.warnings.push('缺少 components 目录');
                }
            } catch (e) {
                info.warnings.push('无法读取 src 目录内容');
            }
        }

        // 检查配置文件
        const hasViteConfig = fileNames.includes('vite.config.js') || fileNames.includes('vite.config.ts');
        const hasVueConfig = fileNames.includes('vue.config.js');

        if (pkg.devDependencies?.vite && !hasViteConfig) {
            info.missingFiles.push({
                file: 'vite.config.js',
                reason: 'Vite 配置文件缺失',
                critical: false,
                fix: '需要 vite.config.js 或 vite.config.ts 配置文件'
            });
        }

        // 检查 public 目录
        if (!dirNames.includes('public')) {
            info.warnings.push('缺少 public 目录，favicon 等资源可能无法正常显示');
        } else {
            try {
                const publicFiles = await this.sftp.list(`${remotePath}/public`);
                const publicFileNames = publicFiles.map(f => f.name);
                if (!publicFileNames.includes('index.html') && !fileNames.includes('index.html')) {
                    // Vite 项目的 index.html 在根目录
                    if (!pkg.devDependencies?.vite || !fileNames.includes('index.html')) {
                        info.missingFiles.push({
                            file: 'index.html',
                            reason: 'HTML 入口文件缺失',
                            critical: true,
                            fix: 'Vue CLI 项目需要 public/index.html，Vite 项目需要根目录 index.html'
                        });
                    }
                }
            } catch (e) {}
        }

        // 对于 Vite 项目检查根目录 index.html
        if (pkg.devDependencies?.vite && !fileNames.includes('index.html')) {
            info.missingFiles.push({
                file: 'index.html',
                reason: 'Vite 项目 HTML 入口文件缺失',
                critical: true,
                fix: 'Vite 项目的 index.html 应该在项目根目录'
            });
        }

        // 检查构建脚本
        if (!pkg.scripts?.build) {
            info.warnings.push('package.json 中没有 build 脚本，可能无法构建');
        }
    }

    /**
     * 检测 React 项目完整性
     */
    async checkReactCompleteness(remotePath, info, pkg, fileNames, dirNames) {
        // 检查 src 目录
        if (!dirNames.includes('src')) {
            info.missingFiles.push({
                file: 'src/',
                reason: '源代码目录缺失',
                critical: true,
                fix: '请确保上传了完整的 src 文件夹'
            });
        } else {
            try {
                const srcFiles = await this.sftp.list(`${remotePath}/src`);
                const srcFileNames = srcFiles.map(f => f.name);

                // 检查入口文件
                const hasIndex = srcFileNames.includes('index.js') ||
                                srcFileNames.includes('index.jsx') ||
                                srcFileNames.includes('index.tsx') ||
                                srcFileNames.includes('main.jsx') ||
                                srcFileNames.includes('main.tsx');

                if (!hasIndex) {
                    info.missingFiles.push({
                        file: 'src/index.js (或 .jsx/.tsx)',
                        reason: '应用入口文件缺失',
                        critical: true,
                        fix: 'React 应用需要入口文件 index.js/jsx/tsx 或 main.jsx/tsx'
                    });
                }

                // 检查根组件
                const hasApp = srcFileNames.includes('App.js') ||
                              srcFileNames.includes('App.jsx') ||
                              srcFileNames.includes('App.tsx');

                if (!hasApp) {
                    info.missingFiles.push({
                        file: 'src/App.js (或 .jsx/.tsx)',
                        reason: '根组件缺失',
                        critical: true,
                        fix: 'React 应用通常需要 App 根组件'
                    });
                }
            } catch (e) {
                info.warnings.push('无法读取 src 目录内容');
            }
        }

        // 检查 public 目录 (Create React App)
        if (pkg.dependencies?.['react-scripts']) {
            if (!dirNames.includes('public')) {
                info.missingFiles.push({
                    file: 'public/',
                    reason: 'Create React App 需要 public 目录',
                    critical: true,
                    fix: '请上传 public 目录，包含 index.html'
                });
            }
        }

        // 检查 Vite React 的 index.html
        if (pkg.devDependencies?.vite && !fileNames.includes('index.html')) {
            info.missingFiles.push({
                file: 'index.html',
                reason: 'Vite React 项目需要根目录 index.html',
                critical: true,
                fix: '请确保 index.html 在项目根目录'
            });
        }
    }

    /**
     * 检测 Node.js 项目完整性
     */
    async checkNodeCompleteness(remotePath, info, pkg, fileNames, dirNames) {
        // 检查入口文件
        const mainFile = pkg.main || 'index.js';

        if (!fileNames.includes(mainFile) && !fileNames.includes('server.js') && !fileNames.includes('app.js')) {
            info.missingFiles.push({
                file: mainFile,
                reason: `入口文件缺失 (package.json main: ${mainFile})`,
                critical: true,
                fix: `请确保上传了入口文件 ${mainFile}，或者 server.js / app.js`
            });
        }

        // 检查启动脚本
        if (!pkg.scripts?.start) {
            info.warnings.push('package.json 中没有 start 脚本');
        }

        // 对于 TypeScript 项目检查 tsconfig
        if (pkg.devDependencies?.typescript && !fileNames.includes('tsconfig.json')) {
            info.missingFiles.push({
                file: 'tsconfig.json',
                reason: 'TypeScript 配置文件缺失',
                critical: false,
                fix: 'TypeScript 项目需要 tsconfig.json 配置'
            });
        }
    }

    /**
     * 检测 Java 项目完整性
     */
    async checkJavaCompleteness(remotePath, info, fileNames, dirNames) {
        // 检查 src 目录
        if (!dirNames.includes('src')) {
            info.missingFiles.push({
                file: 'src/',
                reason: 'Java 源代码目录缺失',
                critical: true,
                fix: '请上传完整的 src 目录结构 (src/main/java/...)'
            });
        } else {
            try {
                const srcFiles = await this.sftp.list(`${remotePath}/src`);
                const srcDirNames = srcFiles.filter(f => f.type === 'd').map(f => f.name);

                if (!srcDirNames.includes('main')) {
                    info.missingFiles.push({
                        file: 'src/main/',
                        reason: 'Maven 标准结构 src/main 目录缺失',
                        critical: true,
                        fix: '请确保使用 Maven 标准项目结构'
                    });
                }
            } catch (e) {}
        }

        // 尝试解析 pom.xml 获取项目信息
        try {
            const pomContent = await this.sftp.get(`${remotePath}/pom.xml`);
            const pomStr = pomContent.toString();

            // 简单提取项目名
            const artifactMatch = pomStr.match(/<artifactId>([^<]+)<\/artifactId>/);
            if (artifactMatch) {
                info.projectName = artifactMatch[1];
            }

            const versionMatch = pomStr.match(/<version>([^<]+)<\/version>/);
            if (versionMatch) {
                info.version = versionMatch[1];
            }

            info.framework = 'Maven';

            // 检查是否是 Spring Boot
            if (pomStr.includes('spring-boot')) {
                info.framework = 'Spring Boot';
            }
        } catch (e) {
            info.warnings.push('无法解析 pom.xml');
        }
    }

    /**
     * 检测 Python 项目完整性
     */
    async checkPythonCompleteness(remotePath, info, fileNames, dirNames) {
        // 检查入口文件
        const hasApp = fileNames.includes('app.py') || fileNames.includes('main.py') || fileNames.includes('manage.py');

        if (!hasApp) {
            info.missingFiles.push({
                file: 'app.py 或 main.py',
                reason: 'Python 入口文件缺失',
                critical: true,
                fix: '请确保有 app.py、main.py 或 manage.py (Django) 入口文件'
            });
        }

        // 检查 Django 项目
        if (fileNames.includes('manage.py')) {
            info.framework = 'Django';

            // Django 项目应该有同名配置目录
            const hasConfigDir = dirNames.some(d =>
                fileNames.includes('manage.py') // 检测是否有包含 settings.py 的目录
            );
        } else if (fileNames.includes('app.py')) {
            info.framework = 'Flask';
        }

        // 检查 requirements.txt 内容
        try {
            const reqContent = await this.sftp.get(`${remotePath}/requirements.txt`);
            const reqStr = reqContent.toString();

            if (reqStr.includes('django') || reqStr.includes('Django')) {
                info.framework = 'Django';
            } else if (reqStr.includes('flask') || reqStr.includes('Flask')) {
                info.framework = 'Flask';
            } else if (reqStr.includes('fastapi') || reqStr.includes('FastAPI')) {
                info.framework = 'FastAPI';
            }
        } catch (e) {}
    }

    /**
     * 检测静态网站完整性
     */
    async checkStaticCompleteness(remotePath, info, fileNames, dirNames) {
        info.framework = 'Static HTML';
        info.projectName = 'Static Website';

        // 检查 CSS
        const hasCSS = fileNames.some(f => f.endsWith('.css')) || dirNames.includes('css') || dirNames.includes('styles');
        if (!hasCSS) {
            info.warnings.push('未检测到 CSS 文件，页面可能没有样式');
        }

        // 检查 JS
        const hasJS = fileNames.some(f => f.endsWith('.js')) || dirNames.includes('js') || dirNames.includes('scripts');
        if (!hasJS) {
            info.warnings.push('未检测到 JavaScript 文件');
        }

        // 检查 assets/images
        const hasAssets = dirNames.includes('assets') || dirNames.includes('images') || dirNames.includes('img');
        if (!hasAssets) {
            info.warnings.push('未检测到资源文件夹 (assets/images)');
        }
    }

    /**
     * 对已存在的远程项目执行部署（不需要重新上传）
     */
    async deployExisting(options) {
        const { deployPath, projectType, projectName, appPort, projectDomain } = options;

        this.startTimer();
        this.log('info', `开始部署已存在的项目到 ${this.getPlatformName()}`);
        this.log('info', `项目路径: ${deployPath}, 类型: ${projectType}`);

        try {
            // 获取部署脚本（针对已存在项目，跳过上传解压步骤）
            const script = this.getExistingDeployScript(projectType, deployPath, appPort, projectName);

            this.log('command', `执行部署脚本 (${projectType})`);
            await this.execCommand(script);

            // 获取访问地址（优先级：项目域名 > 服务器域名 > IP）
            const url = this.generateAccessUrl(appPort, projectType, projectDomain);

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
     * 生成访问地址（优先级：项目域名 > 服务器域名 > IP地址）
     * @param {number} appPort - 应用端口
     * @param {string} projectType - 项目类型
     * @param {string} projectDomain - 项目级别的域名（可选）
     */
    generateAccessUrl(appPort, projectType, projectDomain) {
        const port = appPort || this.getDefaultPort(projectType);
        // 优先级：项目域名 > 服务器域名 > IP地址
        const host = projectDomain || this.config.connection.domain || this.config.connection.host;

        // 如果是 80 端口，不显示端口号
        if (port === 80 || port === '80') {
            return `http://${host}`;
        }
        // 如果是 443 端口，使用 https 且不显示端口号
        if (port === 443 || port === '443') {
            return `https://${host}`;
        }

        return `http://${host}:${port}`;
    }

    /**
     * 获取已存在项目的部署脚本（跳过上传解压）
     */
    getExistingDeployScript(projectType, deployPath, appPort, projectName) {
        const scripts = {
            'static': `
set -e
cd ${deployPath}
echo "📂 使用已存在的静态文件..."

# 确定静态文件目录
STATIC_PATH="${deployPath}"
[ -d "dist" ] && STATIC_PATH="${deployPath}/dist"
[ -d "build" ] && STATIC_PATH="${deployPath}/build"

# 配置 Nginx
echo "⚙️ 配置 Nginx..."
cat > /etc/nginx/sites-available/${projectName} << NGINX
server {
    listen ${appPort || 80};
    server_name _;
    root $STATIC_PATH;
    index index.html index.htm;

    location / {
        try_files \\$uri \\$uri/ /index.html;
    }

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;
}
NGINX

ln -sf /etc/nginx/sites-available/${projectName} /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
nginx -t && systemctl reload nginx

echo "✅ 静态站点部署完成"
`,

            'vue': `
set -e
cd ${deployPath}
echo "📂 使用已存在的 Vue 项目..."

# 检查是否需要安装依赖
if [ ! -d "node_modules" ]; then
    echo "📥 安装依赖..."
    npm install --legacy-peer-deps --no-audit --no-fund
fi

# 检查是否需要构建
if [ ! -d "dist" ] && [ ! -d "build" ]; then
    echo "🔨 构建项目..."
    npm run build
fi

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

echo "✅ Vue 项目部署完成"
`,

            'react': `
set -e
cd ${deployPath}
echo "📂 使用已存在的 React 项目..."

if [ ! -d "node_modules" ]; then
    echo "📥 安装依赖..."
    npm install --legacy-peer-deps --no-audit --no-fund
fi

if [ ! -d "dist" ] && [ ! -d "build" ]; then
    echo "🔨 构建项目..."
    npm run build
fi

DIST_PATH="${deployPath}"
[ -d "dist" ] && DIST_PATH="${deployPath}/dist"
[ -d "build" ] && DIST_PATH="${deployPath}/build"

cat > /etc/nginx/sites-available/${projectName} << NGINX
server {
    listen ${appPort || 80};
    server_name _;
    root $DIST_PATH;
    index index.html;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

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

            'node': `
set -e
cd ${deployPath}
echo "📂 使用已存在的 Node.js 项目..."

if [ ! -d "node_modules" ]; then
    echo "📥 安装依赖..."
    npm install --production --legacy-peer-deps
fi

echo "🔄 重启服务..."
pm2 delete ${projectName} 2>/dev/null || true
PORT=${appPort || 3000} pm2 start npm --name "${projectName}" -- start
pm2 save

echo "✅ Node.js 项目部署完成"
`
        };

        return scripts[projectType] || scripts['static'];
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
        const { deployPath, projectType, projectName, appPort, projectDomain } = options;
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

            // 4. 获取访问地址（优先级：项目域名 > 服务器域名 > IP）
            const url = this.generateAccessUrl(appPort, projectType, projectDomain);

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

    /**
     * 获取服务状态
     * @param {string} projectPath - 项目路径
     * @param {string} projectType - 项目类型
     * @param {string} projectName - 项目名称
     */
    async getServiceStatus(projectPath, projectType, projectName) {
        try {
            let status = {
                running: false,
                type: null,
                details: null,
                port: null,
                pid: null
            };

            // 检查 PM2 进程 (Node.js 项目)
            try {
                const pm2Result = await this.execCommand(`pm2 jlist 2>/dev/null || echo "[]"`, { silent: true });
                const pm2List = JSON.parse(pm2Result.trim() || '[]');
                const pm2Process = pm2List.find(p => p.name === projectName);

                if (pm2Process) {
                    status.running = pm2Process.pm2_env?.status === 'online';
                    status.type = 'pm2';
                    status.pid = pm2Process.pid;
                    status.details = {
                        name: pm2Process.name,
                        status: pm2Process.pm2_env?.status,
                        uptime: pm2Process.pm2_env?.pm_uptime,
                        restarts: pm2Process.pm2_env?.restart_time,
                        memory: pm2Process.monit?.memory
                    };
                    return status;
                }
            } catch (e) {}

            // 检查 Nginx 配置
            try {
                const nginxCheck = await this.execCommand(
                    `test -f /etc/nginx/sites-enabled/${projectName} && echo "exists" || echo "none"`,
                    { silent: true }
                );

                if (nginxCheck.trim() === 'exists') {
                    // 检查 Nginx 是否运行
                    const nginxStatus = await this.execCommand(`systemctl is-active nginx 2>/dev/null || echo "inactive"`, { silent: true });
                    status.running = nginxStatus.trim() === 'active';
                    status.type = 'nginx';

                    // 获取端口
                    try {
                        const portResult = await this.execCommand(
                            `grep -oP 'listen\\s+\\K[0-9]+' /etc/nginx/sites-enabled/${projectName} | head -1`,
                            { silent: true }
                        );
                        status.port = portResult.trim() || '80';
                    } catch (e) {
                        status.port = '80';
                    }

                    status.details = {
                        configFile: `/etc/nginx/sites-enabled/${projectName}`
                    };
                    return status;
                }
            } catch (e) {}

            // 检查端口占用
            try {
                const portCheck = await this.execCommand(
                    `lsof -i -P -n 2>/dev/null | grep -E "LISTEN.*:(80|3000|8080|${projectName})" | head -5 || echo ""`,
                    { silent: true }
                );
                if (portCheck.trim()) {
                    status.details = { portInfo: portCheck.trim() };
                }
            } catch (e) {}

            return status;
        } catch (error) {
            return { running: false, error: error.message };
        }
    }

    /**
     * 停止服务
     * @param {string} projectPath - 项目路径
     * @param {string} projectType - 项目类型
     * @param {string} projectName - 项目名称
     * @param {number} port - 端口号
     */
    async stopService(projectPath, projectType, projectName, port) {
        this.log('info', `🛑 正在停止服务: ${projectName}`);

        const results = {
            pm2Stopped: false,
            nginxStopped: false,
            portKilled: false,
            messages: []
        };

        // 1. 尝试停止 PM2 进程
        try {
            const pm2Check = await this.execCommand(`pm2 describe ${projectName} 2>/dev/null && echo "found" || echo "notfound"`, { silent: true });
            if (pm2Check.includes('found') && !pm2Check.includes('notfound')) {
                await this.execCommand(`pm2 stop ${projectName} 2>/dev/null || true`);
                await this.execCommand(`pm2 delete ${projectName} 2>/dev/null || true`);
                results.pm2Stopped = true;
                results.messages.push(`✓ PM2 进程 "${projectName}" 已停止`);
                this.log('success', `✓ PM2 进程 "${projectName}" 已停止`);
            }
        } catch (e) {
            // PM2 进程不存在，忽略
        }

        // 2. 移除 Nginx 配置
        try {
            const nginxExists = await this.execCommand(
                `test -f /etc/nginx/sites-enabled/${projectName} && echo "exists" || echo "none"`,
                { silent: true }
            );

            if (nginxExists.trim() === 'exists') {
                await this.execCommand(`rm -f /etc/nginx/sites-enabled/${projectName}`);
                await this.execCommand(`rm -f /etc/nginx/sites-available/${projectName}`);
                await this.execCommand(`nginx -t && systemctl reload nginx`);
                results.nginxStopped = true;
                results.messages.push(`✓ Nginx 配置已移除`);
                this.log('success', `✓ Nginx 配置已移除`);
            }
        } catch (e) {
            results.messages.push(`⚠️ Nginx 配置移除失败: ${e.message}`);
        }

        // 3. 杀死占用端口的进程
        if (port) {
            try {
                const portPid = await this.execCommand(
                    `lsof -ti:${port} 2>/dev/null || echo ""`,
                    { silent: true }
                );

                if (portPid.trim()) {
                    await this.execCommand(`kill -9 ${portPid.trim()} 2>/dev/null || true`);
                    results.portKilled = true;
                    results.messages.push(`✓ 端口 ${port} 上的进程已终止`);
                    this.log('success', `✓ 端口 ${port} 上的进程已终止`);
                }
            } catch (e) {
                // 端口没有被占用，忽略
            }
        }

        if (results.messages.length === 0) {
            results.messages.push('未发现运行中的服务');
            this.log('info', '未发现运行中的服务');
        }

        this.log('success', '🛑 服务停止操作完成');
        return results;
    }

    /**
     * 启动服务
     * @param {string} projectPath - 项目路径
     * @param {string} projectType - 项目类型
     * @param {string} projectName - 项目名称
     * @param {number} port - 端口号
     */
    async startService(projectPath, projectType, projectName, port) {
        this.log('info', `🚀 正在启动服务: ${projectName}`);
        this.log('info', `项目路径: ${projectPath}, 类型: ${projectType}, 端口: ${port}`);

        try {
            // 根据项目类型启动服务
            if (['static', 'vue', 'react'].includes(projectType)) {
                // 静态站点使用 Nginx
                const script = this.getExistingDeployScript(projectType, projectPath, port, projectName);
                await this.execCommand(script);
                this.log('success', '✅ Nginx 服务已配置并启动');
            } else if (projectType === 'node') {
                // Node.js 项目使用 PM2
                await this.execCommand(`cd ${projectPath} && PORT=${port} pm2 start npm --name "${projectName}" -- start`);
                await this.execCommand('pm2 save');
                this.log('success', '✅ PM2 服务已启动');
            } else if (projectType === 'python') {
                // Python 项目
                await this.execCommand(`cd ${projectPath} && pm2 start "python app.py" --name "${projectName}" 2>/dev/null || pm2 start "python main.py" --name "${projectName}"`);
                await this.execCommand('pm2 save');
                this.log('success', '✅ Python 服务已启动');
            } else {
                // 默认尝试使用 PM2
                await this.execCommand(`cd ${projectPath} && pm2 start npm --name "${projectName}" -- start`);
                await this.execCommand('pm2 save');
                this.log('success', '✅ 服务已启动');
            }

            // 获取访问地址
            const host = this.config.connection.domain || this.config.connection.host;
            const url = port == 80 ? `http://${host}` : `http://${host}:${port}`;

            this.log('success', `🌐 访问地址: ${url}`);

            return {
                success: true,
                url,
                message: '服务启动成功'
            };
        } catch (error) {
            this.log('error', `❌ 服务启动失败: ${error.message}`);
            throw error;
        }
    }

    /**
     * 重启服务
     */
    async restartService(projectPath, projectType, projectName, port) {
        this.log('info', `🔄 正在重启服务: ${projectName}`);

        await this.stopService(projectPath, projectType, projectName, port);
        await new Promise(resolve => setTimeout(resolve, 1000)); // 等待1秒
        return await this.startService(projectPath, projectType, projectName, port);
    }
}

module.exports = LinuxDeployer;
