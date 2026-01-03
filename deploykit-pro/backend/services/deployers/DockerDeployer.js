/**
 * DockerDeployer - Docker 容器部署器
 * 通过 SSH 连接到 Docker 主机，构建镜像并运行容器
 */

const BaseDeployer = require('./BaseDeployer');
const { Client } = require('ssh2');
const SftpClient = require('ssh2-sftp-client');
const path = require('path');
const fs = require('fs');

class DockerDeployer extends BaseDeployer {
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
            const result = await this.execCommand('docker --version && docker info --format "{{.ServerVersion}}"', { silent: true });
            await this.disconnect();
            return {
                success: true,
                message: '连接成功',
                details: `Docker ${result.trim()}`
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
        const containerName = projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const imageName = `${containerName}:latest`;

        // 构建本地 zip 路径
        const projectDir = path.basename(projectPath);
        const zipPath = path.join(path.dirname(projectPath), `${projectDir}.zip`);

        this.startTimer();
        this.log('info', `开始 Docker 部署`);
        this.log('info', `项目类型: ${projectType}, 容器名: ${containerName}`);

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

            // 3. 准备项目目录
            this.log('info', '📁 准备项目目录...');
            await this.execCommand(`mkdir -p ${deployPath} && cd ${deployPath} && rm -rf * && unzip -o /tmp/deploy-package.zip`);

            // 处理子目录
            await this.execCommand(`
                cd ${deployPath}
                SUBDIR=$(ls -d */ 2>/dev/null | head -1)
                if [ -n "$SUBDIR" ] && [ -f "\${SUBDIR}package.json" -o -f "\${SUBDIR}Dockerfile" ]; then
                    shopt -s dotglob
                    mv \${SUBDIR}* . 2>/dev/null || true
                    rmdir "$SUBDIR" 2>/dev/null || true
                fi
            `);

            // 4. 检查或生成 Dockerfile
            this.log('info', '🐳 检查 Dockerfile...');
            const hasDockerfile = await this.execCommand(`test -f ${deployPath}/Dockerfile && echo "yes" || echo "no"`, { silent: true });

            if (hasDockerfile.trim() !== 'yes') {
                this.log('info', '📝 生成 Dockerfile...');
                const dockerfile = this.generateDockerfile(projectType, appPort || 3000);
                await this.execCommand(`cat > ${deployPath}/Dockerfile << 'EOF'\n${dockerfile}\nEOF`);
            }

            // 5. 停止并删除旧容器
            this.log('info', '🔄 清理旧容器...');
            await this.execCommand(`docker stop ${containerName} 2>/dev/null || true`);
            await this.execCommand(`docker rm ${containerName} 2>/dev/null || true`);

            // 6. 构建镜像
            this.log('info', '🔨 构建 Docker 镜像...');
            await this.execCommand(`cd ${deployPath} && docker build -t ${imageName} .`);
            this.log('success', '✓ 镜像构建完成');

            // 7. 运行容器
            const hostPort = appPort || 3000;
            this.log('info', `🚀 启动容器 (端口: ${hostPort})...`);
            await this.execCommand(`docker run -d --name ${containerName} -p ${hostPort}:${hostPort} --restart unless-stopped ${imageName}`);

            // 8. 验证容器运行状态
            const containerStatus = await this.execCommand(`docker ps --filter "name=${containerName}" --format "{{.Status}}"`, { silent: true });
            if (!containerStatus.includes('Up')) {
                throw new Error('容器启动失败');
            }

            // 9. 获取访问地址
            const domain = this.config.connection.domain;
            const host = domain || this.config.connection.host;
            // 如果使用域名且端口为80，则不显示端口号
            const url = (domain && hostPort === 80) ? `http://${host}` : `http://${host}:${hostPort}`;

            this.log('success', `\n🎉 Docker 部署成功！耗时: ${this.getElapsedTime()}`);
            this.log('success', `🌐 访问地址: ${url}`);
            this.log('info', `📦 容器名: ${containerName}`);
            this.log('info', `🏷️ 镜像: ${imageName}`);

            return {
                success: true,
                url,
                containerName,
                imageName,
                elapsedTime: this.getElapsedTime()
            };
        } catch (error) {
            this.log('error', `❌ Docker 部署失败: ${error.message}`);
            throw error;
        }
    }

    /**
     * 生成 Dockerfile
     */
    generateDockerfile(projectType, port) {
        const dockerfiles = {
            // 静态前端
            'static': `
FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`,

            // Vue/React
            'vue': `
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`,

            'react': `
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/build /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`,

            // Node.js
            'node': `
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production --legacy-peer-deps
COPY . .
EXPOSE ${port}
ENV PORT=${port}
CMD ["npm", "start"]
`,

            // Java
            'java': `
FROM maven:3.9-eclipse-temurin-17 AS builder
WORKDIR /app
COPY pom.xml .
COPY src ./src
RUN mvn clean package -DskipTests

FROM eclipse-temurin:17-jre-alpine
WORKDIR /app
COPY --from=builder /app/target/*.jar app.jar
EXPOSE ${port}
ENTRYPOINT ["java", "-jar", "app.jar", "--server.port=${port}"]
`,

            // Python
            'python': `
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn
COPY . .
EXPOSE ${port}
CMD ["gunicorn", "-w", "4", "-b", "0.0.0.0:${port}", "app:app"]
`,

            // 自定义
            'custom': `
FROM ubuntu:22.04
WORKDIR /app
COPY . .
RUN chmod +x deploy.sh
EXPOSE ${port}
CMD ["./deploy.sh"]
`
        };

        return (dockerfiles[projectType] || dockerfiles['node']).trim();
    }
}

module.exports = DockerDeployer;
