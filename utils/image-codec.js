// 图片编解码层：把普通图片/测试图转换成电子相框需要的「六色 4bpp 原始帧缓存」，并提供整图 CRC32。
//
// 为什么需要这一步？
//   墨水屏不认识 JPG/PNG。它的一帧画面是一段「裸数据」：每个像素只用 4 个二进制位（4bpp）表示颜色，
//   也就是只能取 0~15 这 16 个值，本屏实际只用其中 6 个值代表 6 种颜色（黑/白/黄/红/蓝/绿）。
//   两个像素正好拼成 1 个字节（高 4 位 = 左边像素，低 4 位 = 右边像素）。
//   所以一张 680×960 的图，数据量 = 680×960 ÷ 2 = 326400 字节，与文档 6.8.1 的示例一致。
//
// ⚠️ 重要提醒（第一次对接务必确认）：
//   1) 「颜色 → nibble 值」的对应关系（调色板）是固件里写死的 LUT，PRD 文档并没有给出。
//      下面 PALETTE 是按常见六色墨水屏假设的，真机颜色不对时，先找硬件要这张对应表再改这里。
//   2) 两个像素谁放高 4 位（HIGH_NIBBLE_FIRST），不同固件也可能相反。颜色左右镜像/错位时改它。
//   先用「彩条测试图(buildColorBars)」联调最稳：它直接铺 6 个色块，能直观验证收发链路与颜色映射。

// 六色调色板：nibble 值 → RGB。索引（数组下标）即写入帧缓存的 4bit 值。
// 顺序按「黑、白、黄、红、蓝、绿」假设；如与硬件不符，调整顺序或数值即可。
const PALETTE = [
  { nibble: 0x0, rgb: [0, 0, 0], name: '黑' },
  { nibble: 0x1, rgb: [255, 255, 255], name: '白' },
  { nibble: 0x2, rgb: [255, 255, 0], name: '黄' },
  { nibble: 0x3, rgb: [255, 0, 0], name: '红' },
  { nibble: 0x4, rgb: [0, 0, 255], name: '蓝' },
  { nibble: 0x5, rgb: [0, 255, 0], name: '绿' }
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

// 找出与给定 RGB 最接近的调色板颜色，返回它的 nibble 值（欧氏距离最近）
function nearestNibble(r, g, b) {
  let best = PALETTE[0].nibble
  let bestDist = Infinity
  for (let i = 0; i < PALETTE.length; i++) {
    const [pr, pg, pb] = PALETTE[i].rgb
    const dist = (r - pr) * (r - pr) + (g - pg) * (g - pg) + (b - pb) * (b - pb)
    if (dist < bestDist) {
      bestDist = dist
      best = PALETTE[i].nibble
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

// 把 Canvas 的 ImageData（RGBA 像素数组）量化成六色帧缓存。
// 入参 imageData 来自页面把用户选的图片画到目标尺寸 canvas 后 getImageData 的结果。
// 采用「最近颜色」量化（无抖动，简单稳定）；需要更细腻可后续加 Floyd–Steinberg 抖动。
function fromImageData(imageData, width, height) {
  const px = imageData.data // [r,g,b,a, r,g,b,a, ...]
  const count = width * height
  const nibbles = new Uint8Array(count)
  for (let i = 0; i < count; i++) {
    nibbles[i] = nearestNibble(px[i * 4], px[i * 4 + 1], px[i * 4 + 2])
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
