// 微信一键登录的「登录 code 预取」（2026-08-13，修「隔日首次登录必失败、重试即成功」）。
//
// 根因：旧版手机号授权的 encryptedData 用「授权那一刻」端上的 session_key 加密，而旧写法在授权
// 回调**之后**才 wx.login —— 隔日 login 必刷新 session_key，后端拿新 code 换到新 key，解不开
// 旧密文（同日落在官方「最短刷新周期」内不刷新，所以同日不复现、重试即成功）。
//
// 本文件锁四件事：
//  ① 预取命中：提交用的是**预取的** code，且提交时**不再**调 wx.login
//     （再 login 一次可能把授权密文用的 key 又刷掉，等于把病根重新埋回去）；
//  ② code 单次使用：一次提交（无论成败）就作废，下一次提交不许复用同一枚；
//  ③ 超龄回退：预取超过 4 分钟（官方 5 分钟有效期留余量）不再使用，回退为提交时现取；
//  ④ 预取失败不阻断：提交时现取兜底，登录流程照常走完。
const assert = require('assert')

function freshRequire(path) {
  delete require.cache[require.resolve(path)]
  return require(path)
}

// 最小 wx / App 环境：wx.login 按次发号（code-1、code-2…），记下调用次数
function installWorld() {
  const state = { loginCalls: 0, loginFail: false, submitted: [] }
  global.wx = {
    login({ success, fail }) {
      state.loginCalls += 1
      if (state.loginFail) {
        fail(new Error('login fail'))
        return
      }
      success({ code: `code-${state.loginCalls}` })
    },
    getStorageSync: () => '',
    setStorageSync: () => {},
    removeStorageSync: () => {},
    showToast: () => {}
  }
  global.App = config => {
    global.__app = config
  }
  return state
}

;(async () => {
  const state = installWorld()
  freshRequire('../app.js')
  const app = global.__app
  // 拦下真正的登录接口：只记录提交的入参，按需成功/失败
  const api = require('../utils/api')
  let nextLoginFails = false
  api.setWechatAppLogin = payload => {
    state.submitted.push(payload)
    if (nextLoginFails) {
      nextLoginFails = false
      return Promise.reject(new Error('接口-登录失败'))
    }
    return Promise.resolve({ userToken: 'ut', jwtToken: 'jt', nickName: 'n' })
  }

  // ── ① 预取命中：用预取的 code，提交时不再现取 ─────────────────────────────
  {
    await app.prefetchLoginCode() // 登录页 onShow 干的事
    assert.strictEqual(state.loginCalls, 1, '预取本身调一次 wx.login')

    await app.loginWithWechatPhone({ encryptedData: 'ENC', iv: 'IV' })
    assert.strictEqual(state.submitted.length, 1)
    assert.strictEqual(
      state.submitted[0].code,
      'code-1',
      '提交必须用预取的 code —— 它才与授权密文的 session_key 配对'
    )
    assert.strictEqual(state.submitted[0].wxEncrypData, 'ENC')
    assert.strictEqual(state.submitted[0].wxIvData, 'IV')
    assert.strictEqual(
      state.loginCalls,
      1,
      '预取命中时提交阶段不许再调 wx.login（再刷一次可能把密文的 key 刷掉）'
    )
  }

  // ── ② 单次使用：上一次提交已消费，未再预取的下一次提交回退现取，不复用旧 code ──
  {
    await app.loginWithWechatPhone({ encryptedData: 'ENC2', iv: 'IV2' })
    assert.strictEqual(state.submitted[1].code, 'code-2', '预取已消费 → 现取新 code 兜底')
    assert.strictEqual(state.loginCalls, 2)
  }

  // ── ②' 提交失败同样消费掉预取 code：登录页 catch 里会重新预取，重试用新的一枚 ──
  {
    await app.prefetchLoginCode() // code-3
    nextLoginFails = true
    await app.loginWithWechatPhone({ encryptedData: 'ENC3', iv: 'IV3' }).catch(() => {})
    assert.strictEqual(state.submitted[2].code, 'code-3', '失败的提交用的也是预取 code')

    await app.prefetchLoginCode() // 登录页失败分支补预取：code-4
    await app.loginWithWechatPhone({ encryptedData: 'ENC4', iv: 'IV4' })
    assert.strictEqual(
      state.submitted[3].code,
      'code-4',
      '重试用的是失败后补预取的新 code，绝不复用已消费的那枚（code 单次使用）'
    )
  }

  // ── ③ 超龄回退：预取超过 4 分钟不再使用，现取兜底 ────────────────────────
  {
    await app.prefetchLoginCode() // code-5
    app._prefetchedLoginCode.fetchedAt = Date.now() - 4 * 60 * 1000 - 1
    const before = state.loginCalls
    await app.loginWithWechatPhone({ encryptedData: 'ENC5', iv: 'IV5' })
    assert.strictEqual(state.loginCalls, before + 1, '超龄后必须现取一枚新 code')
    assert.notStrictEqual(
      state.submitted[4].code,
      'code-5',
      '临期 code 不许上送——网络慢一点就是「code 已过期」的新失败'
    )
  }

  // ── ④ 预取失败不阻断：提交时现取兜底，登录照常成功 ───────────────────────
  {
    state.loginFail = true
    await app.prefetchLoginCode() // 静默失败，不抛
    state.loginFail = false
    await app.loginWithWechatPhone({ encryptedData: 'ENC6', iv: 'IV6' })
    const last = state.submitted[state.submitted.length - 1]
    assert.ok(last.code, '预取失败时提交现取的 code 照常可用')
  }

  console.log('login-code-prefetch.test.js 全部通过')
})().catch(error => {
  console.error(error)
  process.exit(1)
})
