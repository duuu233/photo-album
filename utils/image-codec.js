// 图片编解码层：把普通图片/测试图转换成电子相框需要的「六色 4bpp 原始帧缓存」，并提供整图 CRC32。
//
// 为什么需要这一步？
//   墨水屏不认识 JPG/PNG。它的一帧画面是一段「裸数据」：每个像素只用 4 个二进制位（4bpp）表示颜色，
//   也就是只能取 0~15 这 16 个值，本屏实际只用其中 6 个值代表 6 种颜色（黑/白/黄/红/蓝/绿）。
//   两个像素正好拼成 1 个字节（高 4 位 = 左边像素，低 4 位 = 右边像素）。
//   所以一张 680×960 的图，数据量 = 680×960 ÷ 2 = 326400 字节，与文档 6.8.1 的示例一致。
//
// ⚠️ 重要提醒（第一次对接务必确认）：
//   1) 「颜色 → nibble 值」的对应关系（调色板）来自 PRD「图片数据格式 FORMAT=0x01」颜色值表：
//      黑0x0 白0x1 黄0x2 红0x3 蓝0x5 绿0x6（注意蓝、绿不是连续的 0x4/0x5，0x4 是空缺值）。
//   2) 两个像素谁放高 4 位（HIGH_NIBBLE_FIRST），不同固件也可能相反。颜色左右镜像/错位时改它。
//   先用「彩条测试图(buildColorBars)」联调最稳：它直接铺 6 个色块，能直观验证收发链路与颜色映射。

// 六色调色板。每项两个用途必须分清：
//   · nibble —— 写入帧缓存的 4bit 值，严格对应 PRD FORMAT=0x01 颜色值表，【绝对不能改】（黑0/白1/黄2/红3/蓝5/绿6）。
//   · rgb    —— 仅用于「原图像素归到哪个墨水色」的最近颜色匹配 + 抖动误差计算，应尽量等于【真机实际显示的颜色】。
// 黑/白保留纯值作无彩色锚点；黄/红/蓝/绿为【实拍校准值】（已在 APP 版彩色测试图上校验过色准，搬运自此）。
// 标定来源：微信图片_20260615214635_303_12.jpg 拍屏（彩条测试图），取每条色带中位 RGB（避开高光反光，取 y45%~85%）
//   黑 29,24,39 · 白 180,182,180 · 黄 194,187,55 · 红 112,64,63 · 蓝 71,84,145 · 绿 82,104,92
// 再按实测黑/白点线性归一化到 0~255 工作空间：归一 =(实测−黑点)/(白点−黑点)×255（负值钳到 0、超 255 钳到 255）。
//   黑点(29,24,39) 白点(180,182,180)；分母 R151 G158 B141。
// ⚠️ 重新校准：传彩条 → 中性光拍屏 → 取色带中位 RGB → 套上面公式 → 替换下面四个彩色项（nibble 别动）。
const PALETTE = [
  { nibble: 0x0, rgb: [0, 0, 0], name: '黑' }, // 黑、白保留纯值当无彩色锚点，避免灰阶被错归到彩色
  { nibble: 0x1, rgb: [255, 255, 255], name: '白' },
  { nibble: 0x2, rgb: [255, 255, 29], name: '黄' },
  { nibble: 0x3, rgb: [140, 65, 43], name: '红' }, // 实机为偏暗的赤茶，非纯红
  { nibble: 0x5, rgb: [71, 97, 192], name: '蓝' },
  { nibble: 0x6, rgb: [90, 129, 96], name: '绿' } // 实机为偏淡的灰绿(sage)
]

// true：每字节高 4 位放「左边/靠前」的像素；false：反过来。
const HIGH_NIBBLE_FIRST = true

// 一张图需要多少字节 = 宽 × 高 ÷ 2（每像素 4bit）
function bytesPerImage(width, height) {
  return Math.ceil((width * height) / 2)
}

// 把一串 nibble（每元素 0~15，长度 = 宽×高）打包成 4bpp 字节流（每 2 像素 1 字节）
function packNibbles(nibbles) {
  const out = new Uint8Array(Math.ceil(nibbles.length / 2))
  for (let i = 0; i < out.length; i++) {
    const a = nibbles[i * 2] & 0x0f // 前一个像素
    const b = (nibbles[i * 2 + 1] || 0) & 0x0f // 后一个像素（落单时补 0）
    out[i] = HIGH_NIBBLE_FIRST ? (a << 4) | b : (b << 4) | a
  }
  return out
}

// 找出与给定 RGB 最接近的调色板颜色，返回其在 PALETTE 中的下标（欧氏距离最近）。
// 抖动量化既要拿到 nibble 又要拿到这个颜色的 RGB 来算误差，所以返回下标而不是 nibble。
function nearestPaletteIndex(r, g, b) {
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < PALETTE.length; i++) {
    const [pr, pg, pb] = PALETTE[i].rgb
    const dist = (r - pr) * (r - pr) + (g - pg) * (g - pg) + (b - pb) * (b - pb)
    if (dist < bestDist) {
      bestDist = dist
      best = i
    }
  }
  return best
}

// 生成彩条测试图：把屏幕按竖条均分成 6 段，依次铺 6 种颜色。
// 联调首选——不依赖任何图片，数据尺寸天然正确，肉眼就能核对颜色与左右方向。
// 返回 { data: Uint8Array, width, height, dataSize }
function buildColorBars(width, height) {
  const nibbles = new Uint8Array(width * height)
  const bandWidth = width / PALETTE.length
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const band = Math.min(PALETTE.length - 1, Math.floor(x / bandWidth))
      nibbles[y * width + x] = PALETTE[band].nibble
    }
  }
  const data = packNibbles(nibbles)
  return { data, width, height, dataSize: data.length }
}

