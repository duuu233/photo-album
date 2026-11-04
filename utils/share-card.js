// 设备分享卡片封面（2026-11-04）。
//
// 微信卡片的 imageUrl 不传时默认截当前页面，分享列表的截图里是头像、成员和按钮，信息杂、也不好看。
// 这里用离屏 Canvas 画一张 5:4 的封面：浅色渐变底 + 机型设备图 + 设备名 / 规格 + 橙色「接受邀请」按钮，
// 配色与页面一致（橙 #ff9140 → #ff6a20，正文 #2a2d32，次要 #8b9098）。
//
// 画不出来（基础库没有离屏 Canvas、设备图解码失败、导出失败）时退回机型设备图本身，不退回页面截图。
const deviceThumb = require('./device-thumb')

// 逻辑尺寸 500×400（微信卡片 5:4），导出时 ×1.5 = 750×600
const WIDTH = 500
const HEIGHT = 400
const SCALE = 1.5
const PAD = 36
const FONT = '"PingFang SC", "Helvetica Neue", sans-serif'

const ICON = { x: PAD, y: 104, size: 152 }
const TEXT_X = ICON.x + ICON.size + 26
const TEXT_WIDTH = WIDTH - TEXT_X - PAD
const NAME = { size: 38, lineHeight: 50, maxLines: 2 }
const SPEC = { size: 24, gap: 14 }
const BUTTON = { x: PAD, y: 304, w: WIDTH - PAD * 2, h: 64, text: '点击接受邀请' }
const TAG = { x: PAD, y: 36, h: 40, text: '设备共享邀请' }

function font(size, bold) {
  return `${bold ? 'bold ' : ''}${size}px ${FONT}`
}

// 卡片上要画的内容：设备名、规格（WiFi版 · 尺寸，没配尺寸只写 WiFi版）、设备图
function cardInfo(device) {
  const d = device || {}
  const sizeModel = String(d.sizeModel || '').trim()
  return {
    name: String(d.name || '').trim() || '智能相框',
    spec: sizeModel ? `WiFi版 · ${sizeModel}` : 'WiFi版',
    thumb: deviceThumb.thumbOf(d)
  }
}

// 按宽度折行，最多 maxLines 行，放不下的最后一行末尾补「…」。逐字切，中英文混排都按实际宽度算
function wrapText(ctx, text, maxWidth, maxLines) {
  const chars = Array.from(String(text || ''))
  const lines = []
  let line = ''
  for (let i = 0; i < chars.length; i++) {
    const next = line + chars[i]
    if (line && ctx.measureText(next).width > maxWidth) {
      if (lines.length === maxLines - 1) {
        let rest = line
        while (rest && ctx.measureText(rest + '…').width > maxWidth) {
          rest = rest.slice(0, -1)
        }
        lines.push(rest + '…')
        return lines
      }
      lines.push(line)
      line = chars[i]
    } else {
      line = next
    }
  }
  if (line) {
    lines.push(line)
  }
  return lines
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function glow(ctx, x, y, r, rgb, alpha) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r)
  g.addColorStop(0, `rgba(${rgb}, ${alpha})`)
  g.addColorStop(1, `rgba(${rgb}, 0)`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, WIDTH, HEIGHT)
}

