const createPreviewPage = require('./preview-page')
const tapGuard = require('../../../utils/tap-guard')

// 「开始投屏」防重复点击（页面自己的 projecting 锁之外再加一层，2026-11-04）
Page(tapGuard.wrap(createPreviewPage(), { confirmProjection: 'projection' }))
