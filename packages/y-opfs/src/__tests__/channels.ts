import type { BroadcastChannelLike } from '#entry'

/**
 * In-memory stand-in for BroadcastChannel with deterministic delivery. Messages
 * are held until `release`, which can reorder or duplicate them.
 */
export class Hub {
  held: { to: HubChannel; data: unknown }[] = []
  posts = 0
  hold = false
  private channels = new Map<string, Set<HubChannel>>()

  factory = (name: string): BroadcastChannelLike => {
    const channel = new HubChannel(this, name)
    this.channels.set(name, (this.channels.get(name) ?? new Set()).add(channel))
    return channel
  }

  send(from: HubChannel, name: string, data: unknown) {
    this.posts++
    for (const to of this.channels.get(name) ?? []) {
      if (to === from) continue
      const entry = { to, data: structuredClone(data) }
      if (this.hold) this.held.push(entry)
      else queueMicrotask(() => to.deliver(entry.data))
    }
  }

  remove(name: string, channel: HubChannel) {
    this.channels.get(name)?.delete(channel)
  }

  release({ reverse = false, twice = false } = {}) {
    const batch = this.held.splice(0)
    if (reverse) batch.reverse()
    for (const m of batch) {
      m.to.deliver(m.data)
      if (twice) m.to.deliver(m.data)
    }
  }

  drop() {
    this.held.length = 0
  }
}

class HubChannel implements BroadcastChannelLike {
  onmessage: ((event: { data: unknown }) => void) | null = null
  constructor(
    private hub: Hub,
    private name: string,
  ) {}
  postMessage(data: unknown) {
    this.hub.send(this, this.name, data)
  }
  deliver(data: unknown) {
    this.onmessage?.({ data })
  }
  close() {
    this.onmessage = null
    this.hub.remove(this.name, this)
  }
}

/** A real BroadcastChannel whose sends can be switched off and counted. */
export function lossy() {
  const state = { dropping: false, posts: 0, sent: 0 }
  const factory = (name: string): BroadcastChannelLike => {
    const real = new BroadcastChannel(name)
    let handler: BroadcastChannelLike['onmessage'] = null
    return {
      postMessage(data) {
        state.posts++
        if (state.dropping) return
        state.sent++
        real.postMessage(data)
      },
      set onmessage(fn) {
        handler = fn
        real.onmessage = fn && ((e) => fn(e))
      },
      get onmessage() {
        return handler
      },
      close: () => real.close(),
    }
  }
  return Object.assign(factory, { state })
}

export async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for convergence')
    await new Promise((r) => setTimeout(r, 5))
  }
}
