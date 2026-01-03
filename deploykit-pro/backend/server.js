/**
 * DeployKit Pro - 企业级智能部署平台
 * Express 主服务入口
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Server } = require('socket.io');
const http = require('http');
const path = require('path');
const fs = require('fs').promises;

// 导入服务和工具
const { createDeployer, getSupportedPlatforms } = require('./services/deployers');
const serverConfigService = require('./services/serverConfig');
const aiAssistant = require('./services/aiAssistant');
const fileManager = require('./utils/fileManager');

// 创建 Express 应用
const app = express();
const server = http.createServer(app);

// 创建 Socket.IO 服务
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// 中间件
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 静态文件服务
app.use(express.static(path.join(__dirname, '../frontend')));

// 文件上传配置
const upload = multer({
    dest: fileManager.UPLOADS_DIR,
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/zip' ||
            file.mimetype === 'application/x-zip-compressed' ||
            file.originalname.endsWith('.zip')) {
            cb(null, true);
        } else {
            cb(new Error('只支持 ZIP 文件'), false);
        }
    }
});

// WebSocket 连接管理
const clients = new Map();
const deployLogs = new Map(); // 存储每个项目的部署日志

io.on('connection', (socket) => {
    console.log(`客户端连接: ${socket.id}`);
    clients.set(socket.id, socket);

    socket.on('disconnect', () => {
        console.log(`客户端断开: ${socket.id}`);
        clients.delete(socket.id);
    });

    // 加入项目房间
    socket.on('join:project', (projectId) => {
        socket.join(`project:${projectId}`);
    });

    // 离开项目房间
    socket.on('leave:project', (projectId) => {
        socket.leave(`project:${projectId}`);
    });
});

// 发送日志到客户端
function sendLog(socketId, log) {
    const socket = clients.get(socketId);
    if (socket) {
        socket.emit('deploy:log', log);
    }
}

// 存储部署日志
function storeLog(projectId, log) {
    if (!deployLogs.has(projectId)) {
        deployLogs.set(projectId, []);
    }
    const logs = deployLogs.get(projectId);
    logs.push(log);
    // 只保留最近 500 条日志
    if (logs.length > 500) {
        logs.shift();
    }
}

// ==================== 平台类型 API ====================

/**
 * 获取支持的平台列表
 */
app.get('/api/platforms', (req, res) => {
    const platforms = getSupportedPlatforms();
    res.json({ success: true, platforms });
});

// ==================== 服务器配置 API ====================

/**
 * 获取所有服务器配置（隐藏敏感信息）
 */
