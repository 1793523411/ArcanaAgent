#!/usr/bin/env node

/**
 * Rule Agent CLI
 */

import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, createWriteStream, unlinkSync } from 'fs';
import { homedir } from 'os';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 配置文件路径
const CONFIG_DIR = join(homedir(), '.rule-agent');
const PID_FILE = join(CONFIG_DIR, 'server.pid');
const LOG_FILE = join(CONFIG_DIR, 'server.log');
const PORT = process.env.PORT || 3001;

// 确保配置目录存在
if (!existsSync(CONFIG_DIR)) {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

// 命令处理
const command = process.argv[2];

switch (command) {
  case 'start':
    await startServer();
    break;
  case 'stop':
    await stopServer();
    break;
  case 'restart':
    await stopServer();
    await new Promise(resolve => setTimeout(resolve, 2000));
    await startServer();
    break;
  case 'status':
    await showStatus();
    break;
  case 'logs':
    showLogs();
    break;
  case 'open':
    openBrowser();
    break;
  default:
    showHelp();
}

// ==================== 启动服务 ====================
async function startServer() {
  // 检查是否已经在运行
  if (existsSync(PID_FILE)) {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8'));
    if (isProcessRunning(pid)) {
      console.log(`✅ Rule Agent is already running (PID: ${pid})`);
      console.log(`🌐 Open: http://localhost:${PORT}`);
      return;
    }
  }

  console.log('🚀 Starting Rule Agent...');

  // 检查并初始化 config/models.json
  ensureModelsConfig();

  // 启动服务器
  const serverPath = join(__dirname, 'server', 'dist', 'index.js');

  if (!existsSync(serverPath)) {
    console.error('❌ Server build not found. Please run: npm run build');
    process.exit(1);
  }

  const child = spawn('node', [serverPath], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT },
  });

  // 保存PID
  writeFileSync(PID_FILE, child.pid.toString());

  // 重定向日志
  const logStream = createWriteStream(LOG_FILE, { flags: 'a' });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  child.unref();

  console.log(`✅ Rule Agent is starting...`);
  console.log(`📝 PID: ${child.pid}`);
  console.log(`🌐 URL: http://localhost:${PORT}`);
  console.log(`📋 Logs: ${LOG_FILE}`);
  console.log(`\n💡 Use 'rule-agent status' to check if it's ready`);
  console.log(`💡 Use 'rule-agent open' to open in browser`);
  console.log(`💡 Use 'rule-agent logs' to view logs`);
  console.log(`💡 Use 'rule-agent stop' to stop the server`);

  // 不等待服务器启动，立即返回让用户可以继续使用终端
}

// ==================== 停止服务 ====================
async function stopServer() {
  if (!existsSync(PID_FILE)) {
    console.log('⚠️  Rule Agent is not running');
    return;
  }

  const pid = parseInt(readFileSync(PID_FILE, 'utf-8'));

  if (!isProcessRunning(pid)) {
    console.log('⚠️  Rule Agent is not running (stale PID file)');
    unlinkSync(PID_FILE);
    return;
  }

  console.log(`🛑 Stopping Rule Agent (PID: ${pid})...`);

  try {
    process.kill(pid, 'SIGTERM');

    // 等待进程结束
    let attempts = 0;
    while (isProcessRunning(pid) && attempts < 10) {
      await new Promise(resolve => setTimeout(resolve, 500));
      attempts++;
    }

    if (isProcessRunning(pid)) {
      console.log('⚠️  Process did not stop gracefully, forcing...');
      process.kill(pid, 'SIGKILL');
    }

    unlinkSync(PID_FILE);
    console.log('✅ Rule Agent stopped successfully');
  } catch (error) {
    console.error('❌ Failed to stop server:', error.message);
    process.exit(1);
  }
}

