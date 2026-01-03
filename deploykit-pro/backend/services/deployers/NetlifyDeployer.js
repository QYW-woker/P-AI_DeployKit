/**
 * NetlifyDeployer - Netlify 平台部署器
 * 使用 Netlify API 进行部署
 */

const BaseDeployer = require('./BaseDeployer');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { glob } = require('glob');

class NetlifyDeployer extends BaseDeployer {
    constructor(config) {
        super(config);
        this.baseUrl = 'https://api.netlify.com/api/v1';
        this.token = config.connection.token;
        this.siteId = config.connection.siteId;
    }

    /**
     * 连接验证
     */
    async connect() {
        this.log('info', '📡 连接 Netlify API...');

        const response = await fetch(`${this.baseUrl}/user`, {
            headers: { 'Authorization': `Bearer ${this.token}` }
        });

        if (!response.ok) {
            throw new Error('Netlify Token 无效');
        }

        const user = await response.json();
        this.log('success', `✓ 已连接，用户: ${user.full_name || user.email}`);
    }

    /**
     * 断开连接
     */
    async disconnect() {
        this.log('info', '连接已断开');
    }

    /**
     * 测试连接
     */
    async testConnection() {
        try {
            const response = await fetch(`${this.baseUrl}/user`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            if (response.ok) {
                const user = await response.json();
                return {
                    success: true,
                    message: '连接成功',
                    details: `用户: ${user.full_name || user.email}`
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
        const { projectName } = options;

        this.startTimer();
        this.log('info', `开始部署到 Netlify`);
        this.log('info', `项目名: ${projectName}`);

        try {
            // 1. 获取或创建站点
            let site = await this.getOrCreateSite(projectName);
            this.log('success', `✓ 站点: ${site.name} (${site.id})`);

            // 2. 准备文件哈希
            this.log('info', '📦 计算文件哈希...');
            const { files, hashes } = await this.prepareFiles(projectPath);
            this.log('success', `✓ 准备了 ${Object.keys(files).length} 个文件`);

            // 3. 创建部署
            this.log('info', '🚀 创建部署...');
            const deploy = await this.createDeploy(site.id, hashes);
            this.log('info', `部署 ID: ${deploy.id}`);

            // 4. 上传必要的文件
            if (deploy.required && deploy.required.length > 0) {
                this.log('info', `📤 上传 ${deploy.required.length} 个文件...`);
                await this.uploadFiles(deploy.id, files, deploy.required);
                this.log('success', '✓ 文件上传完成');
            } else {
                this.log('info', '✓ 所有文件已缓存，无需上传');
            }

            // 5. 等待部署完成
            this.log('info', '⏳ 等待部署完成...');
            const result = await this.waitForDeploy(deploy.id);

            const url = result.ssl_url || result.url;
            this.log('success', `\n🎉 部署成功！耗时: ${this.getElapsedTime()}`);
            this.log('success', `🌐 访问地址: ${url}`);

            return {
                success: true,
                url,
                siteId: site.id,
                siteName: site.name,
                deployId: deploy.id,
                elapsedTime: this.getElapsedTime()
            };
        } catch (error) {
            this.log('error', `❌ Netlify 部署失败: ${error.message}`);
            throw error;
        }
    }

    /**
     * 获取或创建站点
     */
    async getOrCreateSite(projectName) {
        // 如果配置中有站点 ID，直接使用
        if (this.siteId) {
            const response = await fetch(`${this.baseUrl}/sites/${this.siteId}`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            if (response.ok) {
                return response.json();
            }
        }

        // 否则创建新站点
        const siteName = projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-');

        const response = await fetch(`${this.baseUrl}/sites`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: siteName,
                custom_domain: null
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || '创建站点失败');
        }

        return response.json();
    }

    /**
     * 准备文件和哈希
     */
    async prepareFiles(projectPath) {
        const files = {};
        const hashes = {};

        // 获取所有文件
        const allFiles = await glob('**/*', {
            cwd: projectPath,
            nodir: true,
            dot: true,
            ignore: [
                'node_modules/**',
                '.git/**',
                '.netlify/**',
                '.DS_Store',
                '*.log'
            ]
        });

        for (const file of allFiles) {
            const filePath = path.join(projectPath, file);

            try {
                const content = await fs.readFile(filePath);
                const hash = crypto.createHash('sha1').update(content).digest('hex');

                // Netlify 使用 / 开头的路径
                const netlifyPath = '/' + file;
                files[hash] = { path: netlifyPath, content };
                hashes[netlifyPath] = hash;
            } catch (error) {
                this.log('warning', `跳过文件: ${file}`);
            }
        }

        return { files, hashes };
    }

    /**
     * 创建部署
     */
    async createDeploy(siteId, hashes) {
        const response = await fetch(`${this.baseUrl}/sites/${siteId}/deploys`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                files: hashes,
                async: true
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || '创建部署失败');
        }

        return response.json();
    }

    /**
     * 上传文件
     */
    async uploadFiles(deployId, files, requiredHashes) {
        let uploaded = 0;
        const total = requiredHashes.length;

        for (const hash of requiredHashes) {
            const file = files[hash];
            if (!file) continue;

            const response = await fetch(
                `${this.baseUrl}/deploys/${deployId}/files${file.path}`,
                {
                    method: 'PUT',
                    headers: {
                        'Authorization': `Bearer ${this.token}`,
                        'Content-Type': 'application/octet-stream'
                    },
                    body: file.content
                }
            );

            if (!response.ok) {
                this.log('warning', `上传失败: ${file.path}`);
            }

            uploaded++;
            if (uploaded % 10 === 0 || uploaded === total) {
                this.log('info', `上传进度: ${uploaded}/${total}`);
            }
        }
    }

    /**
     * 等待部署完成
     */
    async waitForDeploy(deployId, maxWait = 300000) {
        const startTime = Date.now();
        let lastState = '';

        while (Date.now() - startTime < maxWait) {
            const response = await fetch(`${this.baseUrl}/deploys/${deployId}`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            const deploy = await response.json();

            if (deploy.state !== lastState) {
                lastState = deploy.state;
                this.log('info', `状态: ${this.getStateDescription(deploy.state)}`);
            }

            if (deploy.state === 'ready') {
                return deploy;
            } else if (deploy.state === 'error') {
                throw new Error(deploy.error_message || '部署失败');
            }

            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        throw new Error('部署超时');
    }

    /**
     * 获取状态描述
     */
    getStateDescription(state) {
        const descriptions = {
            'uploading': '上传中...',
            'uploaded': '已上传',
            'processing': '处理中...',
            'prepared': '已准备',
            'building': '构建中...',
            'ready': '就绪',
            'error': '错误'
        };
        return descriptions[state] || state;
    }
}

module.exports = NetlifyDeployer;
