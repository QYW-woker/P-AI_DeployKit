/**
 * 文件管理工具
 * 提供文件压缩、解压、读写等功能
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const archiver = require('archiver');
const extractZip = require('extract-zip');
const { v4: uuidv4 } = require('uuid');

const WORKSPACE_DIR = path.join(__dirname, '../../workspace');
const UPLOADS_DIR = path.join(__dirname, '../../uploads');

/**
 * 确保目录存在
 */
async function ensureDir(dirPath) {
    try {
        await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
    }
}

/**
 * 解压 ZIP 文件到工作区
 * @param {string} zipPath - ZIP 文件路径
 * @returns {Promise<{projectId: string, extractPath: string}>}
 */
async function extractToWorkspace(zipPath) {
    const projectId = uuidv4();
    const extractPath = path.join(WORKSPACE_DIR, projectId);

    await ensureDir(extractPath);
    await extractZip(zipPath, { dir: extractPath });

    // 处理可能的单一根目录
    const items = await fs.readdir(extractPath);
    if (items.length === 1) {
        const singleItem = path.join(extractPath, items[0]);
        const stat = await fs.stat(singleItem);

        if (stat.isDirectory()) {
            // 如果只有一个目录，将其内容移到上一级
            const subItems = await fs.readdir(singleItem);
            for (const item of subItems) {
                const srcPath = path.join(singleItem, item);
                const destPath = path.join(extractPath, item);
                await fs.rename(srcPath, destPath);
            }
            await fs.rmdir(singleItem);
        }
    }

    return { projectId, extractPath };
}

/**
 * 压缩目录为 ZIP 文件
 * @param {string} dirPath - 要压缩的目录
 * @param {string} outputPath - 输出 ZIP 文件路径
 * @returns {Promise<string>} ZIP 文件路径
 */
async function compressDirectory(dirPath, outputPath) {
    return new Promise((resolve, reject) => {
        const output = fsSync.createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve(outputPath));
        archive.on('error', reject);

        archive.pipe(output);
        archive.directory(dirPath, false);
        archive.finalize();
    });
}

/**
 * 读取文件内容
 * @param {string} projectId - 项目 ID
 * @param {string} relativePath - 相对路径
 * @returns {Promise<string>}
 */
async function readFile(projectId, relativePath) {
    const filePath = path.join(WORKSPACE_DIR, projectId, relativePath);
    return fs.readFile(filePath, 'utf-8');
}

/**
 * 写入文件内容
 * @param {string} projectId - 项目 ID
 * @param {string} relativePath - 相对路径
 * @param {string} content - 文件内容
 */
async function writeFile(projectId, relativePath, content) {
    const filePath = path.join(WORKSPACE_DIR, projectId, relativePath);
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, content, 'utf-8');
}

/**
 * 列出目录内容
 * @param {string} projectId - 项目 ID
 * @param {string} relativePath - 相对路径
 * @returns {Promise<Array>}
 */
async function listDirectory(projectId, relativePath = '') {
    const dirPath = path.join(WORKSPACE_DIR, projectId, relativePath);
    const items = await fs.readdir(dirPath, { withFileTypes: true });

    return items.map(item => ({
        name: item.name,
        type: item.isDirectory() ? 'directory' : 'file',
        path: path.join(relativePath, item.name)
    }));
}

/**
 * 删除项目工作区
 * @param {string} projectId - 项目 ID
 */
async function deleteProject(projectId) {
    const projectPath = path.join(WORKSPACE_DIR, projectId);

    try {
        await fs.rm(projectPath, { recursive: true, force: true });
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

/**
 * 获取项目路径
 * @param {string} projectId - 项目 ID
 * @returns {string}
 */
function getProjectPath(projectId) {
    return path.join(WORKSPACE_DIR, projectId);
}

/**
 * 检查项目是否存在
 * @param {string} projectId - 项目 ID
 * @returns {Promise<boolean>}
 */
async function projectExists(projectId) {
    try {
        await fs.access(getProjectPath(projectId));
        return true;
    } catch {
        return false;
    }
}

/**
 * 清理过期项目（超过指定时间）
 * @param {number} maxAgeMs - 最大保留时间（毫秒）
 */
async function cleanupOldProjects(maxAgeMs = 24 * 60 * 60 * 1000) {
    try {
        const items = await fs.readdir(WORKSPACE_DIR);
        const now = Date.now();

        for (const item of items) {
            const itemPath = path.join(WORKSPACE_DIR, item);
            const stat = await fs.stat(itemPath);

            if (now - stat.mtimeMs > maxAgeMs) {
                await fs.rm(itemPath, { recursive: true, force: true });
                console.log(`已清理过期项目: ${item}`);
            }
        }
    } catch (error) {
        console.error('清理过期项目失败:', error);
    }
}

/**
 * 获取文件信息
 * @param {string} projectId - 项目 ID
 * @param {string} relativePath - 相对路径
 * @returns {Promise<Object>}
 */
async function getFileInfo(projectId, relativePath) {
    const filePath = path.join(WORKSPACE_DIR, projectId, relativePath);
    const stat = await fs.stat(filePath);

    return {
        name: path.basename(relativePath),
        path: relativePath,
        size: stat.size,
        isDirectory: stat.isDirectory(),
        modifiedAt: stat.mtime,
        createdAt: stat.birthtime
    };
}

/**
 * 复制文件
 * @param {string} projectId - 项目 ID
 * @param {string} srcPath - 源路径
 * @param {string} destPath - 目标路径
 */
async function copyFile(projectId, srcPath, destPath) {
    const src = path.join(WORKSPACE_DIR, projectId, srcPath);
    const dest = path.join(WORKSPACE_DIR, projectId, destPath);

    await ensureDir(path.dirname(dest));
    await fs.copyFile(src, dest);
}

/**
 * 移动文件
 * @param {string} projectId - 项目 ID
 * @param {string} srcPath - 源路径
 * @param {string} destPath - 目标路径
 */
async function moveFile(projectId, srcPath, destPath) {
    const src = path.join(WORKSPACE_DIR, projectId, srcPath);
    const dest = path.join(WORKSPACE_DIR, projectId, destPath);

    await ensureDir(path.dirname(dest));
    await fs.rename(src, dest);
}

/**
 * 删除文件或目录
 * @param {string} projectId - 项目 ID
 * @param {string} relativePath - 相对路径
 */
async function deleteFile(projectId, relativePath) {
    const filePath = path.join(WORKSPACE_DIR, projectId, relativePath);
    await fs.rm(filePath, { recursive: true, force: true });
}

// 初始化时确保目录存在
(async () => {
    await ensureDir(WORKSPACE_DIR);
    await ensureDir(UPLOADS_DIR);
})();

module.exports = {
    extractToWorkspace,
    compressDirectory,
    readFile,
    writeFile,
    listDirectory,
    deleteProject,
    getProjectPath,
    projectExists,
    cleanupOldProjects,
    getFileInfo,
    copyFile,
    moveFile,
    deleteFile,
    ensureDir,
    WORKSPACE_DIR,
    UPLOADS_DIR
};
