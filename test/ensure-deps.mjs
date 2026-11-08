/**
 * 测试依赖自举：新克隆的仓库没有 node_modules，直接跑测试会 ERR_MODULE_NOT_FOUND。
 *
 * 本机（尤其 Android / proot）npm 安装 schemastery 常常失败，而宿主包里已经有现成的
 * 副本。这里优先用符号链接指向现成副本，够不到再放弃并给出手动安装提示。
 *
 * 只做「缺才补」，不覆盖已有目录；任何一步失败都只是警告，不阻断测试。
 *
 * 单独跑：node test/ensure-deps.mjs
 */
import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const nodeModules = join(repoRoot, 'node_modules');

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');

/** 候选源目录：先本机 checkout，再 profile 的 hoist 副本。 */
function candidateRoots() {
    const roots = [join('/opt', 'dsh', 'node_modules')];
    try {
        for (const entry of readdirSync(join(dshHome, 'profiles'), { withFileTypes: true })) {
            if (entry.isDirectory()) roots.push(join(dshHome, 'profiles', entry.name, 'node_modules'));
        }
    } catch {
        /* 没有 profiles 目录就跳过 */
    }
    return roots;
}

/** 在候选根里找包目录；找不到返回 null。 */
function locate(pkg, roots) {
    for (const root of roots) {
        const dir = join(root, ...pkg.split('/'));
        if (existsSync(dir) && existsSync(join(dir, 'package.json'))) return dir;
    }
    return null;
}

function link(pkg, src) {
    const dest = join(nodeModules, ...pkg.split('/'));
    if (existsSync(dest)) return 'ok';
    mkdirSync(dirname(dest), { recursive: true });
    try {
        // Windows 上目录链接需要管理员；junction 不需要。失败就放弃。
        symlinkSync(src, dest, process.platform === 'win32' ? 'junction' : 'dir');
        return 'linked';
    } catch (err) {
        return `fail: ${err.code ?? err.message}`;
    }
}

export function ensureDeps({ quiet = false } = {}) {
    const roots = candidateRoots();
    const wanted = ['schemastery', '@deepseek-ai/cordis', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools'];
    const warnings = [];

    for (const pkg of wanted) {
        const dest = join(nodeModules, ...pkg.split('/'));
        if (existsSync(dest)) continue;
        const src = locate(pkg, roots);
        if (!src) {
            warnings.push(`${pkg}：本机没找到现成副本，需要手动安装`);
            continue;
        }
        const result = link(pkg, src);
        if (result === 'linked') {
            if (!quiet) console.log(`  · 已链接 ${pkg} → ${src}`);
        } else if (result.startsWith('fail')) {
            warnings.push(`${pkg}：链接失败（${result}），需要手动安装`);
        }
    }

    if (!quiet && warnings.length > 0) {
        console.warn('  ⚠ 依赖自举有缺口：');
        for (const w of warnings) console.warn(`    - ${w}`);
    }
    return { warnings };
}

if (process.argv[1] && join(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { warnings } = ensureDeps();
    if (warnings.length === 0) console.log('依赖自举完成。');
    else process.exitCode = 0; // 警告而已，不阻断
}