// 生成纯色测试图（例如整屏白），用于最小化验证刷新是否生效
function buildSolid(width, height, nibble) {
  const nibbles = new Uint8Array(width * height).fill(nibble & 0x0f)
  const data = packNibbles(nibbles)
  return { data, width, height, dataSize: data.length }
}

// 把误差 (er,eg,eb) 按权重 w 扩散到 (x,y) 像素的浮点缓存上（越界则丢弃）
function spreadError(buf, x, y, width, height, er, eg, eb, w) {
  if (x < 0 || x >= width || y < 0 || y >= height) {
    return
  }
  const i = (y * width + x) * 3
  buf[i] += er * w
  buf[i + 1] += eg * w
  buf[i + 2] += eb * w
}

function clamp255(v) {
  return v < 0 ? 0 : (v > 255 ? 255 : v)
}

// 量化前的观感增强：六色硬量化会丢掉大量中间调，先适度提对比度+饱和度，能让主体在 6 色下更鲜明、不发灰。
// 对单像素：先围绕中灰(128)拉对比度，再围绕自身感知亮度拉饱和度。contrast / saturation = 1 即不改变。
function enhancePixel(r, g, b, contrast, saturation) {
  r = (r - 128) * contrast + 128
  g = (g - 128) * contrast + 128
  b = (b - 128) * contrast + 128
  const lum = 0.299 * r + 0.587 * g + 0.114 * b // 感知亮度（饱和度围绕它拉开各通道）
  r = lum + (r - lum) * saturation
  g = lum + (g - lum) * saturation
  b = lum + (b - lum) * saturation
  return [clamp255(r), clamp255(g), clamp255(b)]
}

// 把 Canvas 的 ImageData（RGBA 像素数组）量化成六色帧缓存。
// 入参 imageData 来自页面把用户选的图片画到目标尺寸 canvas 后 getImageData 的结果。
//
// 流程：① 量化前先做观感增强(对比度/饱和度) → ② Floyd–Steinberg 误差扩散抖动：每像素量化到最近 6 色后，
// 把「原色 - 量化色」的误差按 7/16、3/16、5/16、1/16 扩散到右/左下/下/右下相邻像素，肉眼会把密集色点
// 空间混合成中间色，缓解 6 色硬量化的大色块/断层，渐变、肤色等过渡更自然。
// options：dither===false 关抖动；contrast / saturation 自定增强强度（默认 1.12 / 1.28，传 1 即不增强）。
function fromImageData(imageData, width, height, options) {
  const px = imageData.data // [r,g,b,a, r,g,b,a, ...]
  const count = width * height
  const nibbles = new Uint8Array(count)
  const opt = options || {}
  const dither = opt.dither !== false
  const contrast = Number.isFinite(opt.contrast) ? opt.contrast : 1.12
  const saturation = Number.isFinite(opt.saturation) ? opt.saturation : 1.28

  if (!dither) {
    for (let i = 0; i < count; i++) {
      const [r, g, b] = enhancePixel(px[i * 4], px[i * 4 + 1], px[i * 4 + 2], contrast, saturation)
      nibbles[i] = PALETTE[nearestPaletteIndex(r, g, b)].nibble
    }
    const data = packNibbles(nibbles)
    return { data, width, height, dataSize: data.length }
  }

  // 误差会累加成负数/超过 255，必须用浮点缓存，不能在 Uint8 上累加（会被截断）。
  // 填充时即应用观感增强，之后的抖动都在增强后的像素上进行。
  const buf = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const [r, g, b] = enhancePixel(px[i * 4], px[i * 4 + 1], px[i * 4 + 2], contrast, saturation)
    buf[i * 3] = r
    buf[i * 3 + 1] = g
    buf[i * 3 + 2] = b
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const r = buf[i * 3]
      const g = buf[i * 3 + 1]
      const b = buf[i * 3 + 2]
      const pi = nearestPaletteIndex(r, g, b)
      nibbles[i] = PALETTE[pi].nibble
      const [pr, pg, pb] = PALETTE[pi].rgb
      const er = r - pr
      const eg = g - pg
      const eb = b - pb
      spreadError(buf, x + 1, y, width, height, er, eg, eb, 7 / 16) // 右
      spreadError(buf, x - 1, y + 1, width, height, er, eg, eb, 3 / 16) // 左下
      spreadError(buf, x, y + 1, width, height, er, eg, eb, 5 / 16) // 下
      spreadError(buf, x + 1, y + 1, width, height, er, eg, eb, 1 / 16) // 右下
    }
  }

  const data = packNibbles(nibbles)
  return { data, width, height, dataSize: data.length }
}

// 整图 CRC32-MPEG2（6.8.1 的 IMG_CRC32）：
//   初值 0xFFFFFFFF，多项式 0x04C11DB7，输入/输出都不反转，最终不异或。与 CRC16 的 Modbus 不是一回事。
function crc32Mpeg2(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc ^ (bytes[i] << 24)) >>> 0
    for (let bit = 0; bit < 8; bit++) {
      if (crc & 0x80000000) {
        crc = ((crc << 1) ^ 0x04c11db7) >>> 0
      } else {
        crc = (crc << 1) >>> 0
      }
    }
  }
  return crc >>> 0
}

module.exports = {
  PALETTE,
  HIGH_NIBBLE_FIRST,
  bytesPerImage,
  packNibbles,
  buildColorBars,
  buildSolid,
  fromImageData,
  crc32Mpeg2
}
