import { afterEach, describe, expect, it } from 'vitest'

import {
  hasOutboundImageDelivered,
  markOutboundImageDelivered,
  resetOutboundImageDeliveryForTests
} from '../outboundImageDelivery'

describe('outboundImageDelivery', () => {
  afterEach(() => {
    resetOutboundImageDeliveryForTests()
  })

  it('tracks delivered realpaths per channel+chat', () => {
    expect(hasOutboundImageDelivered('ch1', '100', '/ws/a.png')).toBe(false)
    markOutboundImageDelivered('ch1', '100', '/ws/a.png')
    expect(hasOutboundImageDelivered('ch1', '100', '/ws/a.png')).toBe(true)
    // Different chat stays independent.
    expect(hasOutboundImageDelivered('ch1', '200', '/ws/a.png')).toBe(false)
    // Different channel stays independent.
    expect(hasOutboundImageDelivered('ch2', '100', '/ws/a.png')).toBe(false)
  })
})
