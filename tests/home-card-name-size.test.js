// 首页设备卡三项（2026-10-27）：
//   ① 版式：设备图 + 文字整体居中、间距固定（原 space-around 让蓝牙 / WiFi 两种卡都偏左）；
//   ② 默认昵称 = 完整蓝牙广播名：蓝牙版绑定传 name / localName 里较长的那个，WiFi 版传 IJ_ 广播名（原来传产品名）；
//   ③ 设备卡显示「WiFi版·尺寸 / 蓝牙版·尺寸」，尺寸取设备列表的 sizeModel，没配显示 --寸。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

const { fullBroadcastName } = require('../utils/broadcast-match')

function loadApi(posts) {
  const modules = {
    './request': {
      async post(url, data) {
        posts.push({ url, data })
        return { productName: '' }
      },
      async get() { return null }
    },
    './config': require('../utils/config'),
    './device-id': require('../utils/device-id'),
    './device-thumb': require('../utils/device-thumb'),
    './md5': require('../utils/md5')
  }
  const sandbox = { module: { exports: {} }, require: target => modules[target], console: { log() {}, warn() {} }, setTimeout, clearTimeout }
  vm.runInNewContext(read('utils/api.js'), sandbox, { filename: 'api.js' })
  const api = sandbox.module.exports
  api.getDevices = async () => []
  return api
}

async function main() {
  {
    assert.equal(fullBroadcastName({ name: 'IJ_E348C2', localName: 'IJ_E348C21ED428' }), 'IJ_E348C21ED428', '取较长的 localName')
    assert.equal(fullBroadcastName({ name: ' EF6-370 ', localName: '' }), 'EF6-370', '去首尾空白')
    assert.equal(fullBroadcastName({ name: '', localName: '' }), '', '都没有返回空串，由调用方回落')
    assert.equal(fullBroadcastName(null), '')
    console.log('PASS 完整广播名：name / localName 取较长的')
  }
  {
    const posts = []
    const api = loadApi(posts)
    await api.bindWifiDevice({ deviceNo: 'E348C21ED428', productId: 21, productName: 'WiFi相框', broadcastName: 'IJ_E348C21ED428' })
    assert.equal(posts[0].data.productName, 'IJ_E348C21ED428', 'WiFi 版默认昵称传完整广播名，不是产品名')
    await api.bindWifiDevice({ deviceNo: 'E348C21ED428', productId: 21, productName: 'WiFi相框', broadcastName: '' })
    assert.equal(posts[1].data.productName, 'WiFi相框', '广播名取不到才回落产品名')
    console.log('PASS WiFi 绑定：昵称传完整广播名')
  }
  {
    const bind = read('subpackages/device/bind/bind.js')
    assert.ok(/name: broadcastMatch\.fullBroadcastName\(scanDevice\) \|\| scanDevice\.name/.test(bind), '蓝牙版绑定昵称取完整广播名')
    assert.ok(/fullBroadcastName\(device\)[^\n]*\n[\s\S]{0,200}wifiProvision\.setTarget\(\{[\s\S]{0,120}name: fullName/.test(bind), 'WiFi 配网交接带完整广播名')
    console.log('PASS 绑定页：两类设备都交出完整广播名')
  }
  {
    const tpl = read('pages/home/home.wxml')
    const card = tpl.slice(tpl.indexOf('class="device-title"'), tpl.indexOf('<block wx:if="{{!item.isWifi}}">'))
    assert.ok(/class="comm-badge \{\{item\.isWifi \? 'comm-badge--wifi' : 'comm-badge--ble'\}\}"/.test(card), '标签在名称下、状态前，两类卡都有')
    assert.ok(card.includes("{{item.isWifi ? 'WiFi版' : '蓝牙版'}}·{{item.sizeModel || '--寸'}}"), '类型 + 尺寸，没配显示 --寸')
    assert.ok(/sizeModel: String\(device\.sizeModel \|\| ''\)\.trim\(\)/.test(read('pages/home/home.js')), '首页归一化透传 sizeModel')
    console.log('PASS 设备卡：显示类型 + 尺寸')
  }
  {
    const css = read('pages/home/home.wxss')
    const carousel = css.slice(css.indexOf('.device-carousel {'), css.indexOf('}', css.indexOf('.device-carousel {')))
    assert.ok(/justify-content: center;/.test(carousel) && /gap: 44rpx;/.test(carousel), '图文整体居中、固定间距')
    assert.equal(carousel.indexOf('space-around'), -1, '不再用 space-around')
    const orbit = css.slice(css.indexOf('.device-orbit {'), css.indexOf('}', css.indexOf('.device-orbit {')))
    assert.ok(/flex: 0 0 auto;/.test(orbit), '设备图不被长名称挤小')
    console.log('PASS 版式：设备卡内容居中')
  }
  console.log('home-card-name-size: all passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
