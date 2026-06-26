// 监听 assets/demo.raw，一改动就自动把它重新编成 demo-raw-base64.js。
// 用法（在项目根目录跑一次，挂着别关）：
//   node scripts/watch-demo-raw.js
// 之后你只管用新的 .raw 覆盖 assets/demo.raw，本脚本会自动重生成 base64，
// 微信开发者工具检测到文件变化会自动重新编译，你在设备上重新投屏即可。
// 注意：小程序 require 有模块缓存，每次仍需在开发者工具里「重新编译(Ctrl+B)」才会用上新数据。
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const src = path.join(root, 'assets', 'demo.raw')
const out = path.join(root, 'subpackages', 'projection', 'result', 'demo-raw-base64.js')

function regen() {
  try {
    const raw = fs.readFileSync(src)
    const b64 = raw.toString('base64')
    const header =
      '// 自动生成：assets/demo.raw 的 base64（仅本地直发测试用，勿手改）。\n' +
      '// 由 scripts/watch-demo-raw.js 监听自动重生成。\n'
    fs.writeFileSync(out, header + 'module.exports = \'' + b64 + '\'\n')
    console.log(`[${new Date().toLocaleTimeString()}] 已重生成 demo-raw-base64.js（demo.raw=${raw.length} 字节）`)
  } catch (e) {
    console.error('重生成失败：', e.message)
  }
}

regen() // 启动先同步一次

let timer = null
fs.watch(path.dirname(src), (event, filename) => {
  if (filename !== 'demo.raw') return
  clearTimeout(timer) // 去抖：覆盖文件常触发多次事件，合并成一次
  timer = setTimeout(regen, 150)
})

console.log('正在监听 assets/demo.raw …（Ctrl+C 退出）。覆盖该文件即自动重生成 base64。')
