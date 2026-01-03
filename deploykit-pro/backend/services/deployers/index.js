/**
 * 部署器工厂
 * 根据服务器配置创建对应的部署器实例
 */

const LinuxDeployer = require('./LinuxDeployer');
const WindowsDeployer = require('./WindowsDeployer');
const DockerDeployer = require('./DockerDeployer');
const VercelDeployer = require('./VercelDeployer');
const NetlifyDeployer = require('./NetlifyDeployer');
const OSSDeployer = require('./OSSDeployer');
const COSDeployer = require('./COSDeployer');
const S3Deployer = require('./S3Deployer');

// 平台类型定义
const PLATFORM_TYPES = {
    // 传统服务器
    'linux': { name: 'Linux', icon: '🐧', connection: 'ssh', category: 'server' },
    'windows': { name: 'Windows Server', icon: '🪟', connection: 'ssh', category: 'server' },
    'macos': { name: 'macOS', icon: '🍎', connection: 'ssh', category: 'server' },

    // 容器化
    'docker': { name: 'Docker', icon: '🐳', connection: 'ssh', category: 'container' },

    // PaaS 平台
    'vercel': { name: 'Vercel', icon: '▲', connection: 'api', category: 'paas' },
    'netlify': { name: 'Netlify', icon: '◆', connection: 'api', category: 'paas' },

    // 对象存储（静态网站）
    'aliyun-oss': { name: '阿里云 OSS', icon: '☁️', connection: 'sdk', category: 'storage' },
    'tencent-cos': { name: '腾讯云 COS', icon: '☁️', connection: 'sdk', category: 'storage' },
    'aws-s3': { name: 'AWS S3', icon: '☁️', connection: 'sdk', category: 'storage' }
};

// 部署器映射
const deployers = {
    'linux': LinuxDeployer,
    'macos': LinuxDeployer,      // macOS 使用相同的 SSH 逻辑
    'windows': WindowsDeployer,
    'docker': DockerDeployer,
    'vercel': VercelDeployer,
    'netlify': NetlifyDeployer,
    'aliyun-oss': OSSDeployer,
    'tencent-cos': COSDeployer,
    'aws-s3': S3Deployer
};

/**
 * 创建部署器实例
 * @param {Object} serverConfig - 服务器配置
 * @returns {BaseDeployer} 部署器实例
 */
function createDeployer(serverConfig) {
    const DeployerClass = deployers[serverConfig.type];

    if (!DeployerClass) {
        throw new Error(`不支持的平台类型: ${serverConfig.type}`);
    }

    return new DeployerClass(serverConfig);
}

/**
 * 获取支持的平台列表
 * @returns {Array} 平台信息数组
 */
function getSupportedPlatforms() {
    return Object.entries(PLATFORM_TYPES).map(([type, info]) => ({
        type,
        ...info
    }));
}

/**
 * 检查平台类型是否支持
 * @param {string} type - 平台类型
 * @returns {boolean}
 */
function isPlatformSupported(type) {
    return type in deployers;
}

/**
 * 获取平台信息
 * @param {string} type - 平台类型
 * @returns {Object|null}
 */
function getPlatformInfo(type) {
    return PLATFORM_TYPES[type] || null;
}

module.exports = {
    createDeployer,
    getSupportedPlatforms,
    isPlatformSupported,
    getPlatformInfo,
    PLATFORM_TYPES
};