// 在逻辑坐标（500×400）上画整张卡片；img 为已解码的设备图，可为空（只画文字）
function drawCard(ctx, info, img) {
  // 底：暖白 → 浅蓝，右上一团橙色光、左下一团蓝色光
  const bg = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT)
  bg.addColorStop(0, '#fff6ee')
  bg.addColorStop(1, '#e8f2ff')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, WIDTH, HEIGHT)
  glow(ctx, WIDTH - 30, 20, 240, '255, 145, 64', 0.24)
  glow(ctx, 0, HEIGHT, 220, '110, 165, 255', 0.16)

  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'

  // 左上标签
  ctx.font = font(20, true)
  const tagW = ctx.measureText(TAG.text).width + 36
  roundRect(ctx, TAG.x, TAG.y, tagW, TAG.h, TAG.h / 2)
  ctx.fillStyle = 'rgba(255, 106, 32, 0.12)'
  ctx.fill()
  ctx.fillStyle = '#ff6a20'
  ctx.fillText(TAG.text, TAG.x + 18, TAG.y + TAG.h / 2)

  // 设备图（自带圆角底），下方一层淡橙色投影
  if (img) {
    ctx.save()
    ctx.shadowColor = 'rgba(255, 106, 32, 0.22)'
    ctx.shadowBlur = 28
    ctx.shadowOffsetY = 10
    ctx.drawImage(img, ICON.x, ICON.y, ICON.size, ICON.size)
    ctx.restore()
  }

  // 设备名（最多两行）+ 规格，整体与设备图垂直居中
  ctx.font = font(NAME.size, true)
  const lines = wrapText(ctx, info.name, TEXT_WIDTH, NAME.maxLines)
  const blockH = lines.length * NAME.lineHeight + SPEC.gap + SPEC.size
  let y = ICON.y + ICON.size / 2 - blockH / 2 + NAME.lineHeight / 2
  ctx.fillStyle = '#2a2d32'
  lines.forEach(line => {
    ctx.fillText(line, TEXT_X, y)
    y += NAME.lineHeight
  })
  ctx.font = font(SPEC.size, false)
  ctx.fillStyle = '#8b9098'
  ctx.fillText(wrapText(ctx, info.spec, TEXT_WIDTH, 1)[0] || '', TEXT_X, y - NAME.lineHeight / 2 + SPEC.gap + SPEC.size / 2)

  // 底部按钮
  const btn = ctx.createLinearGradient(0, BUTTON.y, 0, BUTTON.y + BUTTON.h)
  btn.addColorStop(0, '#ff9140')
  btn.addColorStop(1, '#ff6a20')
  roundRect(ctx, BUTTON.x, BUTTON.y, BUTTON.w, BUTTON.h, BUTTON.h / 2)
  ctx.fillStyle = btn
  ctx.fill()
  ctx.font = font(28, true)
  ctx.textAlign = 'center'
  ctx.fillStyle = '#ffffff'
  ctx.fillText(BUTTON.text, BUTTON.x + BUTTON.w / 2, BUTTON.y + BUTTON.h / 2)
}

function loadImage(canvas, src) {
  return new Promise(resolve => {
    const img = canvas.createImage()
    img.onload = () => resolve(img)
    img.onerror = () => {
      console.warn('[分享卡片] 设备图解码失败，只画文字', src)
      resolve(null)
    }
    img.src = src
  })
}

// 生成封面，resolve 临时文件路径；任何一步失败都 resolve 设备图本身（不 reject，调用方直接用）
async function render(device) {
  const info = cardInfo(device)
  if (typeof wx === 'undefined' || typeof wx.createOffscreenCanvas !== 'function') {
    return info.thumb
  }
  try {
    const canvas = wx.createOffscreenCanvas({ type: '2d', width: WIDTH * SCALE, height: HEIGHT * SCALE })
    const ctx = canvas.getContext('2d')
    const img = await loadImage(canvas, info.thumb)
    ctx.scale(SCALE, SCALE)
    drawCard(ctx, info, img)
    return await new Promise((resolve, reject) => {
      wx.canvasToTempFilePath({
        canvas,
        fileType: 'png',
        success: res => resolve(res.tempFilePath),
        fail: reject
      })
    })
  } catch (error) {
    console.warn('[分享卡片] 生成失败，改用设备图', error && (error.errMsg || error.message))
    return info.thumb
  }
}

module.exports = {
  WIDTH,
  HEIGHT,
  SCALE,
  cardInfo,
  wrapText,
  drawCard,
  render
}