// ==================== 查看状态 ====================
async function showStatus() {
  if (!existsSync(PID_FILE)) {
    console.log('⚫ Rule Agent is not running');
    return;
  }

  const pid = parseInt(readFileSync(PID_FILE, 'utf-8'));

  if (!isProcessRunning(pid)) {
    console.log('⚫ Rule Agent is not running (stale PID file)');
    unlinkSync(PID_FILE);
    return;
  }

  console.log('🟢 Rule Agent is running');
  console.log(`📝 PID: ${pid}`);
  console.log(`🌐 URL: http://localhost:${PORT}`);
  console.log(`📋 Logs: ${LOG_FILE}`);

  // 显示内存和CPU使用情况（如果可用）
  try {
    const { stdout } = await execAsync(`ps -p ${pid} -o %mem,%cpu`);
    const lines = stdout.trim().split('\n');
    if (lines.length > 1) {
      const [mem, cpu] = lines[1].trim().split(/\s+/);
      console.log(`💾 Memory: ${mem}%`);
      console.log(`⚡ CPU: ${cpu}%`);
    }
  } catch (error) {
    // Ignore errors
  }
}

// ==================== 查看日志 ====================
async function showLogs() {
  if (!existsSync(LOG_FILE)) {
    console.log('⚠️  No logs found');
    return;
  }

  console.log('📋 Showing last 50 lines of logs:\n');

  try {
    const { execSync } = await import('child_process');
    const logs = execSync(`tail -50 ${LOG_FILE}`).toString();
    console.log(logs);
  } catch (error) {
    console.error('❌ Failed to read logs:', error.message);
  }
}

// ==================== 打开浏览器 ====================
function openBrowser() {
  const url = `http://localhost:${PORT}`;
  console.log(`🌐 Opening ${url} in browser...`);

  const command = process.platform === 'darwin' ? 'open' :
                  process.platform === 'win32' ? 'start' : 'xdg-open';

  exec(`${command} ${url}`, (error) => {
    if (error) {
      console.error('❌ Failed to open browser:', error.message);
      console.log(`Please open ${url} manually`);
    }
  });
}

// ==================== 显示帮助 ====================
function showHelp() {
  console.log(`
╔═══════════════════════════════════════════════╗
║          Rule Agent CLI v1.0.0                ║
╚═══════════════════════════════════════════════╝

Usage: rule-agent <command>

Commands:
  start       Start the Rule Agent server
  stop        Stop the Rule Agent server
  restart     Restart the Rule Agent server
  status      Show server status
  logs        Show server logs
  open        Open Rule Agent in browser

Examples:
  $ rule-agent start
  $ rule-agent status
  $ rule-agent open
  $ rule-agent logs
  $ rule-agent stop

Environment Variables:
  PORT        Server port (default: 3001)
  DATA_DIR    Data directory (default: ./data)

Documentation: https://github.com/yourusername/rule-agent
`);
}

// ==================== 工具函数 ====================

function ensureModelsConfig() {
  // 用户配置文件在主目录
  const userConfigPath = join(CONFIG_DIR, 'models.json');

  // 如果用户配置已存在，直接返回
  if (existsSync(userConfigPath)) {
    return;
  }

  // 模板文件在项目安装目录
  const examplePath = join(__dirname, 'config', 'models.example.json');

  if (!existsSync(examplePath)) {
    console.error('❌ Configuration template not found.');
    console.log('   Please reinstall rule-agent or check your installation.');
    process.exit(1);
  }

  console.log('⚙️  First time setup: Creating configuration file...');
  console.log('');

  const exampleContent = readFileSync(examplePath, 'utf-8');
  writeFileSync(userConfigPath, exampleContent);

  console.log('✅ Configuration file created!');
  console.log(`📝 Location: ${userConfigPath}`);
  console.log('');
  console.log('⚠️  You need to configure at least one model provider before using Rule Agent.');
  console.log('');
  console.log('📖 Edit the configuration file and replace placeholders with your actual API keys:');
  console.log(`   ${userConfigPath}`);
  console.log('');
  console.log('💡 Supported providers: volcengine, openai, anthropic, etc.');
  console.log('💡 Example: Change "YOUR_API_KEY" to your actual API key');
  console.log('');
  console.log('After editing the config, run "rule-agent start" again.');
  console.log('');
  process.exit(0);
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

async function waitForServer(port, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const fetch = (await import('node-fetch')).default;
      const response = await fetch(`http://localhost:${port}/api/conversations`);
      if (response.ok || response.status === 304) {
        return true;
      }
    } catch (error) {
      // Server not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Server failed to start within 30 seconds');
}
