module.exports = {
  baseURL: 'https://api.boltfox.cn',
  // mock 总开关：默认走真实接口，仅本地联调时手动改 true；正式版(release)无论此值如何都强制走真实请求(见 request.js)
  useMock: false,
  // 普通请求单次超时(毫秒)。网络失败会静默重试(见 request.js)，用户端最长约 30s 才看到超时提示。
  timeout: 10000,
  // 文件上传单次超时(毫秒)：上传体积大且服务端还要转码，给更长时间；上传不做自动重试(避免重复上传)。
  uploadTimeout: 20000
}
