// A solution check is about (problem, knowledge node), not just the problem.
// Keep the existing problem-only entries readable when they name the same node.
export function scopedProblemKey(problemKey, node) {
  return `${problemKey}|${encodeURIComponent(node)}`
}

export function verifiedProblemForNode(ledger, problemKey, node) {
  if (!problemKey || !node) return null
  const scoped = ledger?.[scopedProblemKey(problemKey, node)]
  const legacy = ledger?.[problemKey]
  const entry = scoped?.node === node ? scoped : legacy?.node === node ? legacy : null
  return typeof entry?.gist === 'string' && entry.gist.trim().length >= 12 ? entry : null
}

export function rejectedProblemForNode(ledger, problemKey, node) {
  if (!problemKey || !node) return null
  const entry = ledger?.[scopedProblemKey(problemKey, node)]
  return entry?.node === node && typeof entry.reason === 'string' && entry.reason.trim()
    ? entry : null
}

export function recordProblemRejection(ledger, problemKey, node, reason, at) {
  if (!problemKey || !node || !String(reason ?? '').trim()) {
    throw new TypeError('problem, node and rejection reason are required')
  }
  return {
    ...ledger,
    [scopedProblemKey(problemKey, node)]: { node, reason: String(reason).trim(), at },
  }
}

export function clearProblemRejection(ledger, problemKey, node) {
  const key = scopedProblemKey(problemKey, node)
  if (!Object.hasOwn(ledger ?? {}, key)) return ledger ?? {}
  const next = { ...ledger }
  delete next[key]
  return next
}
