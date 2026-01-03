/**
 * 部署服务
 * 封装部署流程的高级接口
 */

const path = require('path');
const fs = require('fs').promises;
const { createDeployer } = require('./deployers');
const serverConfigService = require('./serverConfig');
const fileManager = require('../utils/fileManager');

class DeployService {
    constructor() {
        this.activeDeploys = new Map();
    }

    /**
     * 执行完整部署流程
     * @param {Object} options - 部署选项
     * @param {string} options.serverId - 服务器配置 ID
     * @param {string} options.projectPath - 项目路径
     * @param {string} options.projectName - 项目名称
     * @param {string} options.projectType - 项目类型
     * @param {string} options.deployPath - 部署目标路径
     * @param {number} options.appPort - 应用端口
     * @param {Function} options.onProgress - 进度回调
     */
    async deploy(options) {
        const {
            serverId,
            projectPath,
            projectName,
            projectType,
            deployPath,
            appPort,
            onProgress
        } = options;

        const deployId = `deploy-${Date.now()}`;

        try {
            this.activeDeploys.set(deployId, {
                status: 'running',
                startTime: Date.now()
            });

            // 1. 获取服务器配置
            const serverConfig = await serverConfigService.getById(serverId);

            // 2. 压缩项目
            onProgress?.({ type: 'info', message: '正在打包项目...' });
            const zipPath = path.join(
                path.dirname(projectPath),
                `${path.basename(projectPath)}.zip`
            );
            await fileManager.compressDirectory(projectPath, zipPath);

            // 3. 创建部署器
            const deployer = createDeployer(serverConfig);
            deployer.onProgress = onProgress;

            // 4. 执行部署
            onProgress?.({ type: 'info', message: `连接到 ${deployer.getPlatformName()}...` });
            await deployer.connect();

            const result = await deployer.deploy(projectPath, {
                deployPath,
                projectType,
                projectName,
                appPort
            });

            await deployer.disconnect();

            // 5. 清理临时文件
            try {
                await fs.unlink(zipPath);
            } catch (e) {
                // 忽略清理错误
            }

            // 6. 记录部署历史
            await this.recordHistory({
                serverId,
                serverName: serverConfig.name,
                projectName,
                projectType,
                deployPath,
                url: result.url,
                success: true,
                elapsedTime: result.elapsedTime
            });

            this.activeDeploys.set(deployId, {
                status: 'completed',
                result
            });

            return result;

        } catch (error) {
            this.activeDeploys.set(deployId, {
                status: 'failed',
                error: error.message
            });

            // 记录失败历史
            const serverConfig = await serverConfigService.getById(serverId).catch(() => null);
            await this.recordHistory({
                serverId,
                serverName: serverConfig?.name || serverId,
                projectName,
                projectType,
                deployPath,
                success: false,
                error: error.message
            });

            throw error;
        }
    }

    /**
     * 记录部署历史
     */
    async recordHistory(record) {
        const historyFile = path.join(__dirname, '../../data/history.json');

        let history = { deployments: [] };
        try {
            const content = await fs.readFile(historyFile, 'utf-8');
            history = JSON.parse(content);
        } catch (e) {
            // 文件不存在，使用默认值
        }

        history.deployments.unshift({
            id: `deploy-${Date.now()}`,
            ...record,
            timestamp: new Date().toISOString()
        });

        // 只保留最近 100 条记录
        if (history.deployments.length > 100) {
            history.deployments = history.deployments.slice(0, 100);
        }

        await fs.writeFile(historyFile, JSON.stringify(history, null, 2));
    }

    /**
     * 获取部署历史
     */
    async getHistory(limit = 20) {
        const historyFile = path.join(__dirname, '../../data/history.json');

        try {
            const content = await fs.readFile(historyFile, 'utf-8');
            const history = JSON.parse(content);
            return history.deployments.slice(0, limit);
        } catch (e) {
            return [];
        }
    }

    /**
     * 获取活动部署状态
     */
    getActiveDeployStatus(deployId) {
        return this.activeDeploys.get(deployId);
    }

    /**
     * 取消部署（如果可能）
     */
    cancelDeploy(deployId) {
        const deploy = this.activeDeploys.get(deployId);
        if (deploy && deploy.status === 'running') {
            deploy.status = 'cancelled';
            return true;
        }
        return false;
    }
}

module.exports = new DeployService();
