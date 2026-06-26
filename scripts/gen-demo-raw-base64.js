// 把 assets/demo.raw 编成 base64 模块，供「本地 .raw 直发测试」在真机上读取
// （小程序 FileSystemManager 读不了代码包内任意文件，故改为编译期内嵌 base64）。
//
// 用法：换了新的 demo.raw 后，在项目根目录执行：
//   node scripts/gen-demo-raw-base64.js
//
// 它会重写 subpackages/projection/result/demo-raw-base64.js。
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const src = path.join(root, 'assets', 'demo.raw')
const out = path.join(root, 'subpackages', 'projection', 'result', 'demo-raw-base64.js')

const raw = fs.readFileSync(src)
const b64 = raw.toString('base64')
const header =
  '// 自动生成：assets/demo.raw 的 base64（仅本地直发测试用，勿手改）。\n' +
  '// 换成别的 .raw 后执行 `node scripts/gen-demo-raw-base64.js` 重新生成。\n'

fs.writeFileSync(out, header + 'module.exports = \'' + b64 + '\'\n')
console.log('OK 生成 demo-raw-base64.js：rawBytes=' + raw.length + ' base64Chars=' + b64.length)
