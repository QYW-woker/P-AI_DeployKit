/**
 * COSDeployer - 腾讯云 COS 部署器
 * 将静态文件上传到腾讯云 COS 存储桶
 */

const BaseDeployer = require('./BaseDeployer');
const COS = require('cos-nodejs-sdk-v5');
const fs = require('fs').promises;
const path = require('path');
const { glob } = require('glob');

class COSDeployer extends BaseDeployer {
    constructor(config) {
        super(config);
        const { secretId, secretKey, region, bucket } = config.connection;

        this.client = new COS({
            SecretId: secretId,
            SecretKey: Buffer.from(secretKey, 'base64').toString()
        });

        this.bucket = bucket;
        this.region = region;
        this.customDomain = config.defaults?.customDomain;
    }

    /**
     * 连接验证
     */
    async connect() {
        this.log('info', '📡 连接腾讯云 COS...');

        try {
            await this.headBucket();
            this.log('success', `✓ 已连接，存储桶: ${this.bucket}`);
        } catch (error) {
            throw new Error(`COS 连接失败: ${error.message}`);
        }
    }

    /**
     * 检查存储桶
     */
    headBucket() {
        return new Promise((resolve, reject) => {
            this.client.headBucket({
                Bucket: this.bucket,
                Region: this.region
            }, (err, data) => {
                if (err) reject(err);
                else resolve(data);
            });
        });
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
            await this.headBucket();
            return {
                success: true,
                message: '连接成功',
                details: `存储桶: ${this.bucket}, 区域: ${this.region}`
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * 上传单个文件
     */
    putObject(key, body, contentType) {
        return new Promise((resolve, reject) => {
            this.client.putObject({
                Bucket: this.bucket,
                Region: this.region,
                Key: key,
                Body: body,
                ContentType: contentType
            }, (err, data) => {
                if (err) reject(err);
                else resolve(data);
            });
        });
    }

    /**
     * 执行部署
     */
    async deploy(projectPath, options) {
        const { prefix = '' } = options;

        this.startTimer();
        this.log('info', `开始上传到腾讯云 COS`);
        this.log('info', `存储桶: ${this.bucket}, 前缀: ${prefix || '/'}`);

        try {
            // 1. 获取所有文件
            this.log('info', '📦 扫描文件...');
            const files = await glob('**/*', {
                cwd: projectPath,
                nodir: true,
                dot: false,
                ignore: [
                    'node_modules/**',
                    '.git/**',
                    '.DS_Store',
                    '*.log'
                ]
            });
            this.log('info', `找到 ${files.length} 个文件`);

            // 2. 上传文件
            this.log('info', '📤 开始上传...');
            let uploaded = 0;
            let failed = 0;

            for (const file of files) {
                const localPath = path.join(projectPath, file);
                const cosKey = prefix ? `${prefix}/${file}` : file;

                try {
                    const content = await fs.readFile(localPath);
                    const contentType = this.getContentType(file);

                    await this.putObject(cosKey, content, contentType);
                    uploaded++;

                    if (uploaded % 10 === 0 || uploaded === files.length) {
                        this.log('info', `上传进度: ${uploaded}/${files.length}`);
                    }
                } catch (error) {
                    failed++;
                    this.log('warning', `上传失败: ${file} - ${error.message}`);
                }
            }

            // 3. 返回访问地址
            const url = this.customDomain
                ? `https://${this.customDomain}`
                : `https://${this.bucket}.cos.${this.region}.myqcloud.com`;

            this.log('success', `\n🎉 上传完成！耗时: ${this.getElapsedTime()}`);
            this.log('success', `📊 成功: ${uploaded}, 失败: ${failed}`);
            this.log('success', `🌐 访问地址: ${url}`);

            return {
                success: true,
                url,
                filesUploaded: uploaded,
                filesFailed: failed,
                elapsedTime: this.getElapsedTime()
            };
        } catch (error) {
            this.log('error', `❌ COS 上传失败: ${error.message}`);
            throw error;
        }
    }

    /**
     * 获取文件 MIME 类型
     */
    getContentType(filename) {
        const ext = path.extname(filename).toLowerCase();

        const mimeTypes = {
            '.html': 'text/html; charset=utf-8',
            '.htm': 'text/html; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.mjs': 'application/javascript; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
            '.webp': 'image/webp',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
            '.ttf': 'font/ttf',
            '.eot': 'application/vnd.ms-fontobject',
            '.mp4': 'video/mp4',
            '.webm': 'video/webm',
            '.mp3': 'audio/mpeg',
            '.pdf': 'application/pdf',
            '.xml': 'application/xml',
            '.txt': 'text/plain; charset=utf-8',
            '.md': 'text/markdown; charset=utf-8'
        };

        return mimeTypes[ext] || 'application/octet-stream';
    }
}

module.exports = COSDeployer;
