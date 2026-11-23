// 发版门禁：预设引用的宿主包与子路径必须能被解析。
//
// 2.13.0 的教训：宿主把 `@deepseek-ai/dsh-tool-subagent-control/list-agents`
// 并回主入口后，预设快照里仍留着那一行。配置写得出来、肉眼看也像对的，但
// loader 激活时 import 失败，整个「小鲸教练」预设不可用，用户连新会话都建不了。
//
// 这里按 preset 的 `plugins[].name` 逐个解析一次；任何一个解析不到，发版失败。
// 解析基准是 devDependencies 固定住的宿主包（@deepseek-ai/dsh-web-app 等），
// 升级宿主时它们和 cordis.patch.yml 一起更新。
import fs from 'node:fs'
import { parse } from 'yaml'

const patches = parse(fs.readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), {
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
})

function walk(rows, out = []) {
  for (const row of rows ?? []) {
    if (!row || typeof row !== 'object') continue
    if (typeof row.name === 'string' && row.name) out.push(row)
    // cordis:group 的子项在 config 数组里，和普通插件的 config 对象区分开。
    if (Array.isArray(row.config)) walk(row.config, out)
  }
  return out
}

const presets = patches.flatMap(patch => patch?.insert ?? [])
  .filter(entry => entry?.name === '@deepseek-ai/dsh-agent-preset')
if (!presets.length) {
  console.error('✗ cordis.patch.yml 没有声明任何 agent preset')
  process.exitCode = 1
} else {
  const names = new Set()
  for (const preset of presets) {
    for (const entry of walk(preset.config?.plugins)) {
      // cordis:group 之类是宿主内置构造，不走包解析。
      if (!entry.name.startsWith('cordis:')) names.add(entry.name)
    }
  }
  const missing = []
  for (const name of names) {
    try {
      import.meta.resolve(name)
    } catch (error) {
      missing.push(`${name}（${error.code ?? error.message}）`)
    }
  }
  if (missing.length) {
    console.error(`✗ 预设引用了无法解析的宿主包：\n${missing.map(item => `  - ${item}`).join('\n')}`)
    console.error('  宿主升级后删掉或改名的子路径会被这里拦住；同步 cordis.patch.yml 与 devDependencies 后重试。')
    process.exitCode = 1
  } else {
    console.log(`✓ 预设宿主包全部可解析：${presets.length} 个预设，${names.size} 个插件`)
  }
}
