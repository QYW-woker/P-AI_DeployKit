/**
 * BaseDeployer - 所有部署器的基类
 * 定义通用接口和辅助方法
 */

class BaseDeployer {
    constructor(config) {
        this.config = config;
        this.onProgress = null;
        this.startTime = null;
    }

    /**
     * 连接到目标平台
     * @abstract
     */
    async connect() {
        throw new Error('子类必须实现 connect() 方法');
    }

    /**
     * 执行部署
     * @abstract
     * @param {string} projectPath - 本地项目路径
     * @param {Object} options - 部署选项
     */
    async deploy(projectPath, options) {
        throw new Error('子类必须实现 deploy() 方法');
    }

    /**
     * 断开连接
     * @abstract
     */
    async disconnect() {
        throw new Error('子类必须实现 disconnect() 方法');
    }

    /**
     * 测试连接
     * @abstract
     */
    async testConnection() {
        throw new Error('子类必须实现 testConnection() 方法');
    }

    /**
     * 输出日志
     * @param {string} type - 日志类型: info | success | warning | error | command
     * @param {string} message - 日志消息
     */
    log(type, message) {
        const logEntry = {
            type,
            message,
            timestamp: Date.now()
        };

        if (this.onProgress) {
            this.onProgress(logEntry);
        }

        // 同时输出到控制台
        const prefix = {
            info: '📋',
            success: '✅',
            warning: '⚠️',
            error: '❌',
            command: '💻'
        }[type] || '📋';

        console.log(`${prefix} [${this.config.type}] ${message}`);
    }

    /**
     * 开始计时
     */
    startTimer() {
        this.startTime = Date.now();
    }

    /**
     * 获取耗时
     * @returns {string} 格式化的耗时字符串
     */
    getElapsedTime() {
        if (!this.startTime) return '0s';
        const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
        if (elapsed < 60) return `${elapsed}s`;
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        return `${minutes}m ${seconds}s`;
    }

    /**
     * 获取平台名称
     * @returns {string}
     */
    getPlatformName() {
        const names = {
            'linux': 'Linux',
            'windows': 'Windows Server',
            'macos': 'macOS',
            'docker': 'Docker',
            'vercel': 'Vercel',
            'netlify': 'Netlify',
            'aliyun-oss': '阿里云 OSS',
            'tencent-cos': '腾讯云 COS',
            'aws-s3': 'AWS S3'
        };
        return names[this.config.type] || this.config.type;
    }

    /**
     * 验证必需的配置项
     * @param {Array<string>} requiredFields - 必需的字段路径
     * @throws {Error} 如果缺少必需配置
     */
    validateConfig(requiredFields) {
        for (const field of requiredFields) {
            const value = field.split('.').reduce((obj, key) => obj?.[key], this.config);
            if (value === undefined || value === null || value === '') {
                throw new Error(`缺少必需配置: ${field}`);
            }
        }
    }
}

module.exports = BaseDeployer;
