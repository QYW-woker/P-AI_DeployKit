/**
 * VercelDeployer - Vercel 平台部署器
 * 使用 Vercel API 进行部署
 */

const BaseDeployer = require('./BaseDeployer');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');
const { glob } = require('glob');

class VercelDeployer extends BaseDeployer {
    constructor(config) {
        super(config);
        this.baseUrl = 'https://api.vercel.com';
        this.token = config.connection.token;
        this.teamId = config.connection.teamId;
    }

    /**
     * 连接验证
     */
    async connect() {
        this.log('info', '📡 连接 Vercel API...');

        // 验证 token
        const response = await fetch(`${this.baseUrl}/v2/user`, {
            headers: { 'Authorization': `Bearer ${this.token}` }
        });

        if (!response.ok) {
            throw new Error('Vercel Token 无效');
        }

        const user = await response.json();
        this.log('success', `✓ 已连接，用户: ${user.user.username}`);
    }

    /**
     * 断开连接
     */
    async disconnect() {
        // API 不需要持久连接
        this.log('info', '连接已断开');
    }

    /**
     * 测试连接
     */
    async testConnection() {
        try {
            const response = await fetch(`${this.baseUrl}/v2/user`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            if (response.ok) {
                const user = await response.json();
                return {
                    success: true,
                    message: '连接成功',
                    details: `用户: ${user.user.username}, 邮箱: ${user.user.email}`
                };
            } else {
                return { success: false, message: 'Token 无效' };
            }
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * 执行部署
     */
    async deploy(projectPath, options) {
        const { projectName, framework } = options;

        this.startTimer();
        this.log('info', `开始部署到 Vercel`);
        this.log('info', `项目名: ${projectName}, 框架: ${framework || 'auto'}`);

        try {
            // 1. 准备文件
            this.log('info', '📦 准备文件...');
            const files = await this.prepareFiles(projectPath);
            this.log('success', `✓ 准备了 ${files.length} 个文件`);

            // 2. 创建部署
            this.log('info', '🚀 创建部署...');
            const deployment = await this.createDeployment(projectName, files, framework);
            this.log('success', `✓ 部署已创建: ${deployment.id}`);

            // 3. 等待部署完成
            this.log('info', '⏳ 等待部署完成...');
            const result = await this.waitForDeployment(deployment.id);

            const url = `https://${result.url}`;
            this.log('success', `\n🎉 部署成功！耗时: ${this.getElapsedTime()}`);
            this.log('success', `🌐 访问地址: ${url}`);

            // 返回更多部署信息
            if (result.alias && result.alias.length > 0) {
                this.log('info', `🔗 别名: ${result.alias.join(', ')}`);
            }

            return {
                success: true,
                url,
                deploymentId: deployment.id,
                alias: result.alias,
                elapsedTime: this.getElapsedTime()
            };
        } catch (error) {
            this.log('error', `❌ Vercel 部署失败: ${error.message}`);
            throw error;
        }
    }

    /**
     * 准备上传文件
     */
    async prepareFiles(projectPath) {
        const files = [];

        // 获取所有文件
        const allFiles = await glob('**/*', {
            cwd: projectPath,
            nodir: true,
            dot: true,
            ignore: [
                'node_modules/**',
                '.git/**',
                '.vercel/**',
                '.next/cache/**',
                'dist/**',
                'build/**',
                '.DS_Store',
                '*.log'
            ]
        });

        this.log('info', `扫描到 ${allFiles.length} 个文件`);

        for (const file of allFiles) {
            const filePath = path.join(projectPath, file);

            try {
                const content = await fs.readFile(filePath);
                files.push({
                    file: file,
                    data: content.toString('base64'),
                    encoding: 'base64'
                });
            } catch (error) {
                this.log('warning', `跳过文件: ${file} (${error.message})`);
            }
        }

        return files;
    }

    /**
     * 创建部署
     */
    async createDeployment(projectName, files, framework) {
        const body = {
            name: projectName,
            files: files,
            projectSettings: {}
        };

        // 设置框架
        if (framework) {
            body.projectSettings.framework = framework;
        }

        // 如果有团队 ID
        if (this.teamId) {
            body.teamId = this.teamId;
        }

        const response = await fetch(`${this.baseUrl}/v13/deployments`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error?.message || '部署创建失败');
        }

        return response.json();
    }

    /**
     * 等待部署完成
     */
    async waitForDeployment(deploymentId, maxWait = 300000) {
        const startTime = Date.now();
        let lastState = '';

        while (Date.now() - startTime < maxWait) {
            const response = await fetch(`${this.baseUrl}/v13/deployments/${deploymentId}`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            const deployment = await response.json();

            // 输出状态变化
            if (deployment.readyState !== lastState) {
                lastState = deployment.readyState;
                this.log('info', `状态: ${this.getStateDescription(deployment.readyState)}`);
            }

            if (deployment.readyState === 'READY') {
                return deployment;
            } else if (deployment.readyState === 'ERROR' || deployment.readyState === 'CANCELED') {
                // 获取错误详情
                const errorMessage = deployment.errorMessage || '部署失败';
                throw new Error(errorMessage);
            }

            // 等待 3 秒后重试
            await new Promise(resolve => setTimeout(resolve, 3000));
        }

        throw new Error('部署超时（超过 5 分钟）');
    }

    /**
     * 获取状态描述
     */
    getStateDescription(state) {
        const descriptions = {
            'QUEUED': '排队中...',
            'BUILDING': '构建中...',
            'INITIALIZING': '初始化中...',
            'ANALYZING': '分析中...',
            'DEPLOYING': '部署中...',
            'READY': '就绪',
            'ERROR': '错误',
            'CANCELED': '已取消'
        };
        return descriptions[state] || state;
    }
}

module.exports = VercelDeployer;
