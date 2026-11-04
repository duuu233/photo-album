// 防重复点击（2026-11-04，先覆盖所有「投屏」相关按钮）。
//
// 用法：在页面注册处按方法名指定锁的 key，方法体不用改：
//   Page(fold.adapt(tapGuard.wrap({ ...页面定义 }, { startProjection: 'projection', chooseCamera: 'pick' })))
//
// 规则（同一页面实例、同一个 key 共用一把锁）：
//   · 上一次还没执行完——方法返回的 Promise 未结束（连接设备、选图、下载、跳转前的准备）——后续调用直接忽略；
//   · 执行完后再冷却 COOLDOWN_MS，挡住 navigateTo / redirectTo 转场期间的连点（两次跳转会叠两层页面或报错）；
//   · 兜底：一次执行超过 MAX_HOLD_MS 还没结束（异常挂住）就不再拦，避免按钮永久失灵。
// 被忽略的调用不弹提示，返回 resolve(undefined) 的 Promise。
//
// ⚠️ 锁只覆盖方法自己返回的 Promise：方法里调后续流程要 return / await，否则锁会提前放开。
//    同一调用链上的方法不要用同一个 key 分别包（外层持锁时内层会被当成重复点击忽略）。
const COOLDOWN_MS = 500
const MAX_HOLD_MS = 60000

function now() {
  return Date.now()
}

function locked(lock, at) {
  if (!lock) {
    return false
  }
  return lock.running ? at - lock.since < MAX_HOLD_MS : at < lock.until
}

// 在 owner（页面实例）上按 key 执行 task；正在执行或冷却中返回 resolve(undefined)
function run(owner, key, task) {
  const state = owner.__tapGuard || (owner.__tapGuard = {})
  const at = now()
  if (locked(state[key], at)) {
    return Promise.resolve(undefined)
  }
  const lock = { running: true, since: at, until: 0 }
  state[key] = lock
  const release = () => {
    if (state[key] === lock) {
      lock.running = false
      lock.until = now() + COOLDOWN_MS
    }
  }
  let result
  try {
    result = task()
  } catch (error) {
    release()
    throw error
  }
  return Promise.resolve(result).then(
    value => {
      release()
      return value
    },
    error => {
      release()
      throw error
    }
  )
}

// 当前是否被锁（执行中或冷却中）
function isLocked(owner, key) {
  return !!(owner && owner.__tapGuard && locked(owner.__tapGuard[key], now()))
}

// 把 definition 里指定的方法换成带锁版本；方法名写错直接报错，避免静默漏防
function wrap(definition, keys) {
  Object.keys(keys).forEach(name => {
    const fn = definition[name]
    if (typeof fn !== 'function') {
      throw new Error(`tapGuard.wrap：${name} 不是页面方法`)
    }
    const key = keys[name]
    definition[name] = function guarded(...args) {
      return run(this, key, () => fn.apply(this, args))
    }
  })
  return definition
}

module.exports = {
  COOLDOWN_MS,
  MAX_HOLD_MS,
  run,
  isLocked,
  wrap
}
