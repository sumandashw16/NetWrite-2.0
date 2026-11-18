// An id is 'host' if it is the acting host. Members only ever hold 'cohost' | 'joiner'.
// On owner reclaim we just set actingHostId = ownerId, and the acting co-host
// falls back to 'cohost' automatically, with grantedAt untouched.
export function roleOf(room, id) {
  if (!id) return null;
  if (id === room.actingHostId) return 'host';
  return room.members.get(id)?.role ?? null;
}

// The only function the Yjs gate calls. Runs per message: two Map lookups.
export function canWrite(room, id) {
  if (room.locked) return false;
  const role = roleOf(room, id);
  if (role === 'host' || role === 'cohost') return true;
  return role === 'joiner' && room.members.get(id).canWrite === true;
}

export function can(room, actorId, action, targetId = null) {
  const actor = roleOf(room, actorId);
  if (!actor) return false;
  const manager = actor === 'host' || actor === 'cohost';
  const target = targetId ? roleOf(room, targetId) : null;

  switch (action) {
    case 'admit':
    case 'deny':
    case 'clear':    return manager;
    case 'snapshot': return room.persisted;                  // any admitted member
    case 'kick':     return targetId !== actorId &&
                            (actor === 'host' ? target !== null : manager && target === 'joiner');
    case 'setWrite': return manager && target === 'joiner';
    case 'promote':  return actor === 'host' && target === 'joiner';
    case 'demote':   return actor === 'host' && target === 'cohost';
    case 'delete':   return actor === 'host' && actorId === room.ownerId;
    default:         return false;
  }
}