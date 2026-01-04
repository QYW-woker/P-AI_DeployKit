/**
 * AI 助手服务
 * 使用 DeepSeek API 提供智能部署辅助
 */

const OpenAI = require('openai');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { createDeployer } = require('./deployers');
const serverConfigService = require('./serverConfig');

class AIAssistant {
    constructor() {
        this.client = null;
        this.workspacePath = path.join(__dirname, '../../workspace');
    }

    /**
     * 初始化 DeepSeek 客户端
     */
    initClient() {
        if (!this.client) {
            const apiKey = process.env.DEEPSEEK_API_KEY;
            if (!apiKey) {
                throw new Error('未配置 DEEPSEEK_API_KEY 环境变量');
            }
            this.client = new OpenAI({
                apiKey,
                baseURL: 'https://api.deepseek.com'
            });
        }
        return this.client;
    }

    /**
     * AI 可用的工具定义 (OpenAI 格式)
     */
    getTools() {
        return [
            {
                type: "function",
                function: {
                    name: "read_file",
                    description: "读取项目文件内容，用于分析配置、代码、日志等。支持读取 package.json、配置文件、源代码等。",
                    parameters: {
                        type: "object",
                        properties: {
                            filepath: {
                                type: "string",
                                description: "相对于项目根目录的文件路径，如 'package.json'、'src/index.js'"
                            }
                        },
                        required: ["filepath"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "write_file",
                    description: "写入或修改项目文件，用于修复配置错误、添加依赖、修改代码等。",
                    parameters: {
                        type: "object",
                        properties: {
                            filepath: {
                                type: "string",
                                description: "相对于项目根目录的文件路径"
                            },
                            content: {
                                type: "string",
                                description: "要写入的完整文件内容"
                            }
                        },
                        required: ["filepath", "content"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "list_directory",
                    description: "列出目录内容，用于了解项目结构、查找文件等。",
                    parameters: {
                        type: "object",
                        properties: {
                            dirpath: {
                                type: "string",
                                description: "相对于项目根目录的目录路径，默认为根目录"
                            }
                        }
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "execute_deploy",
                    description: "执行部署操作。在修复问题后可以调用此工具重新部署。",
                    parameters: {
                        type: "object",
                        properties: {
                            serverId: {
                                type: "string",
                                description: "目标服务器配置 ID"
                            },
                            deployPath: {
                                type: "string",
                                description: "部署目标路径"
                            },
                            projectType: {
                                type: "string",
                                description: "项目类型: static, vue, react, node, java, python, custom"
                            },
                            projectName: {
                                type: "string",
                                description: "项目名称"
                            },
                            appPort: {
                                type: "number",
                                description: "应用端口号"
                            }
                        },
                        required: ["serverId", "deployPath", "projectType", "projectName"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "get_deploy_logs",
                    description: "获取最近的部署日志，用于分析部署失败原因。",
                    parameters: {
                        type: "object",
                        properties: {
                            limit: {
                                type: "number",
                                description: "返回的日志条数，默认 50"
                            }
                        }
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "run_command",
                    description: "在项目目录中执行本地命令，如 npm install、npm run build 等，用于测试修复是否有效。",
                    parameters: {
                        type: "object",
                        properties: {
                            command: {
                                type: "string",
                                description: "要执行的命令"
                            },
                            cwd: {
                                type: "string",
                                description: "工作目录（可选）"
                            }
                        },
                        required: ["command"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "analyze_project",
                    description: "分析项目类型和结构，自动识别项目类型、框架、依赖等信息。",
                    parameters: {
                        type: "object",
                        properties: {}
                    }
                }
            }
        ];
    }

    /**
     * 执行工具
     */
    async executeTool(toolName, toolInput, context) {
        // 对于不需要 projectId 的工具，允许直接执行
        const toolsWithoutProjectId = ['get_deploy_logs'];

        // 检查 projectId 是否存在（部分工具需要）
        if (!context.projectId && !toolsWithoutProjectId.includes(toolName)) {
            return { success: false, error: '未指定项目，请先上传项目文件。如果已上传，请刷新页面后重试。' };
        }
        const projectPath = context.projectId ? path.join(this.workspacePath, context.projectId) : null;

        switch (toolName) {
            case 'read_file': {
                if (!projectPath) {
                    return { success: false, error: '需要先上传项目文件' };
                }
                const filePath = path.join(projectPath, toolInput.filepath);
                try {
                    const content = await fs.readFile(filePath, 'utf-8');
                    // 限制返回内容大小
                    const truncated = content.length > 15000
                        ? content.substring(0, 15000) + '\n\n... [内容已截断，共 ' + content.length + ' 字符]'
                        : content;
                    return { success: true, content: truncated, filepath: toolInput.filepath };
                } catch (error) {
                    return { success: false, error: `无法读取文件: ${error.message}` };
                }
            }

            case 'write_file': {
                if (!projectPath) {
                    return { success: false, error: '需要先上传项目文件' };
                }
                const filePath = path.join(projectPath, toolInput.filepath);
                try {
                    // 确保目录存在
                    await fs.mkdir(path.dirname(filePath), { recursive: true });
                    await fs.writeFile(filePath, toolInput.content, 'utf-8');
                    return {
                        success: true,
                        message: `文件已保存: ${toolInput.filepath}`,
                        filepath: toolInput.filepath
                    };
                } catch (error) {
                    return { success: false, error: `无法写入文件: ${error.message}` };
                }
            }

            case 'list_directory': {
                if (!projectPath) {
                    return { success: false, error: '需要先上传项目文件' };
                }
                const dirPath = path.join(projectPath, toolInput.dirpath || '');
                try {
                    const items = await fs.readdir(dirPath, { withFileTypes: true });
                    const result = items.slice(0, 100).map(item => ({
                        name: item.name,
                        type: item.isDirectory() ? 'directory' : 'file'
                    }));

                    // 按类型和名称排序
                    result.sort((a, b) => {
                        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
                        return a.name.localeCompare(b.name);
                    });

                    return {
                        success: true,
                        path: toolInput.dirpath || '/',
                        items: result,
                        total: items.length
                    };
                } catch (error) {
                    return { success: false, error: `无法列出目录: ${error.message}` };
                }
            }

            case 'execute_deploy': {
                try {
                    const serverConfig = await serverConfigService.getById(toolInput.serverId);
                    const deployer = createDeployer(serverConfig);

                    // 设置进度回调
                    deployer.onProgress = (log) => {
                        context.onProgress?.({
                            type: 'deploy_log',
                            ...log
                        });
                    };

                    await deployer.connect();
                    const result = await deployer.deploy(projectPath, {
                        deployPath: toolInput.deployPath,
                        projectType: toolInput.projectType,
                        projectName: toolInput.projectName,
                        appPort: toolInput.appPort
                    });
                    await deployer.disconnect();

                    return { success: true, ...result };
                } catch (error) {
                    return { success: false, error: `部署失败: ${error.message}` };
                }
            }

            case 'get_deploy_logs': {
                const logs = context.deployLogs || [];
                const limit = toolInput.limit || 50;
                return {
                    success: true,
                    logs: logs.slice(-limit),
                    total: logs.length
                };
            }

            case 'run_command': {
                if (!projectPath) {
                    return { success: false, error: '需要先上传项目文件' };
                }
                return new Promise((resolve) => {
                    const cwd = toolInput.cwd
                        ? path.join(projectPath, toolInput.cwd)
                        : projectPath;

                    exec(toolInput.command, {
                        cwd,
                        timeout: 120000, // 2 分钟超时
                        maxBuffer: 1024 * 1024 * 10 // 10MB
                    }, (error, stdout, stderr) => {
                        resolve({
                            success: !error,
                            command: toolInput.command,
                            stdout: stdout?.substring(0, 10000),
                            stderr: stderr?.substring(0, 5000),
                            exitCode: error?.code,
                            error: error?.message
                        });
                    });
                });
            }

            case 'analyze_project': {
                if (!projectPath) {
                    return { success: false, error: '需要先上传项目文件' };
                }
                try {
                    const analysis = await this.analyzeProject(projectPath);
                    return { success: true, ...analysis };
                } catch (error) {
                    return { success: false, error: error.message };
                }
            }

            default:
                return { success: false, error: `未知工具: ${toolName}` };
        }
    }

    /**
     * 分析项目
     */
    async analyzeProject(projectPath) {
        const analysis = {
            type: 'unknown',
            framework: null,
            hasPackageJson: false,
            hasTsConfig: false,
            hasDockerfile: false,
            dependencies: {},
            scripts: {},
            suggestions: []
        };

        try {
            // 检查 package.json
            const packageJsonPath = path.join(projectPath, 'package.json');
            try {
                const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
                analysis.hasPackageJson = true;
                analysis.dependencies = {
                    ...packageJson.dependencies,
                    ...packageJson.devDependencies
                };
                analysis.scripts = packageJson.scripts || {};

                // 检测框架
                if (analysis.dependencies.vue || analysis.dependencies['@vue/cli-service']) {
                    analysis.type = 'vue';
                    analysis.framework = 'Vue.js';
                } else if (analysis.dependencies.react || analysis.dependencies['react-scripts']) {
                    analysis.type = 'react';
                    analysis.framework = 'React';
                } else if (analysis.dependencies.next) {
                    analysis.type = 'node';
                    analysis.framework = 'Next.js';
                } else if (analysis.dependencies.nuxt) {
                    analysis.type = 'node';
                    analysis.framework = 'Nuxt.js';
                } else if (analysis.dependencies.express || analysis.dependencies.koa) {
                    analysis.type = 'node';
                    analysis.framework = analysis.dependencies.express ? 'Express' : 'Koa';
                } else if (analysis.scripts.build) {
                    analysis.type = 'vue'; // 假设有 build 脚本的是前端项目
                }
            } catch (e) {
                // 不是 Node.js 项目
            }

            // 检查 TypeScript
            try {
                await fs.access(path.join(projectPath, 'tsconfig.json'));
                analysis.hasTsConfig = true;
            } catch (e) {}

            // 检查 Dockerfile
            try {
                await fs.access(path.join(projectPath, 'Dockerfile'));
                analysis.hasDockerfile = true;
            } catch (e) {}

            // 检查 Python 项目
            try {
                await fs.access(path.join(projectPath, 'requirements.txt'));
                analysis.type = 'python';
                analysis.framework = 'Python';
            } catch (e) {}

            // 检查 Java 项目
            try {
                await fs.access(path.join(projectPath, 'pom.xml'));
                analysis.type = 'java';
                analysis.framework = 'Maven';
            } catch (e) {}

            // 检查静态项目
            if (analysis.type === 'unknown') {
                try {
                    await fs.access(path.join(projectPath, 'index.html'));
                    analysis.type = 'static';
                    analysis.framework = '静态 HTML';
                } catch (e) {}
            }

            // 生成建议
            if (!analysis.hasPackageJson && analysis.type !== 'static' && analysis.type !== 'python' && analysis.type !== 'java') {
                analysis.suggestions.push('缺少 package.json，可能需要初始化项目');
            }

            if (analysis.hasDockerfile) {
                analysis.suggestions.push('检测到 Dockerfile，建议使用 Docker 部署');
            }

        } catch (error) {
            analysis.error = error.message;
        }

        return analysis;
    }

    /**
     * AI 对话
     */
    async chat(messages, context) {
        const client = this.initClient();

        const systemPrompt = `你是 DeployKit Pro 的 AI 部署助手，专门帮助用户解决部署问题。

你的能力：
1. 分析部署日志，诊断错误原因
2. 读取项目文件（package.json、配置文件、源代码等）
3. 修改项目文件（修复依赖、配置、代码错误等）
4. 执行本地命令测试修复效果
5. 触发重新部署

当用户遇到部署问题时，请按以下步骤操作：

1. **获取信息**：
   - 使用 get_deploy_logs 获取部署日志
   - 使用 analyze_project 分析项目结构
   - 使用 read_file 读取相关配置文件

2. **诊断问题**：
   - 分析日志中的错误信息
   - 检查依赖版本、配置正确性
   - 识别常见问题模式

3. **提供解决方案**：
   - 清晰解释问题原因
   - 提供具体的修复步骤
   - 如果需要修改文件，使用 write_file

4. **验证修复**：
   - 使用 run_command 执行测试（如 npm install）
   - 确认修复有效后，询问用户是否重新部署

5. **重新部署**：
   - 如果用户同意，使用 execute_deploy 触发部署

注意事项：
- 主动使用工具获取信息，不要只询问用户
- 修改文件前先确认内容
- 保持回复简洁专业
- 用中文回复

当前项目 ID: ${context.projectId || '未知'}
当前服务器 ID: ${context.serverId || '未知'}`;

        // 构建 OpenAI 格式的消息
        const openaiMessages = [
            { role: 'system', content: systemPrompt },
            ...messages
        ];

        try {
            const response = await client.chat.completions.create({
                model: "deepseek-chat",
                max_tokens: 4096,
                tools: this.getTools(),
                messages: openaiMessages
            });

            const message = response.choices[0].message;

            // 处理工具调用
            if (message.tool_calls && message.tool_calls.length > 0) {
                const toolResults = [];

                for (const toolCall of message.tool_calls) {
                    const toolName = toolCall.function.name;
                    const toolInput = JSON.parse(toolCall.function.arguments);

                    // 通知前端工具正在执行
                    context.onProgress?.({
                        type: 'tool_use',
                        tool: toolName,
                        input: toolInput
                    });

                    // 执行工具
                    const result = await this.executeTool(toolName, toolInput, context);

                    // 通知前端工具执行结果
                    context.onProgress?.({
                        type: 'tool_result',
                        tool: toolName,
                        result: result.success ? 'success' : 'error'
                    });

                    toolResults.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: JSON.stringify(result)
                    });
                }

                // 继续对话，传入工具结果
                return this.chat([
                    ...messages,
                    message,
                    ...toolResults
                ], context);
            }

            // 转换响应格式以兼容原有前端
            return {
                content: [{ type: 'text', text: message.content }],
                stop_reason: response.choices[0].finish_reason === 'stop' ? 'end_turn' : response.choices[0].finish_reason
            };
        } catch (error) {
            console.error('AI 助手错误:', error);
            throw error;
        }
    }

    /**
     * 快速诊断
     */
    async quickDiagnose(context) {
        const messages = [{
            role: 'user',
            content: '部署失败了，请帮我分析问题原因并提供解决方案。'
        }];

        return this.chat(messages, context);
    }

    /**
     * 自动修复并部署
     */
    async autoFix(context) {
        const messages = [{
            role: 'user',
            content: '请分析部署失败的原因，自动修复问题，然后重新部署。'
        }];

        return this.chat(messages, context);
    }
}

// 导出单例
module.exports = new AIAssistant();
