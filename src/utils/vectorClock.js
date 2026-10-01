export function createClock(actorId = 'server', initial = 0) {
  return { [actorId]: initial }
}

export function cloneClock(clock = {}) {
  return { ...clock }
}

export function tick(clock = {}, actorId) {
  return { ...clock, [actorId]: (clock[actorId] ?? 0) + 1 }
}

export function mergeClock(left = {}, right = {}) {
  const result = { ...left }
  for (const [actor, counter] of Object.entries(right)) {
    result[actor] = Math.max(result[actor] ?? 0, counter)
  }
  return result
}

export function compareClocks(left = {}, right = {}) {
  let leftHas = false
  let rightHas = false
  for (const [actor, counter] of Object.entries(left)) {
    if (counter > (right[actor] ?? 0)) leftHas = true
  }
  for (const [actor, counter] of Object.entries(right)) {
    if (counter > (left[actor] ?? 0)) rightHas = true
  }
  if (!leftHas && !rightHas) return 'equal'
  if (leftHas && !rightHas) return 'after'
  if (!leftHas && rightHas) return 'before'
  return 'concurrent'
}

export function happensBefore(left, right) {
  return compareClocks(left, right) === 'before'
}

export function topoSortEvents(events) {
  return [...events].sort((a, b) => {
    const relation = compareClocks(a.clock, b.clock)
    if (relation === 'before') return -1
    if (relation === 'after') return 1
    return (a.createdAt || '').localeCompare(b.createdAt || '') || a.eventId.localeCompare(b.eventId)
  })
}
