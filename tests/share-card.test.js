// 设备分享卡片封面（utils/share-card.js）：折行 / 省略、卡片内容、绘制不出界、生成失败退回设备图。
// 运行：node tests/share-card.test.js
const assert = require('node:assert/strict')
const card = require('../utils/share-card')

let checks = 0
function checked(name) { checks++; console.log('PASS ' + name) }

// 假 ctx：中文字宽 = 字号，ASCII 按半宽（够判折行和出界），记下 fillText / drawImage
function textWidth(text, size) {
  return Array.from(text).reduce((sum, ch) => sum + (ch.charCodeAt(0) < 128 ? size / 2 : size), 0)
}
function fakeCtx() {
  const calls = { text: [], image: [] }
  const gradient = () => ({ addColorStop() {} })
  const ctx = {
    font: '10px sans-serif',
    calls,
    measureText(text) { return { width: textWidth(text, parseInt(/(\d+)px/.exec(this.font)[1], 10)) } },
    fillText(text, x, y) { calls.text.push({ text, x, y, font: this.font, align: this.textAlign }) },
    drawImage(img, x, y, w, h) { calls.image.push({ x, y, w, h }) },
    createLinearGradient: gradient,
    createRadialGradient: gradient,
    fillRect() {}, beginPath() {}, moveTo() {}, arcTo() {}, closePath() {}, fill() {}, save() {}, restore() {}, scale() {}
  }
  return ctx
}

async function main() {
  {
    const ctx = fakeCtx()
    ctx.font = '10px x'
    assert.deepEqual(card.wrapText(ctx, '客厅相框', 100, 2), ['客厅相框'], '放得下不折行')
    assert.deepEqual(card.wrapText(ctx, '一二三四五六七八九十甲乙', 100, 2), ['一二三四五六七八九十', '甲乙'], '超宽折到第二行')
    const cut = card.wrapText(ctx, '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑', 100, 2)
    assert.equal(cut.length, 2, '最多两行')
    assert.ok(cut[1].endsWith('…') && ctx.measureText(cut[1]).width <= 100, '第二行放不下补省略号且不超宽')
    checked('设备名折行与省略')
  }
  {
    assert.deepEqual(card.cardInfo({ name: ' 客厅相框 ', sizeModel: '7.3寸', broadcastId: 'EB-169' }), {
      name: '客厅相框', spec: 'WiFi版 · 7.3寸', thumb: '/assets/images/home-device-circle-thumb.png'
    }, '设备名、规格、机型设备图')
    const empty = card.cardInfo({})
    assert.equal(empty.name, '智能相框', '没有设备名用默认')
    assert.equal(empty.spec, 'WiFi版', '没配尺寸只写 WiFi版')
    assert.equal(empty.thumb, '/assets/images/home-device-thumb.png')
    checked('卡片内容')
  }
  {
    const ctx = fakeCtx()
    card.drawCard(ctx, card.cardInfo({ name: '这是一个非常非常长的设备名字一直写到放不下为止', sizeModel: '7.3寸' }), {})
    const texts = ctx.calls.text.map(item => item.text)
    assert.ok(texts.includes('设备共享邀请'), '左上标签')
    assert.ok(texts.includes('WiFi版 · 7.3寸'), '规格')
    assert.ok(texts.includes('点击接受邀请'), '底部按钮')
    assert.ok(texts.some(text => text.endsWith('…')), '长设备名省略')
    ctx.calls.text.forEach(item => {
      const size = parseInt(/(\d+)px/.exec(item.font)[1], 10)
      const width = textWidth(item.text, size)
      const left = item.align === 'center' ? item.x - width / 2 : item.x
      assert.ok(left >= 0 && left + width <= card.WIDTH, `文字不出左右边：${item.text}`)
      assert.ok(item.y - size / 2 >= 0 && item.y + size / 2 <= card.HEIGHT, `文字不出上下边：${item.text}`)
    })
    assert.equal(ctx.calls.image.length, 1, '画了设备图')
    const noImg = fakeCtx()
    card.drawCard(noImg, card.cardInfo({ name: '客厅' }), null)
    assert.equal(noImg.calls.image.length, 0, '设备图解码失败只画文字')
    checked('绘制内容与边界')
  }
  {
    assert.equal(await card.render({ name: '客厅' }), '/assets/images/home-device-thumb.png', '没有离屏 Canvas → 设备图')
    const created = []
    global.wx = {
      createOffscreenCanvas(options) {
        created.push(options)
        const ctx = fakeCtx()
        return { getContext: () => ctx, createImage: () => { const img = {}; Object.defineProperty(img, 'src', { set() { img.onload() } }); return img } }
      },
      canvasToTempFilePath(options) { options.success({ tempFilePath: 'wxfile://card.png' }) }
    }
    assert.equal(await card.render({ name: '客厅' }), 'wxfile://card.png', '生成临时文件')
    assert.deepEqual(created[0], { type: '2d', width: card.WIDTH * card.SCALE, height: card.HEIGHT * card.SCALE }, '5:4 画布')
    assert.equal(created[0].width / created[0].height, 5 / 4)
    global.wx.canvasToTempFilePath = options => options.fail({ errMsg: 'canvasToTempFilePath:fail' })
    assert.equal(await card.render({ name: '客厅', broadcastId: 'EC-370' }), '/assets/images/home-device-rectangle-thumb.png', '导出失败 → 设备图，不退回页面截图')
    delete global.wx
    checked('生成与失败兜底')
  }
  console.log(`share-card: ${checks} groups passed`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
