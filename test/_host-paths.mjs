/**
 * 解析宿主（DSH 运行时）的 @deepseek-ai 包目录，供需要「真实宿主链路」的测试使用。
 *
 * 历史坑：这几条测试原来把 Windows 的 asar 路径写死成默认值，在 Linux / Android
 * 上一跑就是 ERR_MODULE_NOT_FOUND。这里改成按顺序探测，并用 pathToFileURL() 拼 URL
 * —— 直接拼 `file:///${dir}` 在 Linux 上会拼出 `file:////opt/...`，不同 loader 解析不一。
 *
 * 探测顺序：
 *   1. `DSH_ASAR_ROOT`（显式覆盖，桌面端 asar 或任意 checkout）
 *   2. `/opt/dsh/node_modules/@deepseek-ai`（本机 DSH 实现 checkout）
 *   3. `$DSH_HOME/profiles/* /node_modules/@deepseek-ai`（profile 里 hoist 的副本）
 *   4. 旧 Windows 默认路径（保持桌面端老脚本可跑）
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolveHostModules() {
    const candidates = [];
    if (process.env.DSH_ASAR_ROOT) candidates.push(process.env.DSH_ASAR_ROOT);

    candidates.push(join('/opt', 'dsh', 'node_modules', '@deepseek-ai'));

    const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    try {
        for (const entry of readdirSync(join(dshHome, 'profiles'), { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            candidates.push(join(dshHome, 'profiles', entry.name, 'node_modules', '@deepseek-ai'));
        }
    } catch {
        /* 没有 profiles 目录就跳过 */
    }

    candidates.push(
        'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai',
    );

    for (const dir of candidates) {
        if (!dir) continue;
        const hasCordis = existsSync(join(dir, 'cordis', 'lib', 'index.js'));
        const hasPrompt = existsSync(join(dir, 'dsh-system-prompt', 'lib', 'index.js'));
        if (hasCordis && hasPrompt) return dir;
    }

    throw new Error(
        '找不到宿主 @deepseek-ai 包（需要 cordis + dsh-system-prompt）。' +
        '请设置 DSH_ASAR_ROOT 指向包含这两个包的目录。',
    );
}

/** 真实 DSH_HOME（real-data 用）：显式环境变量优先，否则用本机 ~/.dsh。 */
export function resolveRealHome() {
    return process.env.DSH_REAL_HOME ?? join(homedir(), '.dsh');
}
