// 更新生成页的界面，保留用户自己的图数据；不重新生成或改写账本。
export function upgradeSkilltreeHtml(cached, template, byId = new Map()) {
  const source = String(cached)
  const match = source.match(/\bconst DATA = ([^\r\n]+);[ \t]*\r?\n/)
  if (!match || !template.includes('/*__DATA__*/null')) return source
  try {
    const data = JSON.parse(match[1])
    if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges) || !Array.isArray(data.bands)
      || !Array.isArray(data.size) || data.size.length !== 2 || !data.size.every(n => Number.isFinite(n) && n > 0)
      || !data.domainColors || typeof data.domainColors !== 'object' || Array.isArray(data.domainColors)) return source
    if (!Object.values(data.domainColors).every(colors => Array.isArray(colors) && colors.length === 2
      && colors.every(color => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)))) return source
    const ids = new Set(data.nodes.map(node => node?.id))
    if (ids.size !== data.nodes.length || !data.nodes.every(node => node && typeof node.id === 'string' && typeof node.name === 'string'
      && [node.x, node.y, node.w, node.h].every(Number.isFinite) && node.w > 0 && node.h > 0
      && Array.isArray(node.pre) && Array.isArray(node.suc) && [...node.pre, ...node.suc].every(id => ids.has(id))
      && Array.isArray(data.domainColors[node.domain]))
      || !data.edges.every(edge => Array.isArray(edge) && edge.length === 2 && edge.every(id => ids.has(id)))
      || !data.bands.every(band => band && [band.depth, band.y, band.h, band.count].every(Number.isFinite))) return source
    data.nodes = data.nodes.map(node => byId.get(node.id)?.role === 'integrated' ? { ...node, role: 'integrated' } : node)
    return template.replace('/*__DATA__*/null', () => JSON.stringify(data).replace(/</g, '\\u003c'))
  } catch { return source }
}
