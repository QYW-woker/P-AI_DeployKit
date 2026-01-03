/**
 * 服务器配置管理服务
 * 负责服务器配置的 CRUD 操作
 */

const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_FILE = path.join(__dirname, '../../data/servers.json');

/**
 * 读取配置文件
 */
async function readData() {
    try {
        const content = await fs.readFile(DATA_FILE, 'utf-8');
        return JSON.parse(content);
    } catch (error) {
        // 如果文件不存在，返回空数据
        if (error.code === 'ENOENT') {
            return { servers: [] };
        }
        throw error;
    }
}

/**
 * 写入配置文件
 */
async function writeData(data) {
    await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * 验证服务器配置
 */
function validateServerConfig(config) {
    const errors = [];

    // 基础验证
    if (!config.name || config.name.trim() === '') {
        errors.push('服务器名称不能为空');
    }

    if (!config.type) {
        errors.push('平台类型不能为空');
    }

    // 根据平台类型验证连接配置
    const type = config.type;

    if (['linux', 'windows', 'macos', 'docker'].includes(type)) {
        // SSH 连接验证
        if (!config.connection?.host) {
            errors.push('主机地址不能为空');
        }
        if (!config.connection?.username) {
            errors.push('用户名不能为空');
        }
        if (!config.connection?.password && !config.connection?.privateKey) {
            errors.push('密码或私钥至少需要提供一个');
        }
    }

    if (type === 'vercel') {
        if (!config.connection?.token) {
            errors.push('Vercel Token 不能为空');
        }
    }

    if (type === 'netlify') {
        if (!config.connection?.token) {
            errors.push('Netlify Token 不能为空');
        }
    }

    if (type === 'aliyun-oss') {
        if (!config.connection?.accessKeyId) {
            errors.push('AccessKey ID 不能为空');
        }
        if (!config.connection?.accessKeySecret) {
            errors.push('AccessKey Secret 不能为空');
        }
        if (!config.connection?.bucket) {
            errors.push('Bucket 名称不能为空');
        }
        if (!config.connection?.region) {
            errors.push('Region 不能为空');
        }
    }

    if (type === 'tencent-cos') {
        if (!config.connection?.secretId) {
            errors.push('SecretId 不能为空');
        }
        if (!config.connection?.secretKey) {
            errors.push('SecretKey 不能为空');
        }
        if (!config.connection?.bucket) {
            errors.push('Bucket 名称不能为空');
        }
        if (!config.connection?.region) {
            errors.push('Region 不能为空');
        }
    }

    if (type === 'aws-s3') {
        if (!config.connection?.accessKeyId) {
            errors.push('Access Key ID 不能为空');
        }
        if (!config.connection?.secretAccessKey) {
            errors.push('Secret Access Key 不能为空');
        }
        if (!config.connection?.bucket) {
            errors.push('Bucket 名称不能为空');
        }
        if (!config.connection?.region) {
            errors.push('Region 不能为空');
        }
    }

    return errors;
}

/**
 * 对敏感信息进行编码
 */
function encodeSecrets(config) {
    const encoded = { ...config };

    if (encoded.connection) {
        encoded.connection = { ...encoded.connection };

        // 编码密码
        if (encoded.connection.password && !isBase64(encoded.connection.password)) {
            encoded.connection.password = Buffer.from(encoded.connection.password).toString('base64');
        }

        // 编码私钥
        if (encoded.connection.privateKey && !isBase64(encoded.connection.privateKey)) {
            encoded.connection.privateKey = Buffer.from(encoded.connection.privateKey).toString('base64');
        }

        // 编码云存储密钥
        if (encoded.connection.accessKeySecret && !isBase64(encoded.connection.accessKeySecret)) {
            encoded.connection.accessKeySecret = Buffer.from(encoded.connection.accessKeySecret).toString('base64');
        }

        if (encoded.connection.secretKey && !isBase64(encoded.connection.secretKey)) {
            encoded.connection.secretKey = Buffer.from(encoded.connection.secretKey).toString('base64');
        }

        if (encoded.connection.secretAccessKey && !isBase64(encoded.connection.secretAccessKey)) {
            encoded.connection.secretAccessKey = Buffer.from(encoded.connection.secretAccessKey).toString('base64');
        }
    }

    return encoded;
}

/**
 * 检查字符串是否为 Base64 编码
 */
function isBase64(str) {
    if (typeof str !== 'string') return false;
    try {
        return Buffer.from(str, 'base64').toString('base64') === str;
    } catch {
        return false;
    }
}

/**
 * 获取所有服务器配置
 */
async function getAll() {
    const data = await readData();
    return data.servers || [];
}

/**
 * 根据 ID 获取服务器配置
 */
async function getById(id) {
    const servers = await getAll();
    const server = servers.find(s => s.id === id);

    if (!server) {
        throw new Error(`未找到服务器配置: ${id}`);
    }

    return server;
}

/**
 * 创建服务器配置
 */
async function create(config) {
    // 验证配置
    const errors = validateServerConfig(config);
    if (errors.length > 0) {
        throw new Error(errors.join('; '));
    }

    const data = await readData();
    const now = new Date().toISOString();

    // 编码敏感信息
    const encodedConfig = encodeSecrets(config);

    const newServer = {
        id: uuidv4(),
        ...encodedConfig,
        createdAt: now,
        updatedAt: now
    };

    data.servers.push(newServer);
    await writeData(data);

    return newServer;
}

/**
 * 更新服务器配置
 */
async function update(id, config) {
    const data = await readData();
    const index = data.servers.findIndex(s => s.id === id);

    if (index === -1) {
        throw new Error(`未找到服务器配置: ${id}`);
    }

    // 验证配置
    const errors = validateServerConfig({ ...data.servers[index], ...config });
    if (errors.length > 0) {
        throw new Error(errors.join('; '));
    }

    // 编码敏感信息
    const encodedConfig = encodeSecrets(config);

    // 保留原始密码（如果新配置中密码为占位符）
    if (encodedConfig.connection) {
        const originalConn = data.servers[index].connection || {};

        // 如果密码是占位符，保留原始密码
        if (encodedConfig.connection.password === '******') {
            encodedConfig.connection.password = originalConn.password;
        }
        if (encodedConfig.connection.accessKeySecret === '******') {
            encodedConfig.connection.accessKeySecret = originalConn.accessKeySecret;
        }
        if (encodedConfig.connection.secretKey === '******') {
            encodedConfig.connection.secretKey = originalConn.secretKey;
        }
        if (encodedConfig.connection.secretAccessKey === '******') {
            encodedConfig.connection.secretAccessKey = originalConn.secretAccessKey;
        }
        if (encodedConfig.connection.token === '******') {
            encodedConfig.connection.token = originalConn.token;
        }
    }

    data.servers[index] = {
        ...data.servers[index],
        ...encodedConfig,
        id, // 确保 ID 不变
        updatedAt: new Date().toISOString()
    };

    await writeData(data);
    return data.servers[index];
}

/**
 * 删除服务器配置
 */
async function remove(id) {
    const data = await readData();
    const index = data.servers.findIndex(s => s.id === id);

    if (index === -1) {
        throw new Error(`未找到服务器配置: ${id}`);
    }

    data.servers.splice(index, 1);
    await writeData(data);

    return { success: true };
}

/**
 * 获取隐藏敏感信息的配置（用于前端展示）
 */
async function getAllSafe() {
    const servers = await getAll();

    return servers.map(server => {
        const safe = { ...server };

        if (safe.connection) {
            safe.connection = { ...safe.connection };

            // 隐藏敏感字段
            if (safe.connection.password) {
                safe.connection.password = '******';
            }
            if (safe.connection.privateKey) {
                safe.connection.privateKey = '******';
            }
            if (safe.connection.accessKeySecret) {
                safe.connection.accessKeySecret = '******';
            }
            if (safe.connection.secretKey) {
                safe.connection.secretKey = '******';
            }
            if (safe.connection.secretAccessKey) {
                safe.connection.secretAccessKey = '******';
            }
            if (safe.connection.token) {
                safe.connection.token = '******';
            }
        }

        return safe;
    });
}

module.exports = {
    getAll,
    getById,
    create,
    update,
    delete: remove,
    getAllSafe,
    validateServerConfig
};
