/**
 * S3Deployer - AWS S3 部署器
 * 将静态文件上传到 AWS S3 存储桶
 */

const BaseDeployer = require('./BaseDeployer');
const { S3Client, PutObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
const fs = require('fs').promises;
const path = require('path');
const { glob } = require('glob');

class S3Deployer extends BaseDeployer {
    constructor(config) {
        super(config);
        const { accessKeyId, secretAccessKey, region, bucket } = config.connection;

        this.client = new S3Client({
            region,
            credentials: {
                accessKeyId,
                secretAccessKey: Buffer.from(secretAccessKey, 'base64').toString()
            }
        });

        this.bucket = bucket;
        this.region = region;
        this.customDomain = config.defaults?.customDomain;
    }

    /**
     * 连接验证
     */
    async connect() {
        this.log('info', '📡 连接 AWS S3...');

        try {
            await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
            this.log('success', `✓ 已连接，存储桶: ${this.bucket}`);
        } catch (error) {
            throw new Error(`S3 连接失败: ${error.message}`);
        }
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
            await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
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
     * 执行部署
     */
    async deploy(projectPath, options) {
        const { prefix = '' } = options;

        this.startTimer();
        this.log('info', `开始上传到 AWS S3`);
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
                const s3Key = prefix ? `${prefix}/${file}` : file;

                try {
                    const content = await fs.readFile(localPath);
                    const { contentType, cacheControl } = this.getMetadata(file);

                    await this.client.send(new PutObjectCommand({
                        Bucket: this.bucket,
                        Key: s3Key,
                        Body: content,
                        ContentType: contentType,
                        CacheControl: cacheControl
                    }));

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
            let url;
            if (this.customDomain) {
                url = `https://${this.customDomain}`;
            } else {
                // S3 静态网站托管 URL
                url = `http://${this.bucket}.s3-website-${this.region}.amazonaws.com`;
            }

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
            this.log('error', `❌ S3 上传失败: ${error.message}`);
            throw error;
        }
    }

    /**
     * 获取文件元数据
     */
    getMetadata(filename) {
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

        const contentType = mimeTypes[ext] || 'application/octet-stream';

        // 缓存策略
        const cacheableExts = ['.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.woff', '.woff2', '.ttf', '.ico'];
        let cacheControl;

        if (cacheableExts.includes(ext)) {
            cacheControl = 'max-age=31536000, immutable';
        } else if (ext === '.html' || ext === '.htm') {
            cacheControl = 'no-cache, no-store, must-revalidate';
        } else {
            cacheControl = 'max-age=86400';
        }

        return { contentType, cacheControl };
    }
}

module.exports = S3Deployer;
