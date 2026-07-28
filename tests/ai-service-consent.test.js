const assert = require('node:assert/strict')

const storage = {}
let currentUser = { id: 'user-a' }

global.wx = {
  getStorageSync(key) {
    return storage[key]
  },
  setStorageSync(key, value) {
    storage[key] = value
  },
  removeStorageSync(key) {
    delete storage[key]
  }
}

global.getApp = () => ({
  globalData: {
    userInfo: currentUser
  }
})

const consent = require('../utils/ai-service-consent')

assert.equal(consent.hasCurrentUserConsent(), false)
assert.equal(consent.grantCurrentUserConsent(), true)
assert.equal(consent.hasCurrentUserConsent(), true)

currentUser = { id: 'user-b' }
assert.equal(consent.hasCurrentUserConsent(), false, '切换用户不能继承上一用户的同意状态')
assert.equal(consent.grantCurrentUserConsent(), true)
assert.equal(consent.hasCurrentUserConsent(), true)

consent.clearCurrentUserConsent()
assert.equal(consent.hasCurrentUserConsent(), false, '退出/注销清理后应重新确认')

currentUser = { id: 'user-a' }
assert.equal(consent.hasCurrentUserConsent(), true, '清理当前用户不能误删其他用户的记录')

delete storage[consent.STORAGE_KEY]
assert.equal(consent.hasCurrentUserConsent(), false, '缓存丢失后应重新确认')

console.log('ai service consent tests passed')