app.get('/api/servers', async (req, res) => {
    try {
        const servers = await serverConfigService.getAllSafe();
        res.json({ success: true, servers });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 获取单个服务器配置
 */
app.get('/api/servers/:id', async (req, res) => {
    try {
        const server = await serverConfigService.getById(req.params.id);
        // 隐藏敏感信息
        const safeServer = { ...server };
        if (safeServer.connection) {
            safeServer.connection = { ...safeServer.connection };
            ['password', 'privateKey', 'accessKeySecret', 'secretKey', 'secretAccessKey', 'token'].forEach(key => {
                if (safeServer.connection[key]) {
                    safeServer.connection[key] = '******';
                }
            });
        }
        res.json({ success: true, server: safeServer });
    } catch (error) {
        res.status(404).json({ success: false, error: error.message });
    }
});

/**
 * 创建服务器配置
 */
app.post('/api/servers', async (req, res) => {
    try {
        const server = await serverConfigService.create(req.body);
        res.json({ success: true, server });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * 更新服务器配置
 */
app.put('/api/servers/:id', async (req, res) => {
    try {
        const server = await serverConfigService.update(req.params.id, req.body);
        res.json({ success: true, server });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * 删除服务器配置
 */
app.delete('/api/servers/:id', async (req, res) => {
    try {
        await serverConfigService.delete(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

/**
 * 测试服务器连接
 */
app.post('/api/servers/:id/test', async (req, res) => {
    try {
        const serverConfig = await serverConfigService.getById(req.params.id);
        const deployer = createDeployer(serverConfig);
        const result = await deployer.testConnection();
        res.json(result);
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// ==================== 项目管理 API ====================

/**
 * 上传项目（供 AI 读写使用）
 */
app.post('/api/project/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            throw new Error('未上传文件');
        }

        const { projectId, extractPath } = await fileManager.extractToWorkspace(req.file.path);

        // 删除临时文件
        await fs.unlink(req.file.path);

        res.json({
            success: true,
            projectId,
            message: '项目已上传，AI 助手可以读写文件'
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 获取项目文件列表
 */
app.get('/api/project/:projectId/files', async (req, res) => {
    try {
        const { projectId } = req.params;
        const dirPath = req.query.path || '';
        const items = await fileManager.listDirectory(projectId, dirPath);
        res.json({ success: true, items });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 读取项目文件
 */
app.get('/api/project/:projectId/file', async (req, res) => {
    try {
        const { projectId } = req.params;
        const filePath = req.query.path;

        if (!filePath) {
            throw new Error('未指定文件路径');
        }

        const content = await fileManager.readFile(projectId, filePath);
        res.json({ success: true, content });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 写入项目文件
 */
app.post('/api/project/:projectId/file', async (req, res) => {
    try {
        const { projectId } = req.params;
        const { path: filePath, content } = req.body;

        if (!filePath || content === undefined) {
            throw new Error('文件路径和内容不能为空');
        }

        await fileManager.writeFile(projectId, filePath, content);
        res.json({ success: true, message: `文件已保存: ${filePath}` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * 删除项目
 */
app.delete('/api/project/:projectId', async (req, res) => {
    try {
        await fileManager.deleteProject(req.params.projectId);
        deployLogs.delete(req.params.projectId);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== 部署 API ====================

/**
 * 执行部署
 */
app.post('/api/deploy', upload.single('file'), async (req, res) => {
    const {
        serverId,
        deployPath,
        projectType,
        projectName,
        appPort,
        socketId,
        projectId: existingProjectId
    } = req.body;

    let projectId = existingProjectId;
    let projectPath;

    try {
        // 获取服务器配置
        const serverConfig = await serverConfigService.getById(serverId);

        // 确定项目路径
        if (projectId && await fileManager.projectExists(projectId)) {
            // 使用已上传的项目（可能被 AI 修改过）
            projectPath = fileManager.getProjectPath(projectId);
        } else if (req.file) {
            // 新上传的文件
            const result = await fileManager.extractToWorkspace(req.file.path);
            projectId = result.projectId;
            projectPath = result.extractPath;
            await fs.unlink(req.file.path);
        } else {
            throw new Error('未提供项目文件');
        }

        // 压缩项目用于上传
        const zipPath = path.join(path.dirname(projectPath), `${path.basename(projectPath)}.zip`);
        await fileManager.compressDirectory(projectPath, zipPath);

        // 初始化日志存储
        deployLogs.set(projectId, []);

        // 创建部署器
        const deployer = createDeployer(serverConfig);

        // 设置日志回调
        deployer.onProgress = (log) => {
            sendLog(socketId, log);
            storeLog(projectId, log);
        };

        // 执行部署
        sendLog(socketId, { type: 'info', message: '🚀 开始部署...', timestamp: Date.now() });

        await deployer.connect();
        const result = await deployer.deploy(projectPath, {
            deployPath,
            projectType,
            projectName,
            appPort: appPort ? parseInt(appPort) : undefined
        });
        await deployer.disconnect();

        // 返回结果
        res.json({
            success: true,
            projectId,
            ...result
        });
    } catch (error) {
        const errorLog = { type: 'error', message: `❌ 部署失败: ${error.message}`, timestamp: Date.now() };
        sendLog(socketId, errorLog);
        if (projectId) storeLog(projectId, errorLog);

        res.status(500).json({
            success: false,
            projectId,
            error: error.message
        });
    }
});

/**
 * 获取部署日志
 */
app.get('/api/deploy/:projectId/logs', (req, res) => {
    const logs = deployLogs.get(req.params.projectId) || [];
    res.json({ success: true, logs });
});

// ==================== AI 助手 API ====================

/**
 * AI 对话
 */
app.post('/api/ai/chat', async (req, res) => {
    const { messages, context } = req.body;

    try {
        const socket = clients.get(context.socketId);
        const projectLogs = deployLogs.get(context.projectId) || [];

        const response = await aiAssistant.chat(messages, {
            ...context,
            deployLogs: projectLogs,
            onProgress: (data) => {
                if (socket) {
                    socket.emit('ai:progress', data);
                }
            }
        });

        // 提取文本响应
        const textContent = response.content
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('\n');

        res.json({
            success: true,
            response: textContent,
            rawContent: response.content
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * AI 快速诊断
 */
app.post('/api/ai/diagnose', async (req, res) => {
    const { projectId, serverId, socketId } = req.body;

    try {
        const socket = clients.get(socketId);
        const projectLogs = deployLogs.get(projectId) || [];

        const response = await aiAssistant.quickDiagnose({
            projectId,
            serverId,
            deployLogs: projectLogs,
            onProgress: (data) => {
                if (socket) {
                    socket.emit('ai:progress', data);
                }
            }
        });

        const textContent = response.content
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('\n');

        res.json({
            success: true,
            response: textContent
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * AI 自动修复
 */
app.post('/api/ai/autofix', async (req, res) => {
    const { projectId, serverId, socketId } = req.body;

    try {
        const socket = clients.get(socketId);
        const projectLogs = deployLogs.get(projectId) || [];

        const response = await aiAssistant.autoFix({
            projectId,
            serverId,
            deployLogs: projectLogs,
            onProgress: (data) => {
                if (socket) {
                    socket.emit('ai:progress', data);
                }
            }
        });

        const textContent = response.content
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('\n');

        res.json({
            success: true,
            response: textContent
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ==================== 部署历史 API ====================

/**
 * 获取部署历史
 */
app.get('/api/history', async (req, res) => {
    try {
        const historyFile = path.join(__dirname, '../data/history.json');
        const data = await fs.readFile(historyFile, 'utf-8');
        const history = JSON.parse(data);
        res.json({ success: true, ...history });
    } catch (error) {
        res.json({ success: true, deployments: [] });
    }
});

// ==================== 健康检查 ====================

app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// ==================== 错误处理 ====================

// 404 处理
app.use((req, res, next) => {
    // 如果是 API 请求，返回 404
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ success: false, error: '接口不存在' });
    }
    // 否则返回前端页面
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// 全局错误处理
app.use((err, req, res, next) => {
    console.error('服务器错误:', err);

    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ success: false, error: '文件大小超过限制（100MB）' });
        }
    }

    res.status(500).json({
        success: false,
        error: err.message || '服务器内部错误'
    });
});

// ==================== 启动服务 ====================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════╗');
    console.log('║                                                   ║');
    console.log('║   🚀 DeployKit Pro - 企业级智能部署平台           ║');
    console.log('║                                                   ║');
    console.log('╠═══════════════════════════════════════════════════╣');
    console.log(`║   📡 服务地址: http://localhost:${PORT}               ║`);
    console.log('║   📚 API 文档: /api/health                        ║');
    console.log('║                                                   ║');
    console.log('╚═══════════════════════════════════════════════════╝');
    console.log('');

    // 检查 AI 配置
    if (!process.env.ANTHROPIC_API_KEY) {
        console.log('⚠️  提示: 未配置 ANTHROPIC_API_KEY，AI 助手功能不可用');
    } else {
        console.log('✅ AI 助手已启用');
    }
    console.log('');
});

// 定期清理过期项目
setInterval(() => {
    fileManager.cleanupOldProjects(24 * 60 * 60 * 1000); // 24小时
}, 60 * 60 * 1000); // 每小时检查一次

// 优雅退出
process.on('SIGTERM', () => {
    console.log('收到 SIGTERM 信号，正在关闭服务...');
    server.close(() => {
        console.log('服务已关闭');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('\n收到 SIGINT 信号，正在关闭服务...');
    server.close(() => {
        console.log('服务已关闭');
        process.exit(0);
    });
});
