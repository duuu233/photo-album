module.exports = {
  baseURL: 'https://api.example.com', // 后端基础地址（接入真实接口时替换）
  useMock: true, // true 时全部请求走本地 mock（utils/mock.js），无需后端即可联调
  timeout: 12000 // 请求超时时间（毫秒）
}
